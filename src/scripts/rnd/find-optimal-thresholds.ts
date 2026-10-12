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

const rows = db.prepare('SELECT file_path, date_ecuador, time_ecuador, timestamp_iso FROM satellite_archive ORDER BY timestamp_iso ASC').all() as any[];
const ecuadorBbox = BASIN_GEOMETRIES.ecuador.bbox;

interface FrameResult {
  ts: number;
  date: string;
  time: string;
  coverages: Record<string, number>;
}

console.log(`[1/2] Extrayendo coberturas de ${rows.length} fotogramas satelitales archivados...`);
const analyzedFrames: FrameResult[] = [];
const targetBasins = ['paute', 'cocaCodoSinclair'];

for (const row of rows) {
  if (!fs.existsSync(row.file_path)) continue;
  try {
    const img = decodePng(fs.readFileSync(row.file_path));
    const px = unfilter(img.raw, img.width, img.height);
    const coverages: Record<string, number> = {};

    for (const bKey of targetBasins) {
      const bbox = BASIN_GEOMETRIES[bKey].bbox;
      const tl = projectGeoToPixel(bbox[3], bbox[0], ecuadorBbox, img.width, img.height);
      const br = projectGeoToPixel(bbox[1], bbox[2], ecuadorBbox, img.width, img.height);

      let total = 0, convCount = 0, severeCount = 0;
      for (let y = Math.min(tl.y, br.y); y <= Math.max(tl.y, br.y); y++) {
        for (let x = Math.min(tl.x, br.x); x <= Math.max(tl.x, br.x); x++) {
          total++;
          const i = (y * img.width + x) * 4;
          const r = px[i], g = px[i+1], b = px[i+2];
          const isYellow = (r > 160 && g > 160 && b < 120);
          const isRed = (r > 130 && g < 100 && b < 100);
          const isWhite = (r > 210 && g > 210 && b > 210);
          const isSevere = isYellow || isRed || isWhite;
          const isGreen = (g > 140 && g > r + 25 && g > b + 25) || (g > 150 && r < 130 && b < 130);
          if (isSevere) { severeCount++; convCount++; }
          else if (isGreen) convCount++;
        }
      }

      const convPct = (convCount / total) * 100;
      const sevPct = (severeCount / total) * 100;
      const effectiveCoverage = convPct + (sevPct * 1.5);
      coverages[bKey] = parseFloat(effectiveCoverage.toFixed(1));
    }

    analyzedFrames.push({
      ts: new Date(row.timestamp_iso).getTime(),
      date: row.date_ecuador,
      time: row.time_ecuador,
      coverages
    });
  } catch (err) {}
}

const uniqueDates = Array.from(new Set(analyzedFrames.map(f => f.date))).sort();
const totalDays = uniqueDates.length;
console.log(`✅ ${analyzedFrames.length} fotogramas analizados exitosamente en ${totalDays} días completos (${uniqueDates[0]} a ${uniqueDates[uniqueDates.length - 1]}).`);

console.log('\n[2/2] Simulando máquina de estados de alerta (cooldown 6h, duración mínima 30 min):');

// Test thresholds from 5% to 22%
const testThresholds = [6.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 20.0];

for (const bKey of targetBasins) {
  const basinName = BASIN_GEOMETRIES[bKey].name;
  console.log(`\n========================================================================`);
  console.log(`📊 ANÁLISIS DE UMBRALES PARA: ${basinName} (${bKey})`);
  console.log(`   Periodo evaluado: ${totalDays} días`);
  console.log(`========================================================================`);

  for (const threshold of testThresholds) {
    let inEvent = false;
    let eventStartTs = 0;
    let peakCoverage = 0;
    let cooldownUntil = 0;
    let publishedAlertsCount = 0;
    const events: Array<{ start: string; end: string; peak: number; durMin: number }> = [];

    for (let i = 0; i < analyzedFrames.length; i++) {
      const f = analyzedFrames[i];
      const cov = f.coverages[bKey] || 0;

      // In cooldown?
      if (f.ts < cooldownUntil) {
        continue;
      }

      if (!inEvent) {
        if (cov >= threshold) {
          inEvent = true;
          eventStartTs = f.ts;
          peakCoverage = cov;
        }
      } else {
        // Ongoing storm
        peakCoverage = Math.max(peakCoverage, cov);
        const elapsedMinutes = Math.round((f.ts - eventStartTs) / 60000);

        // Check completion / dissipation (dropped <= 50% of peak or reached 2.5h)
        const isDissipated = cov <= peakCoverage * 0.50;
        const isTimeout = elapsedMinutes >= 150;

        if ((isDissipated && elapsedMinutes >= 30) || isTimeout) {
          // Valid alert published!
          publishedAlertsCount++;
          cooldownUntil = f.ts + 6 * 3600 * 1000;
          events.push({
            start: `${f.date} ${f.time}`,
            end: `${f.date} ${f.time}`,
            peak: peakCoverage,
            durMin: elapsedMinutes
          });
          inEvent = false;
        } else if (isDissipated && elapsedMinutes < 30) {
          // Too short / evanescent cloud (< 30 min) -> discarded, no alert
          inEvent = false;
        }
      }
    }

    const avgAlertsPerDay = (publishedAlertsCount / totalDays).toFixed(2);
    const indicator = Math.abs(publishedAlertsCount / totalDays - 1.0) <= 0.15 ? '⭐️ OPTIMAL (~1/día)' : '';
    console.log(`• Umbral ${threshold.toString().padStart(4, ' ')}% -> ${publishedAlertsCount.toString().padStart(2, ' ')} alertas en ${totalDays} días | Promedio: ${avgAlertsPerDay} alertas/día ${indicator}`);
  }
}
