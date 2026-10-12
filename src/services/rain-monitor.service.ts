import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { db } from '../utils/db.js';
import { BASIN_GEOMETRIES } from '../data/basin-geometries.js';
import { SatelliteMapService, SatelliteFrame } from './satellite-map.service.js';
import { VideoCompilerService, CompiledAnimationResult } from './video-compiler.service.js';
import { XService } from './x.service.js';
import { buildStormAlertPostText, buildDailySatelliteSummaryPostText } from '../utils/post-formatter.js';
import { systemLogger } from '../utils/logger.js';

export interface RainEventRecord {
  id: number;
  plant_key: string;
  status: 'ACTIVE' | 'COMPILING' | 'COOLDOWN' | 'CLOSED';
  detected_at: number;
  last_checked_at: number;
  peak_coverage_pct: number;
  last_coverage_pct: number;
  video_compiled_at?: number;
  video_path?: string;
  video_duration_seconds?: number;
  cooldown_until: number;
  published_at?: number;
  tweet_id?: string;
}

export interface RainCheckOptions {
  stormThresholdPct?: number;      // Coverage % to declare a rain storm started (default: 18%)
  dissipationRatio?: number;       // Ratio of peak coverage to declare rain is passing (default: 0.50)
  minRainDurationMinutes?: number; // Minimum elapsed minutes before compiling on dissipation (default: 60 min)
  maxRainDurationMinutes?: number; // Maximum elapsed minutes before forced compile timeout (default: 360 min / 6h)
  cooldownHours?: number;          // Hours to wait before allowing another event for this basin (default: 6h)
  autoCompileVideo?: boolean;      // Whether to compile MP4 video automatically when triggered (default: true)
  autoPublishToX?: boolean;        // Whether to automatically post video to X if XService is available (default: true)
  tileResolution?: number;         // Tile width & height in pixels for analysis (default: 80)
}

export interface RainCheckResult {
  plantKey: string;
  action: 'NO_STORM' | 'STORM_STARTED' | 'STORM_MONITORING' | 'TRIGGER_COMPILATION' | 'VIDEO_COMPILED' | 'IN_COOLDOWN';
  coveragePct: number;
  peakCoveragePct?: number;
  elapsedMinutes?: number;
  event?: RainEventRecord;
  compilationResult?: CompiledAnimationResult;
  publishedTweetId?: string;
  message: string;
}

/**
 * Unfilters standard PNG scanlines according to PNG specification (RFC 2083).
 */
export function unfilterPngScanlines(raw: Buffer, width: number, height: number, bytesPerPixel: number): Buffer {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc(width * height * bytesPerPixel);
  let rawOffset = 0;
  let outOffset = 0;

  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset++];
    for (let x = 0; x < stride; x++) {
      const byte = raw[rawOffset++];
      const a = x >= bytesPerPixel ? out[outOffset - bytesPerPixel + (x % bytesPerPixel)] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bytesPerPixel && y > 0) ? out[(y - 1) * stride + x - bytesPerPixel] : 0;

      let val = byte;
      if (filterType === 1) {
        val = (byte + a) & 0xff;
      } else if (filterType === 2) {
        val = (byte + b) & 0xff;
      } else if (filterType === 3) {
        val = (byte + Math.floor((a + b) / 2)) & 0xff;
      } else if (filterType === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        val = (byte + pr) & 0xff;
      }
      out[outOffset++] = val;
    }
  }
  return out;
}

/**
 * Analyzes a PNG buffer of a GOES-16 IR Band 13 tile and computes the percentage
 * of pixels belonging to deep convective cold cloud tops (rain-producing clouds).
 * Accurately filters out high-altitude non-raining cirrus clouds (cyan/blue) and isolates
 * true convective precipitation cores (green, yellow, red, overshooting white).
 */
