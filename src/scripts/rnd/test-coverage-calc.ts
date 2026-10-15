import fs from 'fs';
import { db } from '../../utils/db.js';
import { RainMonitorService } from '../../services/satellite/rain-monitor.service.js';
import { SatelliteMapService } from '../../services/telemetry/satellite-telemetry.service.js';
import { VideoCompilerService } from '../../services/satellite/video-compiler.service.js';
import { BASIN_GEOMETRIES } from '../../data/basin-geometries.js';

async function test() {
  const sat = new SatelliteMapService();
  const compiler = new VideoCompilerService(sat);
  const monitor = new RainMonitorService(sat, compiler);

  const rows = db.prepare(`
    SELECT file_path, timestamp_iso, date_ecuador, time_ecuador
    FROM satellite_archive
    WHERE date_ecuador = '2026-10-11'
    ORDER BY timestamp_iso ASC
    LIMIT 10
  `).all() as any[];

  console.log(`Analyzing first ${rows.length} frames of Oct 11...`);
  for (const r of rows) {
    if (!fs.existsSync(r.file_path)) continue;
    const buf = fs.readFileSync(r.file_path);
    const img = (monitor as any).decodePng(buf);
    const px = (monitor as any).unfilterScanlines(img.raw, img.width, img.height);
    const ccsCov = (monitor as any).measureBasinCoverageInEcuadorImage(px, img.width, img.height, BASIN_GEOMETRIES.ecuador.bbox, BASIN_GEOMETRIES.cocaCodoSinclair.bbox);
    const pauteCov = (monitor as any).measureBasinCoverageInEcuadorImage(px, img.width, img.height, BASIN_GEOMETRIES.ecuador.bbox, BASIN_GEOMETRIES.paute.bbox);
    console.log(`${r.time_ecuador} ECT -> CCS: ${ccsCov.toFixed(1)}% | Paute: ${pauteCov.toFixed(1)}%`);
  }
}

test().catch(console.error);
