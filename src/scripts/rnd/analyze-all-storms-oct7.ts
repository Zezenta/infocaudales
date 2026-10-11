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

interface FrameCoverage {
  timestampIso: string;
  timeEcuador: string;
  dateEcuador: string;
  epochMs: number;
  ccsConv: number;
  ccsSev: number;
  pauteConv: number;
  pauteSev: number;
}

const rows = db.prepare('SELECT file_path, date_ecuador, time_ecuador, timestamp_iso FROM satellite_archive ORDER BY timestamp_iso ASC').all() as any[];
const ecuadorBbox = BASIN_GEOMETRIES.ecuador.bbox;

console.log(`Analyzing ${rows.length} archived frames from ${rows[0]?.timestamp_iso} to ${rows[rows.length - 1]?.timestamp_iso}...`);

const frameCoverages: FrameCoverage[] = [];

for (let idx = 0; idx < rows.length; idx++) {
  const row = rows[idx];
  if (!fs.existsSync(row.file_path)) continue;
  const img = decodePng(fs.readFileSync(row.file_path));
  const px = unfilter(img.raw, img.width, img.height);
  const epochMs = new Date(row.timestamp_iso).getTime();

  let ccsConv = 0, ccsSev = 0, pauteConv = 0, pauteSev = 0;

  for (const bKey of ['cocaCodoSinclair', 'paute']) {
    const bbox = BASIN_GEOMETRIES[bKey].bbox;
    const tl = projectGeoToPixel(bbox[3], bbox[0], ecuadorBbox, img.width, img.height);
    const br = projectGeoToPixel(bbox[1], bbox[2], ecuadorBbox, img.width, img.height);

    let total = 0, convCount = 0, sevCount = 0;
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
        if (isSevere) { sevCount++; convCount++; }
        else if (isGreen) convCount++;
      }
    }

    const convPct = Math.round((convCount / total) * 1000) / 10;
    const sevPct = Math.round((sevCount / total) * 1000) / 10;
    if (bKey === 'cocaCodoSinclair') {
      ccsConv = convPct;
      ccsSev = sevPct;
    } else {
      pauteConv = convPct;
      pauteSev = sevPct;
    }
  }

  frameCoverages.push({
    timestampIso: row.timestamp_iso,
    timeEcuador: row.time_ecuador,
    dateEcuador: row.date_ecuador,
    epochMs,
    ccsConv,
    ccsSev,
    pauteConv,
    pauteSev
  });
}

console.log(`Computed coverage for ${frameCoverages.length} frames.`);

interface StormEpisode {
  plantKey: string;
  plantName: string;
  startIso: string;
  startEct: string;
  endIso: string;
  endEct: string;
  peakIso: string;
  peakEct: string;
  peakCoveragePct: number;
  peakSeverePct: number;
  durationMinutes: number;
  frameCount: number;
  isActive: boolean;
}

const episodes: StormEpisode[] = [];
const ONSET_THRESHOLD = 6.0;
const SEVERE_ONSET = 1.2;
const CONTINUATION_THRESHOLD = 3.8;