export function analyzeStormCloudCoverage(pngBuf: Buffer): number {
  if (!pngBuf || pngBuf.length < 24) return 0;

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let plte: Buffer | null = null;
  const idatChunks: Buffer[] = [];

  while (offset < pngBuf.length) {
    const len = pngBuf.readUInt32BE(offset);
    const type = pngBuf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') {
      width = pngBuf.readUInt32BE(offset + 8);
      height = pngBuf.readUInt32BE(offset + 12);
      colorType = pngBuf.readUInt8(offset + 17);
    } else if (type === 'PLTE') {
      plte = pngBuf.subarray(offset + 8, offset + 8 + len);
    } else if (type === 'IDAT') {
      idatChunks.push(pngBuf.subarray(offset + 8, offset + 8 + len));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }

  if (width === 0 || height === 0 || idatChunks.length === 0) {
    return 0;
  }

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = colorType === 6 ? 4 : (colorType === 3 ? 1 : 3);
  const pixels = unfilterPngScanlines(inflated, width, height, bpp);

  let convectiveCount = 0;
  let severeCount = 0;
  const total = width * height;

  for (let i = 0; i < pixels.length; i += bpp) {
    let r = 0, g = 0, b = 0;
    if (colorType === 3 && plte) {
      const idx = pixels[i];
      const pOff = idx * 3;
      if (pOff + 2 < plte.length) {
        r = plte[pOff];
        g = plte[pOff + 1];
        b = plte[pOff + 2];
      }
    } else {
      r = pixels[i];
      g = pixels[i + 1];
      b = pixels[i + 2];
    }

    // Severe Convective Cores: Yellow (-60°C), Red (-70°C to -85°C), White Core (-90°C)
    const isYellow = (r > 160 && g > 160 && b < 120);
    const isRed = (r > 130 && g < 100 && b < 100);
    const isWhite = (r > 210 && g > 210 && b > 210);
    const isSevere = isYellow || isRed || isWhite;

    // Active Convective Rain: Green (-48°C to -58°C)
    const isGreen = (g > 140 && g > r + 25 && g > b + 25) || (g > 150 && r < 130 && b < 130);

    if (isSevere) {
      severeCount++;
      convectiveCount++;
    } else if (isGreen) {
      convectiveCount++;
    }
  }

  const convPct = (convectiveCount / total) * 100;
  const sevPct = (severeCount / total) * 100;
  // Weighted convective precipitation score (severe cores carry extra weight)
  const effectiveCoverage = convPct + (sevPct * 1.5);
  return parseFloat(effectiveCoverage.toFixed(1));
}

export const DEFAULT_STORM_THRESHOLDS: Record<string, number> = {
  cocaCodoSinclair: 10.0,
  paute: 8.0,
  mazar: 8.0,
  molino: 8.0,
  sopladora: 8.0,
  agoyan: 10.0,
  minasSanFrancisco: 8.0
};

export class RainMonitorService {
  constructor(
    private readonly satelliteService: SatelliteMapService = new SatelliteMapService(),
    private readonly videoCompilerService: VideoCompilerService = new VideoCompilerService(satelliteService),
    private readonly xService?: XService
  ) {}

  /**
   * Retrieves active or cooldown rain event record from SQLite for a given basin.
   */
  public getActiveOrCooldownEvent(plantKey: string): RainEventRecord | null {
    const row = db.prepare(`
      SELECT * FROM rain_events
      WHERE plant_key = ? AND status IN ('ACTIVE', 'COMPILING', 'COOLDOWN')
      ORDER BY id DESC LIMIT 1
    `).get(plantKey) as RainEventRecord | undefined;

    return row || null;
  }

  /**
   * Retrieves recent rain event records from SQLite.
   */
  public getRecentEvents(limit: number = 20): RainEventRecord[] {
    return db.prepare(`
      SELECT * FROM rain_events
      ORDER BY id DESC LIMIT ?
    `).all(limit) as RainEventRecord[];
  }

  /**
   * Measures current storm cloud coverage percentage from GOES-16 satellite for a basin.
   */
  public async getBasinCurrentStormCoverage(
    plantKey: string = 'cocaCodoSinclair',
    tileResolution: number = 80
  ): Promise<{ coveragePct: number; timestampIso: string }> {
    const basin = BASIN_GEOMETRIES[plantKey];
    if (!basin) {
      throw new Error(`[RainMonitor] Basin geometry not found for "${plantKey}"`);
    }

    const timestamps = await this.satelliteService.fetchGoesTimestamps({ limit: 4 });
    let tileBuffer: Buffer | null = null;
    let selectedTimestamp = timestamps[0] || new Date().toISOString();

    for (const ts of timestamps) {
      try {
        tileBuffer = await this.satelliteService.fetchMapTile({
          layers: 'goes:goes_abi_l2_cmipf_13,ecuador:provincias',
          bbox: basin.bbox,
          time: ts,
          width: tileResolution,
          height: tileResolution,
          format: 'image/png'
        });
        selectedTimestamp = ts;
        break;
      } catch (err: any) {
        // If newest timestamp is still being ingested or fails on GeoServer, fallback to previous available
        continue;
      }
    }

    if (!tileBuffer) {
      throw new Error(`[RainMonitor] Unable to fetch valid satellite tile for basin "${plantKey}"`);
    }

    const coveragePct = analyzeStormCloudCoverage(tileBuffer);
    return { coveragePct, timestampIso: selectedTimestamp };
  }

