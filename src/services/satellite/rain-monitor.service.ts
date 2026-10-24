import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { db } from '../../utils/db.js';
import {
  BASIN_GEOMETRIES,
  COSTA_SIERRA_DIVIDE,
  SIERRA_AMAZONIA_DIVIDE,
  interpolateDivideLon,
  getBasinRasterMask,
  getBasinPolygon,
  resolveBasinKey
} from '../../data/basin-geometries.js';
import { SatelliteTelemetryService, SatelliteMapService, SatelliteFrame, SatelliteSource } from '../telemetry/satellite-telemetry.service.js';
import { SatelliteArchiverService } from './satellite-archiver.service.js';
import { VideoCompilerService, CompiledAnimationResult } from './video-compiler.service.js';
import { XService } from '../social/x.service.js';
import { FacebookService } from '../social/facebook.service.js';
import { InstagramService } from '../social/instagram.service.js';
import { buildStormAlertPostText, buildDailySatelliteSummaryPostText } from '../../utils/post-formatter.js';
import { systemLogger } from '../../utils/logger.js';

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
  start_frame_iso?: string;
  end_frame_iso?: string;
}

export interface RainCheckOptions {
  stormThresholdPct?: number;      // Coverage % to declare a rain storm started (default: 18%)
  dissipationRatio?: number;       // Ratio of peak coverage to declare rain is passing (default: 0.50)
  minRainDurationMinutes?: number; // Minimum elapsed minutes before compiling on dissipation (default: 60 min)
  maxRainDurationMinutes?: number; // Maximum elapsed minutes before forced compile timeout (default: 360 min / 6h)
  cooldownHours?: number;          // Hours to wait before allowing another event for this basin (default: 6h)
  autoCompileVideo?: boolean;      // Whether to compile MP4 video automatically when triggered (default: true)
  autoPublishToX?: boolean;        // Whether to automatically post video to X if XService is available (default: true)
  autoPublishToSocial?: boolean;   // Whether to automatically post video to Facebook & Instagram (default: follows autoPublishToX)
  tileResolution?: number;         // Tile width & height in pixels for analysis (default: 80)
  source?: 'geoserver' | 'nasa_gibs'; // Satellite imagery source
  watermarkBrand?: 'x' | 'instagram'; // Social brand watermark (default: instagram)
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
 * Evaluates whether an RGB pixel represents convective precipitation cloud tops.
 * Supports dual calibration:
 * - 'nasa_gibs': calibrated for NOAA/NASA GOES-16 ABI Band 13 color table (grayscale rejection, electric green, yellow, red, magenta, white core)
 * - 'geoserver': original INAMHI GeoServer thermal palette calibration
 */
export function isConvectivePixel(
  r: number,
  g: number,
  b: number,
  source?: 'geoserver' | 'nasa_gibs'
): { isSevere: boolean; isConvective: boolean } {
  const effectiveSource = source || (process.env.SATELLITE_SOURCE === 'nasa_gibs' ? 'nasa_gibs' : 'geoserver');
  if (effectiveSource === 'nasa_gibs') {
    // In NASA GIBS: background land, ocean and warm low clouds are pure grayscale: |r-g| <= 18 && |g-b| <= 18
    if (Math.abs(r - g) <= 18 && Math.abs(g - b) <= 18 && Math.abs(r - b) <= 18) {
      return { isSevere: false, isConvective: false };
    }
    // Convective storm tops in NOAA/NASA Band 13 legend (< -40°C):
    const isYellow = (r > 170 && g > 170 && b < 70);
    const isRedOrange = (r > 170 && g < 120 && b < 80);
    const isMagenta = (r > 150 && b > 140 && g < 110);
    const isWhiteCore = (r > 230 && g > 230 && b > 230);
    const isSevere = isYellow || isRedOrange || isMagenta || isWhiteCore;
    const isElectricGreen = (g > 160 && g > r + 45 && g > b + 45);

    return {
      isSevere,
      isConvective: isSevere || isElectricGreen
    };
  }

  // GeoServer original calibration
  const isYellow = (r > 160 && g > 160 && b < 120);
  const isRed = (r > 130 && g < 100 && b < 100);
  const isWhite = (r > 210 && g > 210 && b > 210);
  const isSevere = isYellow || isRed || isWhite;
  const isGreen = (g > 140 && g > r + 25 && g > b + 25) || (g > 150 && r < 130 && b < 130);

  return {
    isSevere,
    isConvective: isSevere || isGreen
  };
}

/**
 * Analyzes a PNG buffer of a GOES-16 IR Band 13 tile and computes the percentage
 * of pixels belonging to deep convective cold cloud tops (rain-producing clouds).
 * Accurately filters out high-altitude non-raining cirrus clouds (cyan/blue) and isolates
 * true convective precipitation cores (green, yellow, red, overshooting white).
 */
export function analyzeStormCloudCoverage(pngBuf: Buffer, source?: 'geoserver' | 'nasa_gibs'): number {
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

    const { isSevere, isConvective } = isConvectivePixel(r, g, b, source);
    if (isSevere) {
      severeCount++;
      convectiveCount++;
    } else if (isConvective) {
      convectiveCount++;
    }
  }

  const convPct = (convectiveCount / total) * 100;
  const sevPct = (severeCount / total) * 100;
  // Weighted convective precipitation score (severe cores carry extra weight)
  const effectiveCoverage = convPct + (sevPct * 1.5);
  return parseFloat(effectiveCoverage.toFixed(1));
}

/**
 * Analyzes cold cloud coverage for a specific basin directly from an Ecuador-wide satellite PNG frame.
 */
