import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { db } from '../utils/db.js';
import { BASIN_GEOMETRIES } from '../data/basin-geometries.js';
import { SatelliteMapService, SatelliteFrame } from './satellite-map.service.js';
import { systemLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export interface ArchivedFrameRecord {
  timestamp_iso: string;
  date_ecuador: string;
  time_ecuador: string;
  plant_key: string;
  file_path: string;
  file_size_bytes: number;
  recorded_at: number;
  source?: 'geoserver' | 'nasa_gibs' | 'esri_satellite';
}

export interface ArchiveStats {
  totalFrames: number;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
  totalSizeBytes: number;
  totalSizeMb: number;
  archiveDir: string;
}

export interface ArchiveLatestOptions {
  limit?: number;
  plantKey?: string;
  source?: 'geoserver' | 'nasa_gibs';
}

export class SatelliteArchiverService {
  private readonly archiveDir: string;

  constructor(
    private readonly satelliteService: SatelliteMapService = new SatelliteMapService(),
    customArchiveDir?: string
  ) {
    this.archiveDir = customArchiveDir || path.join(process.cwd(), 'data', 'satellite_archive');
    if (!fs.existsSync(this.archiveDir)) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
    }
  }

  /**
   * Archives a single frame by timestamp from the configured satellite source.
   * If source is 'nasa_gibs', composites with transparent provincial boundary overlay.
   * If source is 'geoserver', uses GeoServer layer goes_abi_l2_cmipf_13 + ecuador:provincias.
   */
  public async archiveSingleFrame(
    timeIso: string,
    plantKey: string = 'ecuador',
    source?: 'geoserver' | 'nasa_gibs'
  ): Promise<'DOWNLOADED' | 'SKIPPED' | 'FAILED'> {
    const effectiveSource = source || (process.env.SATELLITE_SOURCE === 'geoserver' ? 'geoserver' : 'nasa_gibs');
    const basin = BASIN_GEOMETRIES[plantKey] || BASIN_GEOMETRIES.ecuador;

    const existing = db.prepare(`
      SELECT timestamp_iso, file_path, source FROM satellite_archive
      WHERE timestamp_iso = ? AND source = ?
    `).get(timeIso, effectiveSource) as { timestamp_iso: string; file_path: string; source?: string } | undefined;

    if (existing && fs.existsSync(existing.file_path)) {
      return 'SKIPPED';
    }

    const { dateEcuador, timeEcuador } = this.satelliteService.formatEcuadorTimestamp(timeIso);
    const yearMonth = dateEcuador.slice(0, 7); // e.g., '2026-10'
    const targetSubdir = path.join(this.archiveDir, yearMonth);
    if (!fs.existsSync(targetSubdir)) {
      fs.mkdirSync(targetSubdir, { recursive: true });
    }

    const safeTs = timeIso.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(targetSubdir, `goes16_${effectiveSource}_${plantKey}_${safeTs}.png`);
    const metaPath = path.join(targetSubdir, `goes16_${effectiveSource}_${plantKey}_${safeTs}.json`);

    let buffer: Buffer | null = null;
    let lastErr: any = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (effectiveSource === 'nasa_gibs') {
          const tile = await this.satelliteService.fetchMapTile({
            source: 'nasa_gibs',
            plantKey,
            time: timeIso,
            width: 800,
            height: 800,
            format: 'image/png'
          });

          if (tile && tile.length > 0) {
            // Check for provincial overlay
            const overlayPath = path.join(process.cwd(), 'src', 'assets', 'overlays', 'ecuador_provincias_800.png');
            if (fs.existsSync(overlayPath)) {
              const tempRaw = `/tmp/raw_nasa_${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
              fs.writeFileSync(tempRaw, tile);
              try {
                await execFileAsync('ffmpeg', [
                  '-y',
                  '-i', tempRaw,
                  '-i', overlayPath,
                  '-filter_complex', '[0:v][1:v]overlay=0:0[out]',
                  '-map', '[out]',
                  filePath
                ]);
                buffer = fs.readFileSync(filePath);
              } catch (ffErr) {
                fs.writeFileSync(filePath, tile);
                buffer = tile;
              } finally {
                try { fs.unlinkSync(tempRaw); } catch {}
              }
            } else {
              fs.writeFileSync(filePath, tile);
              buffer = tile;
            }
            break;
          }
        } else {
          const tile = await this.satelliteService.fetchMapTile({
            source: 'geoserver',
            layers: 'goes:goes_abi_l2_cmipf_13,ecuador:provincias',
            bbox: basin.bbox,
            time: timeIso,
            width: 800,
            height: 800,
            format: 'image/png'
          });

          if (tile && tile.length > 0) {
            fs.writeFileSync(filePath, tile);
            buffer = tile;
            break;
          }
        }
      } catch (err: any) {
        lastErr = err;
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1200));
        }
      }
    }

    if (!buffer) {
      systemLogger.debug(
        `[SatelliteArchiver] Could not archive frame ${timeIso} from ${effectiveSource} after 3 attempts: ${lastErr?.message || lastErr}`
      );
      return 'FAILED';
    }

    try {
      fs.writeFileSync(
        metaPath,
        JSON.stringify(
          {
            timestampIso: timeIso,
            dateEcuador,
            timeEcuador,
            plantKey,
            bbox: basin.bbox,
            sizeBytes: buffer.length,
            source: effectiveSource,
            archivedAt: Date.now()
          },
          null,
          2
        )
      );

      db.prepare(`
        INSERT INTO satellite_archive (
          timestamp_iso, date_ecuador, time_ecuador, plant_key,
          file_path, file_size_bytes, recorded_at, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(timestamp_iso, source) DO UPDATE SET
          file_path = excluded.file_path,
          file_size_bytes = excluded.file_size_bytes,
          recorded_at = excluded.recorded_at
      `).run(timeIso, dateEcuador, timeEcuador, plantKey, filePath, buffer.length, Date.now(), effectiveSource);

      systemLogger.info(
        `[SatelliteArchiver] Archived frame (${effectiveSource}): ${dateEcuador} ${timeEcuador} ECT (${timeIso}) -> ${filePath}`
      );
      return 'DOWNLOADED';
    } catch (writeErr: any) {
      systemLogger.error(`[SatelliteArchiver] Failed writing frame ${timeIso}: ${writeErr?.message || writeErr}`);
      return 'FAILED';
    }
  }

  /**
   * Fetches latest timestamps from the active source and archives any frames not yet saved locally.
   */
  public async archiveLatestFrames(options: ArchiveLatestOptions = {}): Promise<{
    scanned: number;
    downloaded: number;
    skipped: number;
    newestTimestamp: string | null;
  }> {
    const limit = options.limit || 18;
    const plantKey = options.plantKey || 'ecuador';
    const effectiveSource = options.source || (process.env.SATELLITE_SOURCE === 'geoserver' ? 'geoserver' : 'nasa_gibs');

    let downloadedCount = 0;
    let skippedCount = 0;
    let scannedCount = 0;
    let newestTs: string | null = null;

    let timestamps: string[] = [];
    try {
      timestamps = await this.satelliteService.fetchGoesTimestamps({
        limit,
        fallbackToSynthetic: false,
        source: effectiveSource
      });
    } catch (err: any) {
      systemLogger.warn(`[SatelliteArchiver] Failed to fetch GOES timestamps from ${effectiveSource}: ${err?.message || err}`);
      return { scanned: 0, downloaded: 0, skipped: 0, newestTimestamp: null };
    }

    if (!timestamps || timestamps.length === 0) {
      return { scanned: 0, downloaded: 0, skipped: 0, newestTimestamp: null };
    }

    newestTs = timestamps[0];
    const chronological = [...timestamps].reverse();

    for (const timeIso of chronological) {
      scannedCount++;
      const res = await this.archiveSingleFrame(timeIso, plantKey, effectiveSource);
      if (res === 'DOWNLOADED') {
        downloadedCount++;
      } else if (res === 'SKIPPED') {
        skippedCount++;
      }
    }

    return {
      scanned: scannedCount,
      downloaded: downloadedCount,
      skipped: skippedCount,
      newestTimestamp: newestTs
    };
  }

  /**
   * Retrieves a chronological list of archived frames for a time range or limit.
   */
  public getArchivedFrames(options: {
    startDate?: string; // ISO string or 'YYYY-MM-DD'
    endDate?: string;   // ISO string or 'YYYY-MM-DD'
    limit?: number;
    plantKey?: string;
    latest?: boolean;
  } = {}): SatelliteFrame[] {
    const limit = options.limit || 50;
    const plantKey = options.plantKey || 'ecuador';
    const basin = BASIN_GEOMETRIES[plantKey] || BASIN_GEOMETRIES.ecuador;

    let query = `SELECT * FROM satellite_archive WHERE plant_key = ?`;
    const params: any[] = [plantKey];

    if (options.startDate) {
      query += ` AND timestamp_iso >= ?`;
      params.push(options.startDate);
    }
    if (options.endDate) {
      query += ` AND timestamp_iso <= ?`;
      params.push(options.endDate);
    }

    if (options.latest) {
      query += ` ORDER BY timestamp_iso DESC LIMIT ?`;
    } else {
      query += ` ORDER BY timestamp_iso ASC LIMIT ?`;
    }
    params.push(limit);

    let rows = db.prepare(query).all(...params) as ArchivedFrameRecord[];
    if (options.latest) {
      rows.reverse();
    }
    const frames: SatelliteFrame[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (fs.existsSync(row.file_path)) {
        try {
          const buffer = fs.readFileSync(row.file_path);
          frames.push({
            index: i,
            timestampIso: row.timestamp_iso,
            dateEcuador: row.date_ecuador,
            timeEcuador: row.time_ecuador,
            buffer,
            bbox: basin.bbox,
            plantKey,
            source: (row.source as any) || 'geoserver'
          });
        } catch (err) {}
      }
    }

    return frames;
  }

  /**
   * Prunes archived frames older than `maxDays` from disk and SQLite.
   */
  public pruneOldFrames(maxDays: number = 30): number {
    const cutoffTimestamp = Date.now() - maxDays * 24 * 3600 * 1000;
    const oldRows = db.prepare(`
      SELECT timestamp_iso, file_path FROM satellite_archive
      WHERE recorded_at < ?
    `).all(cutoffTimestamp) as Array<{ timestamp_iso: string; file_path: string }>;

    let prunedCount = 0;
    for (const row of oldRows) {
      try {
        if (fs.existsSync(row.file_path)) {
          fs.unlinkSync(row.file_path);
        }
        const metaPath = row.file_path.replace('.png', '.json');
        if (fs.existsSync(metaPath)) {
          fs.unlinkSync(metaPath);
        }
        prunedCount++;
      } catch (err) {}
    }

    db.prepare(`DELETE FROM satellite_archive WHERE recorded_at < ?`).run(cutoffTimestamp);
    return prunedCount;
  }

  /**
   * Returns storage statistics for the local satellite archive.
   */
  public getStats(): ArchiveStats {
    const row = db.prepare(`
      SELECT 
        COUNT(*) as totalFrames,
        MIN(timestamp_iso) as oldestTimestamp,
        MAX(timestamp_iso) as newestTimestamp,
        COALESCE(SUM(file_size_bytes), 0) as totalSizeBytes
      FROM satellite_archive
    `).get() as {
      totalFrames: number;
      oldestTimestamp: string | null;
      newestTimestamp: string | null;
      totalSizeBytes: number;
    };

    const totalSizeBytes = row.totalSizeBytes || 0;
    const totalSizeMb = parseFloat((totalSizeBytes / (1024 * 1024)).toFixed(2));

    return {
      totalFrames: row.totalFrames || 0,
      oldestTimestamp: row.oldestTimestamp,
      newestTimestamp: row.newestTimestamp,
      totalSizeBytes,
      totalSizeMb,
      archiveDir: this.archiveDir
    };
  }
}