  /**
   * Evaluates the rain state machine for a basin:
   * - Detects new storm onset.
   * - Tracks ongoing event and records peak coverage.
   * - Waits until the storm begins passing or optimal duration (2-3h) is reached.
   * - Compiles animation video when ready and enters cooldown period.
   */
  public async checkBasin(
    plantKey: string = 'cocaCodoSinclair',
    options: RainCheckOptions = {}
  ): Promise<RainCheckResult> {
    const defaultThreshold = DEFAULT_STORM_THRESHOLDS[plantKey] ?? 10.0;
    const stormThreshold = options.stormThresholdPct ?? defaultThreshold;
    const dissipationRatio = options.dissipationRatio ?? 0.50;
    const minRainDurationMinutes = options.minRainDurationMinutes ?? 60;
    const maxRainDurationMinutes = options.maxRainDurationMinutes ?? 360;
    const cooldownHours = options.cooldownHours ?? 6;
    const autoCompileVideo = options.autoCompileVideo ?? true;
    const autoPublishToX = options.autoPublishToX ?? true;
    const tileResolution = options.tileResolution ?? 80;

    const now = Date.now();
    const existingEvent = this.getActiveOrCooldownEvent(plantKey);

    // 1. Check Cooldown
    if (existingEvent && existingEvent.status === 'COOLDOWN') {
      if (now < existingEvent.cooldown_until) {
        const remainingMinutes = Math.round((existingEvent.cooldown_until - now) / 60000);
        return {
          plantKey,
          action: 'IN_COOLDOWN',
          coveragePct: existingEvent.last_coverage_pct,
          peakCoveragePct: existingEvent.peak_coverage_pct,
          event: existingEvent,
          message: `Cuenca en período de enfriamiento. Próxima evaluación en ${remainingMinutes} min.`
        };
      } else {
        // Cooldown has expired, close the event
        db.prepare(`UPDATE rain_events SET status = 'CLOSED' WHERE id = ?`).run(existingEvent.id);
        existingEvent.status = 'CLOSED';
      }
    }

    // 2. Fetch Live Satellite Cloud Coverage
    const { coveragePct, timestampIso } = await this.getBasinCurrentStormCoverage(plantKey, tileResolution);

    // 3. No active event currently running
    if (!existingEvent || existingEvent.status === 'CLOSED') {
      if (coveragePct >= stormThreshold) {
        // Start new rain storm tracking event
        const insertStmt = db.prepare(`
          INSERT INTO rain_events (
            plant_key, status, detected_at, last_checked_at,
            peak_coverage_pct, last_coverage_pct, cooldown_until
          ) VALUES (?, 'ACTIVE', ?, ?, ?, ?, 0)
        `);
        const result = insertStmt.run(plantKey, now, now, coveragePct, coveragePct);
        const eventId = Number(result.lastInsertRowid);

        const newEvent: RainEventRecord = {
          id: eventId,
          plant_key: plantKey,
          status: 'ACTIVE',
          detected_at: now,
          last_checked_at: now,
          peak_coverage_pct: coveragePct,
          last_coverage_pct: coveragePct,
          cooldown_until: 0
        };

        // Pre-seed storm frame cache with recent Ecuador frames
        await this.initStormFrameCache(eventId, timestampIso);

        systemLogger.info(
          `[RainMonitor] 🌧️ Rain event started for ${plantKey} (Coverage: ${coveragePct}%, timestamp: ${timestampIso})`
        );

        return {
          plantKey,
          action: 'STORM_STARTED',
          coveragePct,
          peakCoveragePct: coveragePct,
          elapsedMinutes: 0,
          event: newEvent,
          message: `Lluvia detectada en la cuenca (${coveragePct}% cobertura nubosa fría). Monitoreo iniciado.`
        };
      }

      return {
        plantKey,
        action: 'NO_STORM',
        coveragePct,
        message: `Sin lluvias significativas (${coveragePct}% cobertura, umbral: ${stormThreshold}%).`
      };
    }

    // 4. An ACTIVE storm event is in progress
    const elapsedMinutes = Math.round((now - existingEvent.detected_at) / 60000);
    const newPeak = Math.max(existingEvent.peak_coverage_pct, coveragePct);

    db.prepare(`
      UPDATE rain_events
      SET peak_coverage_pct = ?, last_coverage_pct = ?, last_checked_at = ?
      WHERE id = ?
    `).run(newPeak, coveragePct, now, existingEvent.id);

    existingEvent.peak_coverage_pct = newPeak;
    existingEvent.last_coverage_pct = coveragePct;
    existingEvent.last_checked_at = now;

    // Cache current Ecuador frame for progressive video compilation
    await this.cacheEcuadorFrame(existingEvent.id, timestampIso);

    // Check Trigger Conditions:
    // A) Dissipation / Cloud passed: coverage dropped to dissipationRatio of peak after at least minRainDurationMinutes
    const isPassing = elapsedMinutes >= minRainDurationMinutes && coveragePct <= newPeak * dissipationRatio;
    // B) Timeout: storm has been ongoing for maxRainDurationMinutes (2.5h)
    const isMaxDurationReached = elapsedMinutes >= maxRainDurationMinutes;

    if (!isPassing && !isMaxDurationReached) {
      systemLogger.info(
        `[RainMonitor] Storm ongoing in ${plantKey} (${elapsedMinutes} min elapsed, peak: ${newPeak}%, current: ${coveragePct}%)`
      );
      return {
        plantKey,
        action: 'STORM_MONITORING',
        coveragePct,
        peakCoveragePct: newPeak,
        elapsedMinutes,
        event: existingEvent,
        message: `Tormenta activa (${elapsedMinutes} min acumulados). Pico: ${newPeak}%, Actual: ${coveragePct}%. Esperando maduración/descenso.`
      };
    }

    // Trigger condition reached! Prepare for video compilation
    const reason = isPassing ? 'disipación/salida de la nube' : 'ventana temporal máxima alcanzada (2.5h)';
    systemLogger.info(
      `[RainMonitor] 🎬 Triggering video compilation for ${plantKey} due to: ${reason} (Elapsed: ${elapsedMinutes} min)`
    );

    db.prepare(`UPDATE rain_events SET status = 'COMPILING' WHERE id = ?`).run(existingEvent.id);
    existingEvent.status = 'COMPILING';

    if (!autoCompileVideo) {
      return {
        plantKey,
        action: 'TRIGGER_COMPILATION',
        coveragePct,
        peakCoveragePct: newPeak,
        elapsedMinutes,
        event: existingEvent,
        message: `Lluvia completó su ciclo (${reason}). Listo para compilar video.`
      };
    }

    // Compile MP4 video using VideoCompilerService (Ecuador Continental view)
    const basin = BASIN_GEOMETRIES[plantKey];
    const basinName = basin?.name || plantKey;

    const framesDir = path.join(process.cwd(), 'temp', 'storm_frames', `event_${existingEvent.id}`);
    const cachedFrames = this.loadCachedStormFrames(framesDir);

    let compilationResult: CompiledAnimationResult;
    if (cachedFrames.length >= 4) {
      compilationResult = await this.videoCompilerService.compileFramesToVideo(cachedFrames, {
        plantKey: 'ecuador',
        customTitle: 'Vista Satelital GOES-16 • Ecuador Continental',
        minDurationSeconds: 10,
        framerate: 8,
        createMp4: true,
        createGif: false,
        showAllPins: true,
        showDetectionBoxes: true,
        highlightBasinKey: plantKey,
        activeBasinKeys: [plantKey],
        stormWindow: {
          startTime: existingEvent.detected_at,
          endTime: existingEvent.last_checked_at - 60000 // Last checked was dissipation; storm ended before it
        }
      });
      try {
        fs.rmSync(framesDir, { recursive: true, force: true });
      } catch (err) {}
    } else {
      const hoursBack = Math.min(4, Math.max(2, Math.round(elapsedMinutes / 60) + 1));
      compilationResult = await this.videoCompilerService.generateBasinAnimation({
        plantKey: 'ecuador',
        hoursBack,
        customTitle: 'Vista Satelital GOES-16 • Ecuador Continental',
        minDurationSeconds: 10,
        framerate: 8,
        createMp4: true,
        createGif: false,
        showAllPins: true,
        showDetectionBoxes: true,
        highlightBasinKey: plantKey,
        activeBasinKeys: [plantKey],
        stormWindow: {
          startTime: existingEvent.detected_at,
          endTime: existingEvent.last_checked_at - 60000
        }
      });
    }

    const cooldownUntil = now + cooldownHours * 3600 * 1000;

    db.prepare(`
      UPDATE rain_events
      SET status = 'COOLDOWN',
          video_compiled_at = ?,
          video_path = ?,
          video_duration_seconds = ?,
          cooldown_until = ?
      WHERE id = ?
    `).run(
      now,
      compilationResult.mp4Path,
      compilationResult.durationSeconds,
      cooldownUntil,
      existingEvent.id
    );

    existingEvent.status = 'COOLDOWN';
    existingEvent.video_compiled_at = now;
    existingEvent.video_path = compilationResult.mp4Path;
    existingEvent.video_duration_seconds = compilationResult.durationSeconds;
    existingEvent.cooldown_until = cooldownUntil;

    let publishedTweetId: string | undefined = undefined;
    if (options.autoPublishToX && this.xService && compilationResult.mp4Path) {
      try {
        const postText = buildStormAlertPostText({
          plantKey,
          peakCoveragePct: newPeak,
          durationMinutes: elapsedMinutes,
          dateEcuador: compilationResult.timestamps.endEcuador,
          timeEcuador: compilationResult.timestamps.endEcuador
        });
        const postRes = await this.xService.postVideo(postText, compilationResult.mp4Path);
        publishedTweetId = postRes?.data?.id || postRes?.id;
        systemLogger.info(`[RainMonitor] 🐦 Successfully published storm alert video to X (Tweet ID: ${publishedTweetId})`);

        // Move published video to persistent archive directory (data/published_videos/)
        const archivedPath = this.archivePublishedVideo(compilationResult.mp4Path);
        compilationResult.mp4Path = archivedPath;
        existingEvent.video_path = archivedPath;

        db.prepare(`
          UPDATE rain_events 
          SET published_at = ?, tweet_id = ?, video_path = ? 
          WHERE id = ?
        `).run(Date.now(), publishedTweetId || null, archivedPath, existingEvent.id);

        existingEvent.published_at = Date.now();
        existingEvent.tweet_id = publishedTweetId;
      } catch (pubErr: any) {
        systemLogger.error(`[RainMonitor] Failed to auto-publish storm video to X: ${pubErr?.message || pubErr}`);
      }
    }

    return {
      plantKey,
      action: 'VIDEO_COMPILED',
      coveragePct,
      peakCoveragePct: newPeak,
      elapsedMinutes,
      event: existingEvent,
      compilationResult,
      publishedTweetId,
      message: `Video satelital compilado exitosamente (${compilationResult.durationSeconds}s, ${compilationResult.frameCount} frames). Cuenca en cooldown de ${cooldownHours}h.${publishedTweetId ? ` Publicado en X (ID: ${publishedTweetId})` : ''}`
    };
  }

