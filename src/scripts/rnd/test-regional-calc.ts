import fs from 'fs';
import { db } from '../../utils/db.js';
import { RainMonitorService } from '../../services/satellite/rain-monitor.service.js';
import { SatelliteMapService } from '../../services/telemetry/satellite-telemetry.service.js';
import { VideoCompilerService } from '../../services/satellite/video-compiler.service.js';
import { BASIN_GEOMETRIES } from '../../data/basin-geometries.js';

const COSTA_SIERRA: Array<[number, number]> = [
  [-78.80, 1.45],
  [-78.95, 0.85],
  [-79.10, 0.10],
  [-79.20, -0.30],
  [-79.25, -0.95],
  [-79.30, -1.45],
  [-79.38, -1.85],
  [-79.48, -2.30],
  [-79.58, -2.75],
  [-79.68, -3.20],
  [-79.82, -3.70],
  [-79.98, -4.10],
  [-80.20, -4.45],
  [-80.45, -4.65]
];

const SIERRA_AMAZONIA: Array<[number, number]> = [
  [-77.55, 0.75],
  [-77.85, -0.05],
  [-77.95, -0.55],
  [-78.05, -1.05],
  [-78.18, -1.45],
  [-78.32, -2.05],
  [-78.45, -2.85],
  [-78.60, -3.45],
  [-78.85, -4.00],
  [-79.05, -4.65],
  [-79.15, -4.95]
];

function interpolateDivideLon(divide: Array<[number, number]>, lat: number): number {
  if (lat >= divide[0][1]) return divide[0][0];
  if (lat <= divide[divide.length - 1][1]) return divide[divide.length - 1][0];
  for (let i = 0; i < divide.length - 1; i++) {
    const [lon1, lat1] = divide[i];
    const [lon2, lat2] = divide[i + 1];
    if (lat <= lat1 && lat >= lat2) {
      const t = (lat - lat2) / (lat1 - lat2);
      return lon2 + t * (lon1 - lon2);
    }
  }
  return divide[0][0];
}

async function test() {
  const sat = new SatelliteMapService();
  const compiler = new VideoCompilerService(sat);
  const monitor = new RainMonitorService(sat, compiler);
  const [minLon, minLat, maxLon, maxLat] = BASIN_GEOMETRIES.ecuador.bbox;

  const times = ['00:00', '03:50', '04:40', '09:30', '14:10', '18:00', '22:00'];
  console.log('Progreso regional a lo largo del 11 de octubre:');

  for (const time of times) {
    const row = db.prepare(`
      SELECT file_path, time_ecuador
      FROM satellite_archive
      WHERE date_ecuador = '2026-10-11' AND time_ecuador = ?
      LIMIT 1
    `).get(time) as any;

    if (!row || !fs.existsSync(row.file_path)) continue;

    const buf = fs.readFileSync(row.file_path);
    const img = (monitor as any).decodePng(buf);
    const px = (monitor as any).unfilterScanlines(img.raw, img.width, img.height);

    let tc = 0, cc = 0, ts = 0, cs = 0, ta = 0, ca = 0;
    for (let y = 0; y < img.height; y++) {
      const lat = maxLat - (y / img.height) * (maxLat - minLat);
      if (lat > 1.45 || lat < -4.95) continue;
      const csLon = interpolateDivideLon(COSTA_SIERRA, lat);
      const saLon = interpolateDivideLon(SIERRA_AMAZONIA, lat);
      for (let x = 0; x < img.width; x++) {
        const lon = minLon + (x / img.width) * (maxLon - minLon);
        let reg = 0;
        if (lon >= -81.10 && lon < csLon && lat >= -4.65) reg = 1;
        else if (lon >= csLon && lon < saLon) reg = 2;
        else if (lon >= saLon && lon <= -75.20 && lat <= 0.75) reg = 3;
        if (reg === 0) continue;
        const i = (y * img.width + x) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const isSevere = (r > 160 && g > 160 && b < 120) || (r > 130 && g < 100 && b < 100) || (r > 210 && g > 210 && b > 210);
        const isGreen = (g > 140 && g > r + 25 && g > b + 25) || (g > 150 && r < 130 && b < 130);
        if (isSevere || isGreen) {
          if (reg === 1) cc++; else if (reg === 2) cs++; else if (reg === 3) ca++;
        }
        if (reg === 1) tc++; else if (reg === 2) ts++; else if (reg === 3) ta++;
      }
    }
    const ccsCov = (monitor as any).measureBasinCoverageInEcuadorImage(px, img.width, img.height, BASIN_GEOMETRIES.ecuador.bbox, BASIN_GEOMETRIES.cocaCodoSinclair.bbox);
    const pauteCov = (monitor as any).measureBasinCoverageInEcuadorImage(px, img.width, img.height, BASIN_GEOMETRIES.ecuador.bbox, BASIN_GEOMETRIES.paute.bbox);

    console.log(`${time} ECT -> CCS: ${ccsCov.toFixed(1).padStart(4)}% | Paute: ${pauteCov.toFixed(1).padStart(4)}% | Costa: ${((cc/tc)*100).toFixed(1).padStart(4)}% | Sierra: ${((cs/ts)*100).toFixed(1).padStart(4)}% | Amazonía: ${((ca/ta)*100).toFixed(1).padStart(4)}%`);
  }
}

test().catch(console.error);