export function analyzeBasinCoverageFromEcuadorFrame(
  ecuadorPngBuf: Buffer,
  plantKey: string = 'cocaCodoSinclair',
  source?: 'geoserver' | 'nasa_gibs'
): number {
  const basin = BASIN_GEOMETRIES[plantKey];
  const ecBasin = BASIN_GEOMETRIES.ecuador;
  if (!basin || !ecBasin || !ecuadorPngBuf || ecuadorPngBuf.length < 24) return 0;

  // Read PNG dimensions and chunks
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let plte: Buffer | null = null;
  const idatChunks: Buffer[] = [];

  while (offset < ecuadorPngBuf.length) {
    const len = ecuadorPngBuf.readUInt32BE(offset);
    const type = ecuadorPngBuf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') {
      width = ecuadorPngBuf.readUInt32BE(offset + 8);
      height = ecuadorPngBuf.readUInt32BE(offset + 12);
      colorType = ecuadorPngBuf.readUInt8(offset + 17);
    } else if (type === 'PLTE') {
      plte = ecuadorPngBuf.subarray(offset + 8, offset + 8 + len);
    } else if (type === 'IDAT') {
      idatChunks.push(ecuadorPngBuf.subarray(offset + 8, offset + 8 + len));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }

  if (width === 0 || height === 0 || idatChunks.length === 0) return 0;

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = colorType === 6 ? 4 : (colorType === 3 ? 1 : 3);
  const pixels = unfilterPngScanlines(inflated, width, height, bpp);

  // 1. Evaluate using the exact hydrological basin polygon raster mask
  const rasterMask = getBasinRasterMask(plantKey, width, height, ecBasin.bbox);
  if (rasterMask && rasterMask.totalPixels > 0) {
    let convectiveCount = 0;
    let severeCount = 0;
    const { minX, maxX, minY, maxY, boxW, mask, totalPixels } = rasterMask;

    for (let y = minY; y <= maxY; y++) {
      const rowOffset = (y - minY) * boxW;
      for (let x = minX; x <= maxX; x++) {
        if (mask[rowOffset + (x - minX)] === 0) continue;
        const pIdx = (y * width + x) * bpp;
        let r = 0, g = 0, b = 0;
        if (colorType === 3 && plte) {
          const idx = pixels[pIdx];
          const pOff = idx * 3;
          if (pOff + 2 < plte.length) {
            r = plte[pOff];
            g = plte[pOff + 1];
            b = plte[pOff + 2];
          }
        } else {
          r = pixels[pIdx];
          g = pixels[pIdx + 1];
          b = pixels[pIdx + 2];
        }

        const { isSevere, isConvective } = isConvectivePixel(r, g, b, source);
        if (isSevere) {
          severeCount++;
          convectiveCount++;
        } else if (isConvective) {
          convectiveCount++;
        }
      }
    }

    const convPct = (convectiveCount / totalPixels) * 100;
    const sevPct = (severeCount / totalPixels) * 100;
    const effectiveCoverage = convPct + (sevPct * 1.5);
    return parseFloat(effectiveCoverage.toFixed(1));
  }

  // 2. Fallback to rectangular bounding box if no polygon is configured
  const ecMinLon = ecBasin.bbox[0];
  const ecMinLat = ecBasin.bbox[1];
  const ecMaxLon = ecBasin.bbox[2];
  const ecMaxLat = ecBasin.bbox[3];

  const lonSpan = ecMaxLon - ecMinLon;
  const latSpan = ecMaxLat - ecMinLat;

  const minX = Math.max(0, Math.floor(((basin.bbox[0] - ecMinLon) / lonSpan) * width));
  const maxX = Math.min(width - 1, Math.ceil(((basin.bbox[2] - ecMinLon) / lonSpan) * width));
  const minY = Math.max(0, Math.floor(((ecMaxLat - basin.bbox[3]) / latSpan) * height));
  const maxY = Math.min(height - 1, Math.ceil(((ecMaxLat - basin.bbox[1]) / latSpan) * height));

  let convectiveCount = 0;
  let severeCount = 0;
  let totalBasinPixels = 0;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      totalBasinPixels++;
      const pIdx = (y * width + x) * bpp;
      let r = 0, g = 0, b = 0;
      if (colorType === 3 && plte) {
        const idx = pixels[pIdx];
        const pOff = idx * 3;
        if (pOff + 2 < plte.length) {
          r = plte[pOff];
          g = plte[pOff + 1];
          b = plte[pOff + 2];
        }
      } else {
        r = pixels[pIdx];
        g = pixels[pIdx + 1];
        b = pixels[pIdx + 2];
      }

      const { isSevere, isConvective } = isConvectivePixel(r, g, b, source);
      if (isSevere) {
        severeCount++;
        convectiveCount++;
      } else if (isConvective) {
        convectiveCount++;
      }
    }
  }

  if (totalBasinPixels === 0) return 0;
  const convPct = (convectiveCount / totalBasinPixels) * 100;
  const sevPct = (severeCount / totalBasinPixels) * 100;
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
    private readonly satelliteService: SatelliteTelemetryService = new SatelliteTelemetryService(),
    private readonly videoCompilerService: VideoCompilerService = new VideoCompilerService(satelliteService),
    private readonly xService?: XService,
    private readonly archiverService: SatelliteArchiverService = new SatelliteArchiverService(satelliteService),
    private readonly facebookService?: FacebookService,
    private readonly instagramService?: InstagramService
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
    tileResolution: number = 80,
    source?: 'geoserver' | 'nasa_gibs'
  ): Promise<{ coveragePct: number; timestampIso: string }> {
    const effectiveSource = source || (process.env.SATELLITE_SOURCE === 'nasa_gibs' ? 'nasa_gibs' : 'geoserver');
    const basin = BASIN_GEOMETRIES[plantKey];
    if (!basin) {
      throw new Error(`[RainMonitor] Basin geometry not found for "${plantKey}"`);
    }

    // 1. Try most recent local frame from satellite_archive first
    try {
      const localArchived = db.prepare(`
        SELECT timestamp_iso, file_path, source FROM satellite_archive
        WHERE file_size_bytes > 50000
        ORDER BY timestamp_iso DESC
        LIMIT 1
      `).get() as { timestamp_iso: string; file_path: string; source?: string } | undefined;

      if (localArchived && fs.existsSync(localArchived.file_path)) {
        const frameAgeMs = Date.now() - new Date(localArchived.timestamp_iso).getTime();
        // Only use local archived frame if it is fresh (within 30 minutes)
        if (frameAgeMs <= 30 * 60 * 1000) {
          const fileBuf = fs.readFileSync(localArchived.file_path);
          const frameSource = (localArchived.source as any) || effectiveSource;
          const coveragePct = analyzeBasinCoverageFromEcuadorFrame(fileBuf, plantKey, frameSource);
          return { coveragePct, timestampIso: localArchived.timestamp_iso };
        }
      }
    } catch (archErr) {}

    // 2. Fetch live tile from satelliteService
    const timestamps = await this.satelliteService.fetchGoesTimestamps({ limit: 4, source: effectiveSource });
    let tileBuffer: Buffer | null = null;
    let selectedTimestamp = timestamps[timestamps.length - 1] || new Date().toISOString();

    // Iterate from newest to oldest to assess the freshest real-time satellite scan
    const candidates = [...timestamps].reverse();
    for (const ts of candidates) {
      try {
        tileBuffer = await this.satelliteService.fetchMapTile({
          source: effectiveSource,
          layers: effectiveSource === 'geoserver' ? 'goes:goes_abi_l2_cmipf_13,ecuador:provincias' : 'GOES-East_ABI_Band13_Clean_Infrared',
          bbox: basin.bbox,
          time: ts,
          width: tileResolution,
          height: tileResolution,
          format: 'image/png'
        });
        selectedTimestamp = ts;
        break;
      } catch (err: any) {
        continue;
      }
    }

    if (!tileBuffer) {
      throw new Error(`[RainMonitor] Unable to fetch valid satellite tile for basin "${plantKey}"`);
    }

    const coveragePct = analyzeStormCloudCoverage(tileBuffer, effectiveSource);
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
    const { coveragePct, timestampIso } = await this.getBasinCurrentStormCoverage(plantKey, tileResolution, options.source);

    // Guardrail: check if satellite feed is stale / interrupted
    const effectiveSource = options.source || (process.env.SATELLITE_SOURCE === 'nasa_gibs' ? 'nasa_gibs' : 'geoserver');
    const maxStaleMinutes = effectiveSource === 'nasa_gibs' ? 90 : 45;
    const frameAgeMinutes = Math.round((now - new Date(timestampIso).getTime()) / 60000);
    if (frameAgeMinutes > maxStaleMinutes) {
      if (existingEvent && (existingEvent.status === 'ACTIVE' || existingEvent.status === 'COMPILING')) {
        systemLogger.warn(
          `[RainMonitor] Satellite feed stalled for ${plantKey} (Latest frame is ${frameAgeMinutes} min old, max allowed is ${maxStaleMinutes} min). Aborting stale storm event #${existingEvent.id} to prevent false compilation.`
        );
        db.prepare(`UPDATE rain_events SET status = 'CLOSED' WHERE id = ?`).run(existingEvent.id);
        existingEvent.status = 'CLOSED';
      } else {
        systemLogger.warn(
          `[RainMonitor] Satellite feed stalled for ${plantKey} (${frameAgeMinutes} min old, max allowed is ${maxStaleMinutes} min). Skipping storm detection to prevent false onset.`
        );
      }
      return {
        plantKey,
        action: 'NO_STORM',
        coveragePct: 0,
        message: `Flujo satelital estancado (${frameAgeMinutes} min sin nuevos fotogramas). Monitoreo en pausa por seguridad.`
      };
    }

    // Guardrail: Inactivity heartbeat check - if bot was paused/offline and no check occurred in > 35 minutes, close stale event
    if (existingEvent && (existingEvent.status === 'ACTIVE' || existingEvent.status === 'COMPILING')) {
      const timeSinceLastCheckMinutes = (now - existingEvent.last_checked_at) / 60000;
      if (timeSinceLastCheckMinutes > 35) {
        systemLogger.warn(
          `[RainMonitor] Monitor inactivity gap detected for ${plantKey} (${Math.round(timeSinceLastCheckMinutes)} min since last check). Discarding stale event #${existingEvent.id} without publishing.`
        );
        db.prepare(`UPDATE rain_events SET status = 'CLOSED' WHERE id = ?`).run(existingEvent.id);
        existingEvent.status = 'CLOSED';
      }
    }

    // 3. An event in COMPILING status is awaiting post-storm calm frames
    if (existingEvent && existingEvent.status === 'COMPILING') {
      const stormThreshold = options.stormThresholdPct ?? (DEFAULT_STORM_THRESHOLDS[plantKey] ?? 10.0);

      // Check if rain reignited/intensified again before post-frames arrived
      if (coveragePct >= stormThreshold) {
        systemLogger.info(
          `[RainMonitor] ⛈️ Storm in ${plantKey} reignited while awaiting post-frames (Coverage: ${coveragePct}% >= ${stormThreshold}%). Resuming ACTIVE monitoring.`
        );
        const resumedPeak = Math.max(existingEvent.peak_coverage_pct, coveragePct);
        db.prepare(`
          UPDATE rain_events
          SET status = 'ACTIVE',
              end_frame_iso = NULL,
              last_coverage_pct = ?,
              last_checked_at = ?,
              peak_coverage_pct = ?
          WHERE id = ?
        `).run(coveragePct, now, resumedPeak, existingEvent.id);

        existingEvent.status = 'ACTIVE';
        existingEvent.end_frame_iso = undefined;
        existingEvent.last_coverage_pct = coveragePct;
        existingEvent.last_checked_at = now;
        existingEvent.peak_coverage_pct = resumedPeak;

        return {
          plantKey,
          action: 'STORM_MONITORING',
          coveragePct,
          peakCoveragePct: resumedPeak,
          elapsedMinutes: Math.round((now - existingEvent.detected_at) / 60000),
          event: existingEvent,
          message: `Tormenta reactivada (${coveragePct}% cobertura). Continuando monitoreo activo.`
        };
      }

      const dissipationIso = existingEvent.end_frame_iso || timestampIso;
      const targetPostFrames = 3;

      // Count post-storm frames archived strictly after dissipationIso
      const postStormFrames = db.prepare(`
        SELECT COUNT(DISTINCT timestamp_iso) as count
        FROM satellite_archive
        WHERE plant_key = 'ecuador'
          AND timestamp_iso > ?
          AND file_size_bytes > 20000
      `).get(dissipationIso) as { count: number } | undefined;

      const postCount = postStormFrames?.count || 0;
      const dissipationEpoch = new Date(dissipationIso).getTime();
      const minutesSinceDissipation = (now - dissipationEpoch) / 60000;
      const maxWaitTimeoutMinutes = 55; // Safety fallback timeout (55 min since dissipation frame)

      if (postCount < targetPostFrames && minutesSinceDissipation < maxWaitTimeoutMinutes) {
        db.prepare(`UPDATE rain_events SET last_checked_at = ? WHERE id = ?`).run(now, existingEvent.id);
        existingEvent.last_checked_at = now;

        systemLogger.info(
          `[RainMonitor] Rain event #${existingEvent.id} in ${plantKey} is waiting for post-storm calm frames (${postCount}/${targetPostFrames} archived, ${Math.round(minutesSinceDissipation)} min since dissipation frame)...`
        );
        return {
          plantKey,
          action: 'STORM_MONITORING',
          coveragePct: existingEvent.last_coverage_pct,
          peakCoveragePct: existingEvent.peak_coverage_pct,
          elapsedMinutes: Math.round((now - existingEvent.detected_at) / 60000),
          event: existingEvent,
          message: `Tormenta finalizada. Esperando fotogramas satelitales de calma post-tormenta (${postCount}/${targetPostFrames} disponibles)...`
        };
      }

      // Target post-storm frames reached (or timeout reached): proceed to compilation
      return await this.compileAndPublishRainEvent(existingEvent, options, 'disipación confirmada con fotogramas posteriores');
    }

    // 4. No active event currently running
    if (!existingEvent || existingEvent.status === 'CLOSED') {
      if (coveragePct >= stormThreshold) {
        // Start new rain storm tracking event
        const insertStmt = db.prepare(`
          INSERT INTO rain_events (
            plant_key, status, detected_at, last_checked_at,
            peak_coverage_pct, last_coverage_pct, cooldown_until,
            start_frame_iso
          ) VALUES (?, 'ACTIVE', ?, ?, ?, ?, 0, ?)
        `);
        const result = insertStmt.run(plantKey, now, now, coveragePct, coveragePct, timestampIso);
        const eventId = Number(result.lastInsertRowid);

        const newEvent: RainEventRecord = {
          id: eventId,
          plant_key: plantKey,
          status: 'ACTIVE',
          detected_at: now,
          last_checked_at: now,
          peak_coverage_pct: coveragePct,
          last_coverage_pct: coveragePct,
          cooldown_until: 0,
          start_frame_iso: timestampIso
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

    // 5. An ACTIVE storm event is in progress
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

    // Trigger condition reached!
    const reason = isPassing ? 'disipación/salida de la nube' : 'ventana temporal máxima alcanzada (2.5h)';
    systemLogger.info(
      `[RainMonitor] 🎬 Rain event completed active phase for ${plantKey} due to: ${reason} (Elapsed: ${elapsedMinutes} min)`
    );

    const endFrameIso = timestampIso;
    db.prepare(`
      UPDATE rain_events
      SET status = 'COMPILING',
          peak_coverage_pct = ?,
          last_coverage_pct = ?,
          last_checked_at = ?,
          end_frame_iso = ?
      WHERE id = ?
    `).run(newPeak, coveragePct, now, endFrameIso, existingEvent.id);

    existingEvent.status = 'COMPILING';
    existingEvent.peak_coverage_pct = newPeak;
    existingEvent.last_coverage_pct = coveragePct;
    existingEvent.last_checked_at = now;
    existingEvent.end_frame_iso = endFrameIso;

    // Check how many post-storm frames are already in satellite_archive
    const postStormFrames = db.prepare(`
      SELECT COUNT(DISTINCT timestamp_iso) as count
      FROM satellite_archive
      WHERE plant_key = 'ecuador'
        AND timestamp_iso > ?
        AND file_size_bytes > 20000
    `).get(endFrameIso) as { count: number } | undefined;

    const postCount = postStormFrames?.count || 0;
    const targetPostFrames = 3;

    // Check if local archive is active for this event (has continuous frames from pre-storm context)
    const startEpoch = existingEvent.start_frame_iso
      ? new Date(existingEvent.start_frame_iso).getTime()
      : existingEvent.detected_at;
    const preStormIso = new Date(startEpoch - 45 * 60000).toISOString();
    const totalArchived = (db.prepare(`
      SELECT COUNT(*) as count FROM satellite_archive
      WHERE plant_key = 'ecuador' AND timestamp_iso >= ? AND file_size_bytes > 20000
    `).get(preStormIso) as { count: number })?.count || 0;

    // In a live system with satellite frames arriving, wait for the 3 post-storm calm frames
    if (totalArchived >= 4 && postCount < targetPostFrames) {
      systemLogger.info(
        `[RainMonitor] Rain event #${existingEvent.id} in ${plantKey} marked as COMPILING. Waiting for ${targetPostFrames - postCount} post-storm calm frame(s) to arrive before compiling...`
      );
      return {
        plantKey,
        action: 'STORM_MONITORING',
        coveragePct,
        peakCoveragePct: newPeak,
        elapsedMinutes,
        event: existingEvent,
        message: `Tormenta completó su ciclo de lluvia (${reason}). Esperando fotogramas posteriores de calma (${postCount}/${targetPostFrames} disponibles)...`
      };
    }

    return await this.compileAndPublishRainEvent(existingEvent, options, reason);
  }

  /**
   * Compiles and publishes the animation video for a completed rain event.
   */
  private async compileAndPublishRainEvent(
    existingEvent: RainEventRecord,
    options: RainCheckOptions,
    reason: string
  ): Promise<RainCheckResult> {
    const autoCompileVideo = options.autoCompileVideo ?? true;
    const cooldownHours = options.cooldownHours ?? 6;
    const plantKey = existingEvent.plant_key;
    const now = Date.now();
    const elapsedMinutes = Math.round((now - existingEvent.detected_at) / 60000);

    if (!autoCompileVideo) {
      return {
        plantKey,
        action: 'TRIGGER_COMPILATION',
        coveragePct: existingEvent.last_coverage_pct,
        peakCoveragePct: existingEvent.peak_coverage_pct,
        elapsedMinutes,
        event: existingEvent,
        message: `Lluvia completó su ciclo (${reason}). Listo para compilar video.`
      };
    }

    // Compile MP4 video using VideoCompilerService (Ecuador Continental view)
    const basin = BASIN_GEOMETRIES[plantKey];
    const basinName = basin?.name || plantKey;

    const startIso = existingEvent.start_frame_iso || new Date(existingEvent.detected_at).toISOString();
    const endIso = existingEvent.end_frame_iso || new Date(existingEvent.last_checked_at).toISOString();
    const startEpoch = new Date(startIso).getTime();
    const endEpoch = new Date(endIso).getTime();

    // 1. Primary source: Load archived frames from SQLite satellite_archive (45 min prior, 45 min / 3+ frames post)
    let framesToCompile = this.loadArchivedStormFrames(
      startEpoch,
      endEpoch,
      45,
      45
    );

    // 2. Legacy fallback: check if frames were cached in legacy temp folder
    const legacyFramesDir = path.join(process.cwd(), 'temp', 'storm_frames', `event_${existingEvent.id}`);
    if (framesToCompile.length < 4 && fs.existsSync(legacyFramesDir)) {
      const legacyFrames = this.loadCachedStormFrames(legacyFramesDir);
      if (legacyFrames.length >= 4) {
        framesToCompile = legacyFrames;
      }
    }

    // 3. Strict Frame Continuity Validation:
    // Avoid corrupted/spliced storm videos with huge gaps across hours/days or sparse frame density.
    let isDiscontinuous = false;
    let discontinuityReason = '';

    if (framesToCompile.length >= 2) {
      for (let i = 1; i < framesToCompile.length; i++) {
        const prevT = new Date(framesToCompile[i - 1].timestampIso).getTime();
        const currT = new Date(framesToCompile[i].timestampIso).getTime();
        const gapMin = (currT - prevT) / (60 * 1000);
        if (gapMin > 45) {
          isDiscontinuous = true;
          discontinuityReason = `Salto temporal excesivo (${Math.round(gapMin)} min entre fotogramas)`;
          break;
        }
      }

      if (!isDiscontinuous && framesToCompile.length >= 4) {
        const firstT = new Date(framesToCompile[0].timestampIso).getTime();
        const lastT = new Date(framesToCompile[framesToCompile.length - 1].timestampIso).getTime();
        const totalSpanMin = (lastT - firstT) / (60 * 1000);
        const avgIntervalMin = totalSpanMin / (framesToCompile.length - 1);
        if (avgIntervalMin > 25) {
          isDiscontinuous = true;
          discontinuityReason = `Densidad de fotogramas insuficiente (${framesToCompile.length} fotogramas en ${Math.round(totalSpanMin)} min, promedio ${Math.round(avgIntervalMin)} min/fotograma)`;
        }
      }
    }

    if (isDiscontinuous) {
      systemLogger.warn(
        `[RainMonitor] Rain event #${existingEvent.id} for ${plantKey} rejected due to temporal discontinuity: ${discontinuityReason}. Discarding event without compiling or publishing.`
      );
      db.prepare(`UPDATE rain_events SET status = 'CLOSED' WHERE id = ?`).run(existingEvent.id);
      existingEvent.status = 'CLOSED';
      return {
        plantKey,
        action: 'NO_STORM',
        coveragePct: 0,
        message: `Evento descartado por discontinuidad temporal (${discontinuityReason}).`
      };
    }

    // Exact Storm Window:
    // Provide a 5-minute margin around startEpoch and endEpoch so:
    // 1) The triggering start frame is guaranteed 100% in red (never dropped by subsecond server clock offset).
    // 2) The final dissipation frame is guaranteed 100% in red.
    // 3) All post-storm frames (> endEpoch + 5m) automatically display in calm cyan.
    // 4) Arbitrary endFrameIndex cutoff is completely eliminated.
    const stormWindow = {
      startTime: startEpoch - (5 * 60 * 1000),
      endTime: endEpoch + (5 * 60 * 1000)
    };

    let compilationResult: CompiledAnimationResult;
    if (framesToCompile.length >= 4) {
      compilationResult = await this.videoCompilerService.compileFramesToVideo(framesToCompile, {
        plantKey: 'ecuador',
        customTitle: 'Vista Satelital GOES-16 • Ecuador Continental',
        watermarkBrand: options.watermarkBrand || 'instagram',
        minDurationSeconds: 10,
        framerate: 8,
        createMp4: true,
        createGif: false,
        showAllPins: true,
        showDetectionBoxes: true,
        showProvinces: true,
        highlightBasinKey: plantKey,
        activeBasinKeys: [plantKey],
        stormWindow
      });
    } else {
      // Fallback: fetch historical window frames via generateBasinAnimation
      const stormMinutes = Math.max(1, Math.round((endEpoch - startEpoch) / 60000));
      const hoursBack = Math.min(4, Math.max(2, Math.round(stormMinutes / 60) + 1));
      compilationResult = await this.videoCompilerService.generateBasinAnimation({
        plantKey: 'ecuador',
        hoursBack,
        customTitle: 'Vista Satelital GOES-16 • Ecuador Continental',
        watermarkBrand: options.watermarkBrand || 'instagram',
        minDurationSeconds: 10,
        framerate: 8,
        createMp4: true,
        createGif: false,
        showAllPins: true,
        showDetectionBoxes: true,
        showProvinces: true,
        highlightBasinKey: plantKey,
        activeBasinKeys: [plantKey],
        stormWindow
      });
    }

    if (!compilationResult || compilationResult.frameCount < 4) {
      systemLogger.warn(
        `[RainMonitor] Insufficient continuous frames for rain event in ${plantKey} (${compilationResult?.frameCount || 0} frames found). Discarding event #${existingEvent.id} to avoid broken/corrupt video.`
      );
      db.prepare(`UPDATE rain_events SET status = 'CLOSED' WHERE id = ?`).run(existingEvent.id);
      existingEvent.status = 'CLOSED';
      return {
        plantKey,
        action: 'NO_STORM',
        coveragePct: 0,
        message: `Evento descartado por fotogramas insuficientes (${compilationResult?.frameCount || 0} fotogramas).`
      };
    }

    // Clean up any legacy temp directory for this event
    try {
      if (fs.existsSync(legacyFramesDir)) {
        fs.rmSync(legacyFramesDir, { recursive: true, force: true });
      }
    } catch (err) {}

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
    let archivedPath: string | undefined = undefined;

    if (compilationResult.mp4Path) {
      archivedPath = this.archivePublishedVideo(compilationResult.mp4Path);
      compilationResult.mp4Path = archivedPath;
      existingEvent.video_path = archivedPath;

      const startDate = compilationResult.timestamps?.startDateEcuador || compilationResult.timestamps?.startEcuador?.split(' ')[0];
      const startTime = compilationResult.timestamps?.startTimeEcuador || compilationResult.timestamps?.startEcuador?.split(' ')[1];
      const endDate = compilationResult.timestamps?.endDateEcuador || compilationResult.timestamps?.endEcuador?.split(' ')[0];
      const endTime = compilationResult.timestamps?.endTimeEcuador || compilationResult.timestamps?.endEcuador?.split(' ')[1];

      // Observed meteorological rain event duration (from start frame to end frame)
      const stormDurationMinutes = Math.max(1, Math.round((endEpoch - startEpoch) / (60 * 1000)));

      const postText = buildStormAlertPostText({
        plantKey,
        peakCoveragePct: existingEvent.peak_coverage_pct,
        durationMinutes: stormDurationMinutes,
        dateEcuador: endDate || startDate,
        startTimeEcuador: startTime,
        endTimeEcuador: endTime,
        timeEcuador: endTime
      });

      // 1. Publish to X (Twitter)
      const shouldPublishX = options.autoPublishToX !== false;
      if (shouldPublishX && this.xService) {
        try {
          const postRes = await this.xService.postVideo(postText, archivedPath);
          publishedTweetId = postRes?.data?.id || postRes?.id;
          systemLogger.info(`[RainMonitor] 🐦 Successfully published rain alert video to X (Tweet ID: ${publishedTweetId})`);
        } catch (pubErr: any) {
          systemLogger.error(`[RainMonitor] Failed to auto-publish rain video to X: ${pubErr?.message || pubErr}`);
        }
      }

      // 2. Publish to Facebook Video & Instagram Reel (Decoupled from X)
      const autoPublishSocial = options.autoPublishToSocial !== undefined ? options.autoPublishToSocial : shouldPublishX;
      if (autoPublishSocial) {
        if (this.facebookService) {
          try {
            const fbTitle = basinName.toLowerCase().startsWith('complejo')
              ? `Evento de Lluvia • ${basinName}`
              : `Evento de Lluvia • ${basinName.startsWith('cuenca') ? basinName : `cuenca hídrica de ${basinName}`}`;

            await this.facebookService.postVideo(archivedPath, {
              title: fbTitle,
              description: postText
            });
            systemLogger.info(`[RainMonitor] 📘 Successfully published rain alert video to Facebook`);
          } catch (fbErr: any) {
            systemLogger.error(`[RainMonitor] Failed to auto-publish rain video to Facebook: ${fbErr?.message || fbErr}`);
          }
        }

        if (this.instagramService) {
          try {
            await this.instagramService.postReel(archivedPath, {
              caption: postText
            });
            systemLogger.info(`[RainMonitor] 📸 Successfully published rain alert Reel to Instagram`);
          } catch (igErr: any) {
            systemLogger.error(`[RainMonitor] Failed to auto-publish rain Reel to Instagram: ${igErr?.message || igErr}`);
          }
        }
      }

      db.prepare(`
        UPDATE rain_events 
        SET published_at = ?, tweet_id = ?, video_path = ? 
        WHERE id = ?
      `).run(Date.now(), publishedTweetId || null, archivedPath, existingEvent.id);

      existingEvent.published_at = Date.now();
      existingEvent.tweet_id = publishedTweetId;
    }

    return {
      plantKey,
      action: 'VIDEO_COMPILED',
      coveragePct: existingEvent.last_coverage_pct,
      peakCoveragePct: existingEvent.peak_coverage_pct,
      elapsedMinutes: Math.round((endEpoch - startEpoch) / (60 * 1000)),
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
    const lastCheckDate = new Date(event.last_checked_at - 5 * 3600 * 1000);
    const dateEcuador = lastCheckDate.toISOString().slice(0, 10);
    const timeEcuador = lastCheckDate.toISOString().slice(11, 16);
    const message = options.customText || buildStormAlertPostText({
      plantKey: event.plant_key,
      peakCoveragePct: event.peak_coverage_pct,
      durationMinutes: elapsedMinutes > 0 ? elapsedMinutes : undefined,
      dateEcuador,
      timeEcuador
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
   * Archives an Ecuador Continental frame in satellite_archive for an active storm event.
   */
  public async cacheEcuadorFrame(eventId: number, timestampIso: string): Promise<void> {
    try {
      await this.archiverService.archiveSingleFrame(timestampIso, 'ecuador', 'geoserver', { minSizeBytes: 20000 });
    } catch (err: any) {
      systemLogger.warn(`[RainMonitor] Failed to archive frame for ${timestampIso}: ${err?.message || err}`);
    }
  }

  /**
   * Initializes cache for a new storm event by ensuring pre-storm frames and the current frame
   * are archived in satellite_archive.
   */
  public async initStormFrameCache(eventId: number, currentTimestamp: string): Promise<void> {
    try {
      const timestamps = await this.satelliteService.fetchGoesTimestamps({ limit: 6 });
      // timestamps is already sorted oldest to newest (chronological order)
      for (const ts of timestamps) {
        await this.cacheEcuadorFrame(eventId, ts);
      }
    } catch (err: any) {
      systemLogger.warn(`[RainMonitor] Failed to pre-seed storm frame archive: ${err?.message || err}`);
    }
  }

  /**
   * Loads archived storm frames from SQLite satellite_archive for a given storm event window.
   * Includes ~45 minutes of pre-storm context before detection and ~35 minutes (3 frames) of post-storm context.
   * Filters out any corrupted or miniature frames (< 20 KB).
   */
  public loadArchivedStormFrames(
    detectedAt: number,
    endedAt: number,
    preStormMinutes: number = 45,
    postStormMinutes: number = 35
  ): SatelliteFrame[] {
    const preStormMs = preStormMinutes * 60 * 1000;
    const postStormMs = postStormMinutes * 60 * 1000;
    const startIso = new Date(detectedAt - preStormMs).toISOString();
    const endIso = new Date(endedAt + postStormMs).toISOString();

    let rows = db.prepare(`
      SELECT file_path, date_ecuador, time_ecuador, timestamp_iso, file_size_bytes, source
      FROM satellite_archive
      WHERE plant_key = 'ecuador'
        AND source = 'geoserver'
        AND timestamp_iso >= ? AND timestamp_iso <= ?
      ORDER BY timestamp_iso ASC
    `).all(startIso, endIso) as Array<{
      file_path: string;
      date_ecuador: string;
      time_ecuador: string;
      timestamp_iso: string;
      file_size_bytes: number;
      source: string;
    }>;

    if (!rows || rows.length < 4) {
      rows = db.prepare(`
        SELECT file_path, date_ecuador, time_ecuador, timestamp_iso, file_size_bytes, source
        FROM satellite_archive
        WHERE plant_key = 'ecuador'
          AND timestamp_iso >= ? AND timestamp_iso <= ?
        ORDER BY timestamp_iso ASC
      `).all(startIso, endIso) as Array<{
        file_path: string;
        date_ecuador: string;
        time_ecuador: string;
        timestamp_iso: string;
        file_size_bytes: number;
        source: string;
      }>;
    }

    if (!rows || rows.length === 0) return [];

    const ecuadorBbox = BASIN_GEOMETRIES.ecuador.bbox;
    const frames: SatelliteFrame[] = [];
    const seenTs = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (seenTs.has(r.timestamp_iso)) continue;
      seenTs.add(r.timestamp_iso);

      if (r.file_size_bytes < 20000) {
        systemLogger.warn(
          `[RainMonitor] Skipping archived frame ${r.timestamp_iso}: file_size_bytes too small (${r.file_size_bytes} B < 20 KB)`
        );
        continue;
      }

      if (!fs.existsSync(r.file_path)) {
        continue;
      }

      try {
        const buffer = fs.readFileSync(r.file_path);
        if (buffer.length < 20000) {
          systemLogger.warn(
            `[RainMonitor] Skipping frame ${r.timestamp_iso}: buffer size on disk too small (${buffer.length} B < 20 KB)`
          );
          continue;
        }

        frames.push({
          index: frames.length,
          timestampIso: r.timestamp_iso,
          dateEcuador: r.date_ecuador,
          timeEcuador: r.time_ecuador,
          buffer,
          bbox: ecuadorBbox,
          plantKey: 'ecuador',
          source: (r.source as SatelliteSource) || 'geoserver'
        });
      } catch (err: any) {
        systemLogger.warn(`[RainMonitor] Failed reading archived frame ${r.file_path}: ${err?.message || err}`);
      }
    }

    // Continuity validation: verify no temporal gap larger than 35 minutes exists
    if (frames.length >= 2) {
      for (let k = 1; k < frames.length; k++) {
        const prevMs = new Date(frames[k - 1].timestampIso).getTime();
        const currMs = new Date(frames[k].timestampIso).getTime();
        const diffMin = (currMs - prevMs) / 60000;
        if (diffMin > 35) {
          systemLogger.warn(
            `[RainMonitor] Temporal continuity gap of ${Math.round(diffMin)} min between ${frames[k - 1].timestampIso} and ${frames[k].timestampIso}. Aborting storm frame sequence.`
          );
          return [];
        }
      }
    }

    return frames;
  }

  /**
   * Loads cached storm frames from disk in chronological order (legacy fallback).
   * Validates frame buffers to ensure integrity (> 20 KB).
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
          const stat = fs.statSync(fullPngPath);
          if (stat.size < 20000) {
            systemLogger.warn(
              `[RainMonitor] Skipping legacy cached frame ${fullPngPath}: file size too small (${stat.size} B < 20 KB)`
            );
            continue;
          }
          const meta = JSON.parse(fs.readFileSync(fullMetaPath, 'utf8'));
          const buffer = fs.readFileSync(fullPngPath);
          if (buffer.length < 20000) {
            continue;
          }
          frames.push({
            index: frames.length,
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
   * Computes comprehensive convective rain coverage metrics for an Ecuador frame buffer:
   * cuencas (CCS, Paute) and regiones (Costa, Sierra, Amazonía).
   */
  public computeEcuadorFrameMetrics(buffer: Buffer, source?: 'geoserver' | 'nasa_gibs'): {
    ccs: number;
    paute: number;
    costa: number;
    sierra: number;
    amazonia: number;
  } {
    const effectiveSource = source || (process.env.SATELLITE_SOURCE === 'nasa_gibs' ? 'nasa_gibs' : 'geoserver');
    try {
      const img = this.decodePng(buffer);
      const px = this.unfilterScanlines(img.raw, img.width, img.height);
      const ecuadorBbox = BASIN_GEOMETRIES.ecuador.bbox;
      const ccs = this.measureBasinCoverageInEcuadorImage(px, img.width, img.height, ecuadorBbox, BASIN_GEOMETRIES.cocaCodoSinclair.bbox, effectiveSource, 'cocaCodoSinclair');
      const paute = this.measureBasinCoverageInEcuadorImage(px, img.width, img.height, ecuadorBbox, BASIN_GEOMETRIES.paute.bbox, effectiveSource, 'paute');
      const regions = this.measureRegionalCoveragesInEcuadorImage(px, img.width, img.height, ecuadorBbox, effectiveSource);
      return { ccs, paute, ...regions };
    } catch (err) {
      return { ccs: 0, paute: 0, costa: 0, sierra: 0, amazonia: 0 };
    }
  }

  /**
   * Measures convective rain cloud coverage inside a basin's geographic bounding box or real polygon
   * directly from a full Continental Ecuador RGBA image buffer.
   */
  public measureBasinCoverageInEcuadorImage(
    px: Buffer | Uint8Array,
    imgWidth: number,
    imgHeight: number,
    ecuadorBbox: [number, number, number, number],
    basinBbox: [number, number, number, number],
    source?: 'geoserver' | 'nasa_gibs',
    plantKey?: string
  ): number {
    const effectiveSource = source || (process.env.SATELLITE_SOURCE === 'nasa_gibs' ? 'nasa_gibs' : 'geoserver');

    // Auto-detect plantKey if not explicitly provided
    let effectivePlantKey = plantKey;
    if (!effectivePlantKey) {
      for (const [key, geom] of Object.entries(BASIN_GEOMETRIES)) {
        if (
          Math.abs(geom.bbox[0] - basinBbox[0]) < 0.01 &&
          Math.abs(geom.bbox[1] - basinBbox[1]) < 0.01 &&
          Math.abs(geom.bbox[2] - basinBbox[2]) < 0.01 &&
          Math.abs(geom.bbox[3] - basinBbox[3]) < 0.01
        ) {
          effectivePlantKey = key;
          break;
        }
      }
    }

    if (effectivePlantKey) {
      const rasterMask = getBasinRasterMask(effectivePlantKey, imgWidth, imgHeight, ecuadorBbox);
      if (rasterMask && rasterMask.totalPixels > 0) {
        let convCount = 0;
        let sevCount = 0;
        const { minX, maxX, minY, maxY, boxW, mask, totalPixels } = rasterMask;

        for (let y = minY; y <= maxY; y++) {
          const rowOffset = (y - minY) * boxW;
          for (let x = minX; x <= maxX; x++) {
            if (mask[rowOffset + (x - minX)] === 0) continue;
            const i = (y * imgWidth + x) * 4;
            const r = px[i];
            const g = px[i + 1];
            const b = px[i + 2];

            const { isSevere, isConvective } = isConvectivePixel(r, g, b, effectiveSource);
            if (isSevere) {
              sevCount++;
              convCount++;
            } else if (isConvective) {
              convCount++;
            }
          }
        }

        const eff = (convCount / totalPixels) * 100 + ((sevCount / totalPixels) * 100 * 1.5);
        return parseFloat(eff.toFixed(1));
      }
    }

    // Fallback to bounding box if no polygon is available
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

        const { isSevere, isConvective } = isConvectivePixel(r, g, b, effectiveSource);
        if (isSevere) {
          sevCount++;
          convCount++;
        } else if (isConvective) {
          convCount++;
        }
      }
    }

    if (total === 0) return 0;
    const eff = (convCount / total) * 100 + ((sevCount / total) * 100 * 1.5);
    return parseFloat(eff.toFixed(1));
  }

  /**
   * Measures convective cloud coverage percentages across Costa, Sierra and Amazonía.
   */
  public measureRegionalCoveragesInEcuadorImage(
    px: Uint8Array,
    imgWidth: number,
    imgHeight: number,
    nationalBbox: [number, number, number, number],
    source?: 'geoserver' | 'nasa_gibs'
  ): { costa: number; sierra: number; amazonia: number } {
    const effectiveSource = source || (process.env.SATELLITE_SOURCE === 'nasa_gibs' ? 'nasa_gibs' : 'geoserver');
    const [minLon, minLat, maxLon, maxLat] = nationalBbox;
    let tc = 0, cc = 0, ts = 0, cs = 0, ta = 0, ca = 0;

    for (let y = 0; y < imgHeight; y++) {
      const lat = maxLat - (y / imgHeight) * (maxLat - minLat);
      if (lat > 1.45 || lat < -4.95) continue;

      const csLon = interpolateDivideLon(COSTA_SIERRA_DIVIDE, lat);
      const saLon = interpolateDivideLon(SIERRA_AMAZONIA_DIVIDE, lat);

      for (let x = 0; x < imgWidth; x++) {
        const lon = minLon + (x / imgWidth) * (maxLon - minLon);

        let reg = 0;
        if (lon >= -81.10 && lon < csLon && lat >= -4.65) {
          reg = 1; // Costa
        } else if (lon >= csLon && lon < saLon) {
          reg = 2; // Sierra
        } else if (lon >= saLon && lon <= -75.20 && lat <= 0.75) {
          reg = 3; // Amazonia
        }

        if (reg === 0) continue;

        const i = (y * imgWidth + x) * 4;
        const r = px[i];
        const g = px[i + 1];
        const b = px[i + 2];

        const { isConvective } = isConvectivePixel(r, g, b, effectiveSource);
        if (isConvective) {
          if (reg === 1) cc++;
          else if (reg === 2) cs++;
          else if (reg === 3) ca++;
        }

        if (reg === 1) tc++;
        else if (reg === 2) ts++;
        else if (reg === 3) ta++;
      }
    }

    return {
      costa: tc > 0 ? parseFloat(((cc / tc) * 100).toFixed(1)) : 0,
      sierra: ts > 0 ? parseFloat(((cs / ts) * 100).toFixed(1)) : 0,
      amazonia: ta > 0 ? parseFloat(((ca / ta) * 100).toFixed(1)) : 0
    };
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
    autoPublishToSocial?: boolean;
    source?: 'geoserver' | 'nasa_gibs';
    framerate?: number;
    watermarkBrand?: 'x' | 'instagram';
  } = {}): Promise<{
    compilation: CompiledAnimationResult;
    postText: string;
    publishedTweetId?: string;
    basinSummaries: Array<{ plantKey: string; hasRain: boolean; peakCoveragePct: number; rainFrames: number }>;
    regionPeaks?: { costa: number; sierra: number; amazonia: number };
  }> {
    let targetDate = options.dateEcuador;
    if (!targetDate) {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      targetDate = yesterday.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
    }

    systemLogger.info(`[RainMonitor] Generating 24h satellite daily summary video for ${targetDate}...`);

    const requestedSource = options.source;
    let selectedSource: 'geoserver' | 'nasa_gibs' = requestedSource || (process.env.SATELLITE_SOURCE === 'nasa_gibs' ? 'nasa_gibs' : 'geoserver');

    let rows: Array<{ file_path: string; date_ecuador: string; time_ecuador: string; timestamp_iso: string; source: string }> = [];

    if (requestedSource) {
      if (requestedSource === 'nasa_gibs') {
        const existingCount = db.prepare(`SELECT COUNT(*) as count FROM satellite_archive WHERE date_ecuador = ? AND source = 'nasa_gibs' AND plant_key = 'ecuador'`).get(targetDate) as { count: number } | undefined;
        if (!existingCount || existingCount.count < 144) {
          try {
            await this.archiverService.backfillDateFrames(targetDate, 'nasa_gibs', 'ecuador');
          } catch (e: any) {
            systemLogger.warn(`[RainMonitor] Error during date backfill for NASA GIBS: ${e?.message || e}`);
          }
        }
      }
      rows = db.prepare(`
        SELECT file_path, date_ecuador, time_ecuador, timestamp_iso, source
        FROM satellite_archive
        WHERE date_ecuador = ? AND source = ?
        ORDER BY timestamp_iso ASC
      `).all(targetDate, requestedSource) as any[];
      selectedSource = requestedSource;
    } else {
      // 1. Primary preference: GeoServer (Standard for production server)
      const geoRows = db.prepare(`
        SELECT file_path, date_ecuador, time_ecuador, timestamp_iso, source
        FROM satellite_archive
        WHERE date_ecuador = ? AND source = 'geoserver'
        ORDER BY timestamp_iso ASC
      `).all(targetDate) as Array<{ file_path: string; date_ecuador: string; time_ecuador: string; timestamp_iso: string; source: string }>;

      // 2. Evaluate GeoServer continuity for the 24h day (detect gaps > 5 hours or insufficient coverage)
      let has5HourGap = false;
      if (geoRows.length < 90) { // 90 frames = ~15h out of 24h. If < 90, there is guaranteed a gap of > 5h
        has5HourGap = true;
      } else {
        for (let k = 1; k < geoRows.length; k++) {
          const prevTs = new Date(geoRows[k - 1].timestamp_iso).getTime();
          const currTs = new Date(geoRows[k].timestamp_iso).getTime();
          if ((currTs - prevTs) > (5 * 3600 * 1000)) { // Gap larger than 5 hours
            has5HourGap = true;
            break;
          }
        }
      }

      // If GeoServer is healthy, continuous, and has no >5h gaps, use it by default!
      if (!has5HourGap && geoRows.length >= 72) {
        selectedSource = 'geoserver';
        rows = geoRows;
      } else {
        // 3. Fallback to NASA GIBS (available in archive or online backfill)
        systemLogger.info(`[RainMonitor] GeoServer has incomplete coverage for ${targetDate} (found ${geoRows.length} frames, gap > 5h). Checking NASA GIBS...`);

        let nasaRows = db.prepare(`
          SELECT file_path, date_ecuador, time_ecuador, timestamp_iso, source
          FROM satellite_archive
          WHERE date_ecuador = ? AND source = 'nasa_gibs'
          ORDER BY timestamp_iso ASC
        `).all(targetDate) as Array<{ file_path: string; date_ecuador: string; time_ecuador: string; timestamp_iso: string; source: string }>;

        // If not all 144 NASA frames exist in SQLite, backfill the specific missing frames from NASA GIBS
        if (!nasaRows || nasaRows.length < 144) {
          try {
            systemLogger.info(`[RainMonitor] NASA GIBS archive has ${nasaRows?.length || 0}/144 frames for ${targetDate}. Ensuring complete 24h coverage...`);
            await this.archiverService.backfillDateFrames(targetDate, 'nasa_gibs', 'ecuador');
            nasaRows = db.prepare(`
              SELECT file_path, date_ecuador, time_ecuador, timestamp_iso, source
              FROM satellite_archive
              WHERE date_ecuador = ? AND source = 'nasa_gibs'
              ORDER BY timestamp_iso ASC
            `).all(targetDate) as any[];
          } catch (syncErr: any) {
            systemLogger.warn(`[RainMonitor] Could not backfill from NASA GIBS online: ${syncErr?.message || syncErr}`);
          }
        }

        // Use NASA GIBS if it has more frames than GeoServer
        if (nasaRows && nasaRows.length > geoRows.length && nasaRows.length >= 6) {
          selectedSource = 'nasa_gibs';
          rows = nasaRows;
          systemLogger.info(`[RainMonitor] Falling back to NASA GIBS for ${targetDate} daily summary (${nasaRows.length} frames vs ${geoRows.length} GeoServer frames).`);
        } else {
          selectedSource = geoRows.length >= (nasaRows?.length || 0) ? 'geoserver' : 'nasa_gibs';
          rows = selectedSource === 'geoserver' ? geoRows : (nasaRows || []);
        }
      }
    }

    if (!rows || rows.length < 6) {
      throw new Error(`[RainMonitor] Not enough archived satellite frames for date ${targetDate} (found: ${rows?.length || 0})`);
    }

    systemLogger.info(`[RainMonitor] Using ${rows.length} frames from source '${selectedSource}' for ${targetDate} daily summary.`);

    const targetBasins = ['cocaCodoSinclair', 'paute'];
    const activePerFrame = new Map<number, Set<string>>();
    const basinStats = new Map<string, { maxCoverage: number; rainFrames: number }>();
    for (const bKey of targetBasins) {
      basinStats.set(bKey, { maxCoverage: 0, rainFrames: 0 });
    }

    const frameMetrics = new Map<number, {
      ccs: number;
      paute: number;
      costa: number;
      sierra: number;
      amazonia: number;
    }>();

    const regionPeaks = { costa: 0, sierra: 0, amazonia: 0 };

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
        source: selectedSource
      });

      const activeBasins = new Set<string>();
      let frameCcs = 0;
      let framePaute = 0;
      let frameRegions = { costa: 0, sierra: 0, amazonia: 0 };

      try {
        const img = this.decodePng(buffer);
        const px = this.unfilterScanlines(img.raw, img.width, img.height);

        for (const bKey of targetBasins) {
          const threshold = DEFAULT_STORM_THRESHOLDS[bKey] ?? 10.0;
          const cov = this.measureBasinCoverageInEcuadorImage(px, img.width, img.height, ecuadorBbox, BASIN_GEOMETRIES[bKey].bbox, selectedSource, bKey);
          const stats = basinStats.get(bKey)!;
          if (cov > stats.maxCoverage) stats.maxCoverage = cov;

          if (cov >= threshold) {
            activeBasins.add(bKey);
            stats.rainFrames++;
          }

          if (bKey === 'cocaCodoSinclair') frameCcs = cov;
          if (bKey === 'paute') framePaute = cov;
        }

        frameRegions = this.measureRegionalCoveragesInEcuadorImage(px, img.width, img.height, ecuadorBbox, selectedSource);
        if (frameRegions.costa > regionPeaks.costa) regionPeaks.costa = frameRegions.costa;
        if (frameRegions.sierra > regionPeaks.sierra) regionPeaks.sierra = frameRegions.sierra;
        if (frameRegions.amazonia > regionPeaks.amazonia) regionPeaks.amazonia = frameRegions.amazonia;
      } catch (err) {}

      activePerFrame.set(i, activeBasins);
      frameMetrics.set(i, {
        ccs: frameCcs,
        paute: framePaute,
        costa: frameRegions.costa,
        sierra: frameRegions.sierra,
        amazonia: frameRegions.amazonia
      });
    }

    const framerate = options.framerate || 8;
    const outputName = `resumen_satelital_24h_${targetDate.replace(/[^0-9]/g, '')}`;
    const dateFormatted = this.formatDateToSpanish(targetDate);

    const basinSummaries = targetBasins.map(bKey => {
      const stats = basinStats.get(bKey)!;
      return {
        plantKey: bKey,
        hasRain: stats.rainFrames > 0,
        peakCoveragePct: stats.maxCoverage,
        rainFrames: stats.rainFrames
      };
    });

    const compilation = await this.videoCompilerService.compileFramesToVideo(framesToCompile, {
      plantKey: 'ecuador',
      outputName,
      framerate,
      watermarkBrand: options.watermarkBrand || 'instagram',
      minDurationSeconds: 12,
      customTitle: 'Resumen Satelital 24h • Ecuador Continental',
      customDateSubtitle: dateFormatted,
      showAllPins: true,
      showCityPins: true,
      showDetectionBoxes: true,
      showThermalScale: true,
      showProvinces: true,
      createMp4: true,
      createGif: false,
      activeBasinResolver: (frame, idx) => activePerFrame.get(idx) || new Set(),
      summaryCardsResolver: (frame, idx) => {
        const m = frameMetrics.get(idx) || { ccs: 0, paute: 0, costa: 0, sierra: 0, amazonia: 0 };
        const active = activePerFrame.get(idx) || new Set();
        return {
          basins: [
            {
              label: 'Coca Codo Sinclair',
              value: `${m.ccs.toFixed(1)}%`,
              color: '#facc15',
              highlight: active.has('cocaCodoSinclair')
            },
            {
              label: 'Complejo Paute',
              value: `${m.paute.toFixed(1)}%`,
              color: '#a855f7',
              highlight: active.has('paute')
            }
          ],
          regions: [
            {
              label: 'Costa',
              value: `${m.costa.toFixed(1)}%`,
              color: '#38bdf8',
              highlight: m.costa >= 10.0
            },
            {
              label: 'Sierra',
              value: `${m.sierra.toFixed(1)}%`,
              color: '#34d399',
              highlight: m.sierra >= 10.0
            },
            {
              label: 'Amazonía',
              value: `${m.amazonia.toFixed(1)}%`,
              color: '#f59e0b',
              highlight: m.amazonia >= 10.0
            }
          ]
        };
      }
    });

    const postText = buildDailySatelliteSummaryPostText({
      dateEcuador: dateFormatted,
      basinSummaries,
      regionPeaks
    });

    const autoPublishX = options.autoPublishToX !== false;
    const autoPublishSocial = options.autoPublishToSocial !== undefined ? options.autoPublishToSocial : autoPublishX;

    let publishedTweetId: string | undefined;
    if (compilation.mp4Path) {
      const finalVideoPath = this.archivePublishedVideo(compilation.mp4Path);
      compilation.mp4Path = finalVideoPath;

      if (autoPublishX && this.xService) {
        try {
          const postRes = await this.xService.postVideo(postText, finalVideoPath);
          publishedTweetId = postRes?.data?.id || postRes?.id;
          systemLogger.info(`[RainMonitor] 🐦 Successfully published 24h daily summary to X (Tweet ID: ${publishedTweetId})`);
        } catch (pubErr: any) {
          systemLogger.error(`[RainMonitor] Failed to auto-publish 24h summary video to X: ${pubErr?.message || pubErr}`);
        }
      }

      // Publish to Facebook Video and Instagram Reel
      if (autoPublishSocial) {
        if (this.facebookService) {
          try {
            await this.facebookService.postVideo(finalVideoPath, {
              title: `Resumen Satelital 24h • ${dateFormatted}`,
              description: postText
            });
            systemLogger.info(`[RainMonitor] 📘 Successfully published 24h daily summary to Facebook`);
          } catch (fbErr: any) {
            systemLogger.error(`[RainMonitor] Failed to auto-publish 24h summary video to Facebook: ${fbErr?.message || fbErr}`);
          }
        }

        if (this.instagramService) {
          try {
            await this.instagramService.postReel(finalVideoPath, {
              caption: postText
            });
            systemLogger.info(`[RainMonitor] 📸 Successfully published 24h daily summary Reel to Instagram`);
          } catch (igErr: any) {
            systemLogger.error(`[RainMonitor] Failed to auto-publish 24h summary Reel to Instagram: ${igErr?.message || igErr}`);
          }
        }
      }
    }

    return {
      compilation,
      postText,
      publishedTweetId,
      basinSummaries,
      regionPeaks
    };
  }
}
