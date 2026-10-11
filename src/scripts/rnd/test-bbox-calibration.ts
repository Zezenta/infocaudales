import { BASIN_GEOMETRIES } from '../../data/basin-geometries.js';
import { db } from '../../utils/db.js';
import fs from 'fs';
import zlib from 'zlib';

function decodePng(buf: Buffer) {
  let offset = 8;
  let width = 0, height = 0;
  const idatChunks: Buffer[] = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
    } else if (type === 'IDAT') idatChunks.push(buf.subarray(offset + 8, offset + 8 + len));
    else if (type === 'IEND') break;
    offset += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  return { width, height, raw };
}

function unfilter(raw: Buffer, width: number, height: number) {
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

function projectGeoToPixel(lat: number, lon: number, bbox: [number, number, number, number], width: number, height: number) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const x = Math.round(((lon - minLon) / (maxLon - minLon)) * width);
  const y = Math.round(((maxLat - lat) / (maxLat - minLat)) * height);
  return { x: Math.max(0, Math.min(width - 1, x)), y: Math.max(0, Math.min(height - 1, y)) };
}

function calculateBoxCoverage(px: Buffer, width: number, height: number, nationalBbox: [number, number, number, number], targetBbox: [number, number, number, number]) {
  const tl = projectGeoToPixel(targetBbox[3], targetBbox[0], nationalBbox, width, height);
  const br = projectGeoToPixel(targetBbox[1], targetBbox[2], nationalBbox, width, height);

  let total = 0, convCount = 0, sevCount = 0;
  for (let y = Math.min(tl.y, br.y); y <= Math.max(tl.y, br.y); y++) {
    for (let x = Math.min(tl.x, br.x); x <= Math.max(tl.x, br.x); x++) {
      total++;
      const i = (y * width + x) * 4;
      const r = px[i], g = px[i+1], b = px[i+2];
      const isYellow = (r > 160 && g > 160 && b < 120);
      const isRed = (r > 130 && g < 100 && b < 100);
      const isWhite = (r > 210 && g > 210 && b > 210);
      const isSevere = isYellow || isRed || isWhite;
      const isGreen = (g > 140 && g > r + 25 && g > b + 25) || (g > 150 && r < 130 && b < 130);
      if (isSevere) { sevCount++; convCount++; }
      else if (isGreen) convCount++;
    }
  }
  return {
    convPct: total > 0 ? Math.round((convCount / total) * 1000) / 10 : 0,
    sevPct: total > 0 ? Math.round((sevCount / total) * 1000) / 10 : 0,
    pixelCount: total
  };
}

const nationalBbox = BASIN_GEOMETRIES.ecuador.bbox;

// Compare Old vs Calibrated
const BBOX_CONFIGS = {
  ccs_old: [-78.40, -0.80, -77.10, 0.50] as [number, number, number, number],
  ccs_calibrated: [-78.30, -0.75, -77.60, 0.20] as [number, number, number, number],
  paute_old: [-79.15, -3.15, -78.05, -2.05] as [number, number, number, number],
  paute_calibrated: [-79.38, -3.30, -78.40, -2.25] as [number, number, number, number]
};

// Select interesting sample frames from the archive:
// 1. Oct 3 afternoon (intense Paute storm)
// 2. Oct 7 night (recent massive Paute storm)
// 3. Oct 6 night (massive CCS storm)
// 4. An Amazon-only storm day (to see if old CCS false-triggered)
const sampleTimestamps = [
  '2026-10-03T21:10:00.000Z', // Oct 3 16:10 ECT (Paute peak)
  '2026-10-06T20:30:00.000Z', // Oct 6 15:30 ECT (CCS afternoon)
  '2026-10-07T05:00:00.000Z', // Oct 7 00:00 ECT (CCS midnight)
  '2026-10-08T02:10:00.000Z', // Oct 7 21:10 ECT (Paute severe tonight)
  '2026-10-04T19:00:00.000Z'  // Oct 4 afternoon
];

console.log('=== COMPARATIVA DE COBERTURA: BBOX ANTIGUO VS BBOX CALIBRADO HIDROLÓGICAMENTE ===\n');

for (const ts of sampleTimestamps) {
  const row = db.prepare('SELECT file_path, date_ecuador, time_ecuador FROM satellite_archive WHERE timestamp_iso = ?').get(ts) as any;
  if (!row || !fs.existsSync(row.file_path)) continue;

  const img = decodePng(fs.readFileSync(row.file_path));
  const px = unfilter(img.raw, img.width, img.height);

  const ccsOld = calculateBoxCoverage(px, img.width, img.height, nationalBbox, BBOX_CONFIGS.ccs_old);
  const ccsCal = calculateBoxCoverage(px, img.width, img.height, nationalBbox, BBOX_CONFIGS.ccs_calibrated);

  const pauteOld = calculateBoxCoverage(px, img.width, img.height, nationalBbox, BBOX_CONFIGS.paute_old);
  const pauteCal = calculateBoxCoverage(px, img.width, img.height, nationalBbox, BBOX_CONFIGS.paute_calibrated);

  console.log(`📸 Fotograma: ${row.date_ecuador} ${row.time_ecuador} ECT (${ts})`);
  console.log(`  🌊 Coca Codo Sinclair:`);
  console.log(`     • Bbox Antiguo (incluye 60km selva baja): ${ccsOld.convPct}% conv, ${ccsOld.sevPct}% severo (${ccsOld.pixelCount} px)`);
  console.log(`     • Bbox Calibrado (cuenca aportante real): ${ccsCal.convPct}% conv, ${ccsCal.sevPct}% severo (${ccsCal.pixelCount} px)`);
  console.log(`  ⛰️ Complejo Paute:`);
  console.log(`     • Bbox Antiguo (corta Cajas, incluye Macas): ${pauteOld.convPct}% conv, ${pauteOld.sevPct}% severo (${pauteOld.pixelCount} px)`);
  console.log(`     • Bbox Calibrado (incluye Cajas y embalses):  ${pauteCal.convPct}% conv, ${pauteCal.sevPct}% severo (${pauteCal.pixelCount} px)`);
  console.log('----------------------------------------------------------------------------------------');
}