for (const basinKey of ['cocaCodoSinclair', 'paute']) {
  const basinName = basinKey === 'cocaCodoSinclair' ? 'Coca Codo Sinclair' : 'Complejo Paute';
  let curEpisode: any = null;
  let belowCount = 0;

  for (let i = 0; i < frameCoverages.length; i++) {
    const f = frameCoverages[i];
    const conv = basinKey === 'cocaCodoSinclair' ? f.ccsConv : f.pauteConv;
    const sev = basinKey === 'cocaCodoSinclair' ? f.ccsSev : f.pauteSev;
    const isTrigger = conv >= ONSET_THRESHOLD || sev >= SEVERE_ONSET;
    const isSustained = conv >= CONTINUATION_THRESHOLD || sev >= 0.8;

    if (!curEpisode) {
      if (isTrigger) {
        curEpisode = {
          plantKey: basinKey,
          plantName: basinName,
          startIso: f.timestampIso,
          startEct: `${f.dateEcuador} ${f.timeEcuador}`,
          endIso: f.timestampIso,
          endEct: `${f.dateEcuador} ${f.timeEcuador}`,
          peakIso: f.timestampIso,
          peakEct: `${f.dateEcuador} ${f.timeEcuador}`,
          peakCoveragePct: conv,
          peakSeverePct: sev,
          startEpoch: f.epochMs,
          endEpoch: f.epochMs,
          frameCount: 1,
          isActive: false
        };
        belowCount = 0;
      }
    } else {
      if (isSustained) {
        curEpisode.endIso = f.timestampIso;
        curEpisode.endEct = `${f.dateEcuador} ${f.timeEcuador}`;
        curEpisode.endEpoch = f.epochMs;
        curEpisode.frameCount++;
        if (conv > curEpisode.peakCoveragePct) {
          curEpisode.peakCoveragePct = conv;
          curEpisode.peakSeverePct = sev;
          curEpisode.peakIso = f.timestampIso;
          curEpisode.peakEct = `${f.dateEcuador} ${f.timeEcuador}`;
        }
        belowCount = 0;
      } else {
        belowCount++;
        // Allow up to 1 frame gap (10 min) fluctuation before closing
        if (belowCount >= 2 || i === frameCoverages.length - 1) {
          const durationMinutes = Math.round((curEpisode.endEpoch - curEpisode.startEpoch) / 60000);
          if (curEpisode.frameCount >= 2 || curEpisode.peakCoveragePct >= 7.0 || curEpisode.peakSeverePct >= 1.5) {
            episodes.push({
              plantKey: curEpisode.plantKey,
              plantName: curEpisode.plantName,
              startIso: curEpisode.startIso,
              startEct: curEpisode.startEct,
              endIso: curEpisode.endIso,
              endEct: curEpisode.endEct,
              peakIso: curEpisode.peakIso,
              peakEct: curEpisode.peakEct,
              peakCoveragePct: curEpisode.peakCoveragePct,
              peakSeverePct: curEpisode.peakSeverePct,
              durationMinutes: Math.max(10, durationMinutes),
              frameCount: curEpisode.frameCount,
              isActive: false
            });
          }
          curEpisode = null;
          belowCount = 0;
        }
      }
    }
  }

  if (curEpisode) {
    const durationMinutes = Math.round((curEpisode.endEpoch - curEpisode.startEpoch) / 60000);
    episodes.push({
      plantKey: curEpisode.plantKey,
      plantName: curEpisode.plantName,
      startIso: curEpisode.startIso,
      startEct: curEpisode.startEct,
      endIso: curEpisode.endIso,
      endEct: curEpisode.endEct,
      peakIso: curEpisode.peakIso,
      peakEct: curEpisode.peakEct,
      peakCoveragePct: curEpisode.peakCoveragePct,
      peakSeverePct: curEpisode.peakSeverePct,
      durationMinutes: Math.max(10, durationMinutes),
      frameCount: curEpisode.frameCount,
      isActive: true
    });
  }
}

// Sort chronologically by startIso
episodes.sort((a, b) => new Date(a.startIso).getTime() - new Date(b.startIso).getTime());

console.log('\n========================================================================================');
console.log('⚡ TODAS LAS TORMENTAS DETECTADAS EN ARCHIVO SATELITAL (02 OCTUBRE AL 07 OCTUBRE 2026)');
console.log('========================================================================================\n');

for (let i = 0; i < episodes.length; i++) {
  const ep = episodes[i];
  const hours = (ep.durationMinutes / 60).toFixed(1);
  const statusStr = ep.isActive ? '🔴 [EN CURSO AHORA]' : '⚪ [FINALIZADA]';
  console.log(`${i + 1}. [${ep.plantName.toUpperCase()}] ${statusStr}`);
  console.log(`   • Inicio:     ${ep.startEct} ECT (${ep.startIso})`);
  console.log(`   • Pico:       ${ep.peakEct} ECT con ${ep.peakCoveragePct}% cobertura (Núcleo severo: ${ep.peakSeverePct}%)`);
  console.log(`   • Fin:        ${ep.endEct} ECT (${ep.endIso})`);
  console.log(`   • Duración:   ${ep.durationMinutes} min (~${hours} horas) [${ep.frameCount} fotogramas]`);
  console.log('----------------------------------------------------------------------------------------');
}

// Sync into SQLite rain_events
db.exec('DELETE FROM rain_events;');
for (const ep of episodes) {
  const detectedAt = new Date(ep.startIso).getTime();
  const lastCheckedAt = new Date(ep.endIso).getTime();
  const status = ep.isActive ? 'ACTIVE' : 'CLOSED';
  db.prepare(`
    INSERT INTO rain_events (
      plant_key, status, detected_at, last_checked_at,
      peak_coverage_pct, last_coverage_pct, cooldown_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    ep.plantKey,
    status,
    detectedAt,
    lastCheckedAt,
    ep.peakCoveragePct,
    ep.peakCoveragePct,
    ep.isActive ? 0 : lastCheckedAt + 6 * 3600 * 1000
  );
}

// Export json
fs.writeFileSync('generated/all_storm_episodes_oct2_oct7.json', JSON.stringify(episodes, null, 2));
console.log('Saved to generated/all_storm_episodes_oct2_oct7.json and synchronized into SQLite.');