  /**
   * Manually or programmatically publishes an existing rain event video to X.
   */
  public async publishStormAlert(
    event: RainEventRecord,
    options: { customText?: string; xService?: XService } = {}
  ): Promise<any> {
    const xClient = options.xService || this.xService;
    if (!xClient) {
      throw new Error('[RainMonitor] Cannot publish storm alert: No XService configured.');
    }
    if (!event.video_path || !fs.existsSync(event.video_path)) {
      throw new Error(`[RainMonitor] Cannot publish storm alert: Video not found at path "${event.video_path}"`);
    }

    const elapsedMinutes = Math.round((event.last_checked_at - event.detected_at) / (60 * 1000));
    const message = options.customText || buildStormAlertPostText({
      plantKey: event.plant_key,
      peakCoveragePct: event.peak_coverage_pct,
      durationMinutes: elapsedMinutes > 0 ? elapsedMinutes : undefined
    });

    systemLogger.info(`[RainMonitor] Publishing storm alert to X for event ${event.id} (${event.plant_key})...`);
    const postRes = await xClient.postVideo(message, event.video_path);
    const tweetId = postRes?.data?.id || postRes?.id;

    // Archive published video
    const archivedPath = this.archivePublishedVideo(event.video_path);
    event.video_path = archivedPath;

    db.prepare(`
      UPDATE rain_events 
      SET published_at = ?, tweet_id = ?, video_path = ? 
      WHERE id = ?
    `).run(Date.now(), tweetId || null, archivedPath, event.id);

    event.published_at = Date.now();
    event.tweet_id = tweetId;

    return postRes;
  }

  /**
   * Moves a published video to the persistent archive directory (data/published_videos/).
   * Directory is ignored by git and maintained for debugging and historic records.
   */
  public archivePublishedVideo(sourcePath: string): string {
    const archiveDir = path.join(process.cwd(), 'data', 'published_videos');
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    if (!fs.existsSync(sourcePath)) {
      return sourcePath;
    }

    const fileName = path.basename(sourcePath);
    const targetPath = path.join(archiveDir, fileName);

    if (path.resolve(sourcePath) === path.resolve(targetPath)) {
      return targetPath;
    }

    try {
      fs.renameSync(sourcePath, targetPath);
      systemLogger.info(`[RainMonitor] Video archived to: ${targetPath}`);
      return targetPath;
    } catch (err: any) {
      try {
        fs.copyFileSync(sourcePath, targetPath);
        fs.unlinkSync(sourcePath);
        systemLogger.info(`[RainMonitor] Video copied to archive: ${targetPath}`);
        return targetPath;
      } catch (fallbackErr: any) {
        systemLogger.warn(`[RainMonitor] Failed to archive video from ${sourcePath} to ${targetPath}: ${fallbackErr?.message || fallbackErr}`);
        return sourcePath;
      }
    }
  }

  /**
   * Deletes archived videos older than maxAgeDays (default: 30 days) to keep disk storage lean.
   */
  public cleanupOldPublishedVideos(maxAgeDays: number = 30): number {
    const archiveDir = path.join(process.cwd(), 'data', 'published_videos');
    const generatedDir = path.join(process.cwd(), 'generated');
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let deletedCount = 0;

    const directoriesToClean = [archiveDir, generatedDir];

    for (const dir of directoriesToClean) {
      if (!fs.existsSync(dir)) continue;

      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith('.mp4') && !file.endsWith('.gif')) continue;
          const fullPath = path.join(dir, file);
          try {
            const stats = fs.statSync(fullPath);
            if (now - stats.mtimeMs > maxAgeMs) {
              fs.unlinkSync(fullPath);
              deletedCount++;
              systemLogger.info(`[VideoCleanup] Removed expired video (> ${maxAgeDays} days old): ${fullPath}`);
            }
          } catch (statErr: any) {
            systemLogger.warn(`[VideoCleanup] Error checking/deleting file ${fullPath}: ${statErr?.message || statErr}`);
          }
        }
      } catch (dirErr: any) {
        systemLogger.warn(`[VideoCleanup] Error reading directory ${dir}: ${dirErr?.message || dirErr}`);
      }
    }

    return deletedCount;
  }

  /**
   * Caches an Ecuador Continental frame on disk for an active storm event.
   */
  public async cacheEcuadorFrame(eventId: number, timestampIso: string): Promise<void> {
    const framesDir = path.join(process.cwd(), 'temp', 'storm_frames', `event_${eventId}`);
    if (!fs.existsSync(framesDir)) {
      fs.mkdirSync(framesDir, { recursive: true });
    }

    const safeTs = timestampIso.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(framesDir, `frame_${safeTs}.png`);
    const metaPath = path.join(framesDir, `frame_${safeTs}.json`);

    if (fs.existsSync(filePath) && fs.existsSync(metaPath)) {
      return;
    }

    try {
      const buffer = await this.satelliteService.fetchMapTile({
        layers: 'goes:goes_abi_l2_cmipf_13,ecuador:provincias',
        bbox: BASIN_GEOMETRIES.ecuador.bbox,
        time: timestampIso,
        width: 800,
        height: 800,
        format: 'image/png'
      });

      fs.writeFileSync(filePath, buffer);
      const { dateEcuador, timeEcuador } = this.satelliteService.formatEcuadorTimestamp(timestampIso);
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          timestampIso,
          dateEcuador,
          timeEcuador
        })
      );
    } catch (err: any) {
      systemLogger.warn(`[RainMonitor] Failed to cache frame for ${timestampIso}: ${err?.message || err}`);
    }
  }

  /**
   * Initializes cache for a new storm event by saving pre-storm frames and the current frame.
   */
  public async initStormFrameCache(eventId: number, currentTimestamp: string): Promise<void> {
    try {
      const timestamps = await this.satelliteService.fetchGoesTimestamps({ limit: 4 });
      const chrono = [...timestamps].reverse();
      for (const ts of chrono) {
        await this.cacheEcuadorFrame(eventId, ts);
      }
    } catch (err: any) {
      systemLogger.warn(`[RainMonitor] Failed to pre-seed storm frame cache: ${err?.message || err}`);
    }
  }

  /**
   * Loads cached storm frames from disk in chronological order.
   */
  public loadCachedStormFrames(framesDir: string): SatelliteFrame[] {
    if (!fs.existsSync(framesDir)) return [];
    const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.json')).sort();
    const frames: SatelliteFrame[] = [];

    for (let i = 0; i < files.length; i++) {
      const metaFile = files[i];
      const base = metaFile.replace('.json', '');
      const pngFile = `${base}.png`;
      const fullMetaPath = path.join(framesDir, metaFile);
      const fullPngPath = path.join(framesDir, pngFile);

      if (fs.existsSync(fullPngPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(fullMetaPath, 'utf8'));
          const buffer = fs.readFileSync(fullPngPath);
          frames.push({
            index: i,
            timestampIso: meta.timestampIso,
            dateEcuador: meta.dateEcuador,
            timeEcuador: meta.timeEcuador,
            buffer,
            bbox: BASIN_GEOMETRIES.ecuador.bbox,
            plantKey: 'ecuador',
            source: 'geoserver'
          });
        } catch (err) {}
      }
    }

    return frames;
  }

  /**
   * Decodes PNG IDAT chunks from buffer.
   */
  private decodePng(buf: Buffer): { width: number; height: number; raw: Buffer } {
    let offset = 8;
    let width = 0, height = 0;
    const idatChunks: Buffer[] = [];
    while (offset < buf.length) {
      const len = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      if (type === 'IHDR') {
        width = buf.readUInt32BE(offset + 8);
        height = buf.readUInt32BE(offset + 12);
      } else if (type === 'IDAT') {
        idatChunks.push(buf.subarray(offset + 8, offset + 8 + len));
      } else if (type === 'IEND') break;
      offset += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    return { width, height, raw };
  }

  /**
   * Unfilters PNG RGBA scanlines (RFC 2083).
   */
  private unfilterScanlines(raw: Buffer, width: number, height: number): Buffer {
    const stride = width * 4;
    const out = Buffer.alloc(width * height * 4);
    let rOff = 0, oOff = 0;
    for (let y = 0; y < height; y++) {
      const f = raw[rOff++];
      for (let x = 0; x < stride; x++) {
        const byte = raw[rOff++];
        const a = x >= 4 ? out[oOff - 4 + (x % 4)] : 0;
        const b = y > 0 ? out[(y - 1) * stride + x] : 0;
        const c = (x >= 4 && y > 0) ? out[(y - 1) * stride + x - 4] : 0;
        let val = byte;
        if (f === 1) val = (byte + a) & 0xff;
        else if (f === 2) val = (byte + b) & 0xff;
        else if (f === 3) val = (byte + Math.floor((a + b) / 2)) & 0xff;
        else if (f === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          val = (byte + pr) & 0xff;
        }
        out[oOff++] = val;
      }
    }
    return out;
  }

  /**
   * Measures convective rain cloud coverage inside a basin's geographic bounding box
   * directly from a full Continental Ecuador RGBA image buffer.
   */
  public measureBasinCoverageInEcuadorImage(
    px: Buffer,
    imgWidth: number,
    imgHeight: number,
    ecuadorBbox: [number, number, number, number],
    basinBbox: [number, number, number, number]
  ): number {
    const [minLon, minLat, maxLon, maxLat] = ecuadorBbox;
    const projectX = (lon: number) => Math.max(0, Math.min(imgWidth - 1, Math.round(((lon - minLon) / (maxLon - minLon)) * imgWidth)));
    const projectY = (lat: number) => Math.max(0, Math.min(imgHeight - 1, Math.round(((maxLat - lat) / (maxLat - minLat)) * imgHeight)));

    const x1 = Math.min(projectX(basinBbox[0]), projectX(basinBbox[2]));
    const x2 = Math.max(projectX(basinBbox[0]), projectX(basinBbox[2]));
    const y1 = Math.min(projectY(basinBbox[3]), projectY(basinBbox[1]));
    const y2 = Math.max(projectY(basinBbox[3]), projectY(basinBbox[1]));

    let total = 0;
    let convCount = 0;
    let sevCount = 0;

    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        total++;
        const i = (y * imgWidth + x) * 4;
        const r = px[i];
        const g = px[i + 1];
        const b = px[i + 2];

        const isYellow = (r > 160 && g > 160 && b < 120);
        const isRed = (r > 130 && g < 100 && b < 100);
        const isWhite = (r > 210 && g > 210 && b > 210);
        const isSevere = isYellow || isRed || isWhite;
        const isGreen = (g > 140 && g > r + 25 && g > b + 25) || (g > 150 && r < 130 && b < 130);

        if (isSevere) {
          sevCount++;
          convCount++;
        } else if (isGreen) {
          convCount++;
        }
      }
    }

    if (total === 0) return 0;
    const eff = (convCount / total) * 100 + ((sevCount / total) * 100 * 1.5);
    return parseFloat(eff.toFixed(1));
  }

  /**
   * Formats YYYY-MM-DD date string to formal Spanish text (e.g. "Domingo, 11 de octubre de 2026").
   */
  public formatDateToSpanish(dateStr: string): string {
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(year, month - 1, day, 12, 0, 0);
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const months = [
      'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
    ];
    return `${days[d.getDay()]}, ${day} de ${months[d.getMonth()]} del ${year}`;
  }

  /**
   * Generates a 24-hour daily satellite summary timelapse video of Continental Ecuador.
   * Scans all frames for the given day (default: yesterday), activates basin boxes dynamically
   * when rain is detected in each frame, and optionally publishes to X.
   */
  public async generateDailySummaryVideo(options: {
    dateEcuador?: string;
    autoPublishToX?: boolean;
    framerate?: number;
  } = {}): Promise<{
    compilation: CompiledAnimationResult;
    postText: string;
    publishedTweetId?: string;
    basinSummaries: Array<{ plantKey: string; hasRain: boolean; peakCoveragePct: number; rainFrames: number }>;
  }> {
    let targetDate = options.dateEcuador;
    if (!targetDate) {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      targetDate = yesterday.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
    }

    systemLogger.info(`[RainMonitor] Generating 24h satellite daily summary video for ${targetDate}...`);

    const rows = db.prepare(`
      SELECT file_path, date_ecuador, time_ecuador, timestamp_iso
      FROM satellite_archive
      WHERE date_ecuador = ?
      ORDER BY timestamp_iso ASC
    `).all(targetDate) as Array<{ file_path: string; date_ecuador: string; time_ecuador: string; timestamp_iso: string }>;

    if (!rows || rows.length < 6) {
      throw new Error(`[RainMonitor] Not enough archived satellite frames for date ${targetDate} (found: ${rows?.length || 0})`);
    }

    const targetBasins = ['cocaCodoSinclair', 'paute'];
    const activePerFrame = new Map<number, Set<string>>();
    const basinStats = new Map<string, { maxCoverage: number; rainFrames: number }>();
    for (const bKey of targetBasins) {
      basinStats.set(bKey, { maxCoverage: 0, rainFrames: 0 });
    }

    const ecuadorBbox = BASIN_GEOMETRIES.ecuador.bbox;
    const framesToCompile: SatelliteFrame[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!fs.existsSync(r.file_path)) continue;
      const buffer = fs.readFileSync(r.file_path);

      framesToCompile.push({
        index: i,
        timestampIso: r.timestamp_iso,
        dateEcuador: r.date_ecuador,
        timeEcuador: r.time_ecuador,
        buffer,
        bbox: ecuadorBbox,
        plantKey: 'ecuador',
        source: 'geoserver'
      });

      const activeBasins = new Set<string>();
      try {
        const img = this.decodePng(buffer);
        const px = this.unfilterScanlines(img.raw, img.width, img.height);

        for (const bKey of targetBasins) {
          const threshold = DEFAULT_STORM_THRESHOLDS[bKey] ?? 10.0;
          const cov = this.measureBasinCoverageInEcuadorImage(px, img.width, img.height, ecuadorBbox, BASIN_GEOMETRIES[bKey].bbox);
          const stats = basinStats.get(bKey)!;
          if (cov > stats.maxCoverage) stats.maxCoverage = cov;

          if (cov >= threshold) {
            activeBasins.add(bKey);
            stats.rainFrames++;
          }
        }
      } catch (err) {}

      activePerFrame.set(i, activeBasins);
    }

    const framerate = options.framerate || 8;
    const outputName = `resumen_satelital_24h_${targetDate.replace(/[^0-9]/g, '')}`;
    const dateFormatted = this.formatDateToSpanish(targetDate);

    const compilation = await this.videoCompilerService.compileFramesToVideo(framesToCompile, {
      plantKey: 'ecuador',
      outputName,
      framerate,
      minDurationSeconds: 12,
      customTitle: 'Resumen Satelital 24h • Ecuador Continental',
      customDateSubtitle: dateFormatted,
      showAllPins: true,
      showCityPins: true,
      showDetectionBoxes: true,
      showThermalScale: true,
      createMp4: true,
      createGif: false,
      activeBasinResolver: (frame, idx) => activePerFrame.get(idx) || new Set()
    });
    const basinSummaries = targetBasins.map(bKey => {
      const stats = basinStats.get(bKey)!;
      return {
        plantKey: bKey,
        hasRain: stats.rainFrames > 0,
        peakCoveragePct: stats.maxCoverage,
        rainFrames: stats.rainFrames
      };
    });

    const postText = buildDailySatelliteSummaryPostText({
      dateEcuador: dateFormatted,
      basinSummaries
    });

    let publishedTweetId: string | undefined;
    if (options.autoPublishToX && this.xService && compilation.mp4Path) {
      try {
        const postRes = await this.xService.postVideo(postText, compilation.mp4Path);
        publishedTweetId = postRes?.data?.id || postRes?.id;
        systemLogger.info(`[RainMonitor] 🐦 Successfully published 24h daily summary to X (Tweet ID: ${publishedTweetId})`);

        const archivedPath = this.archivePublishedVideo(compilation.mp4Path);
        compilation.mp4Path = archivedPath;
      } catch (pubErr: any) {
        systemLogger.error(`[RainMonitor] Failed to auto-publish 24h summary video to X: ${pubErr?.message || pubErr}`);
      }
    }

    return {
      compilation,
      postText,
      publishedTweetId,
      basinSummaries
    };
  }
}
