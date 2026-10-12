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

interface FrameMetric {
  timestampIso: string;
  epochMs: number;
  ccsConv: number;
  ccsSev: number;
  pauteConv: number;
  pauteSev: number;
}

console.log('Processing all frames for accurate storm event backfill...');
const frameMetrics: FrameMetric[] = [];

for (const row of rows) {
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

    const convPct = (convCount / total) * 100;
    const sevPct = (sevCount / total) * 100;
    if (bKey === 'cocaCodoSinclair') {
      ccsConv = convPct;
      ccsSev = sevPct;
    } else {
      pauteConv = convPct;
      pauteSev = sevPct;
    }
  }

  frameMetrics.push({
    timestampIso: row.timestamp_iso,
    epochMs,
    ccsConv,
    ccsSev,
    pauteConv,
    pauteSev
  });
}

// Reset rain_events in SQLite with calibrated events
db.exec('DELETE FROM rain_events;');

const THRESHOLD = 6.0;

for (const bKey of ['cocaCodoSinclair', 'paute']) {
  let activeEvent: any = null;

  for (let i = 0; i < frameMetrics.length; i++) {
    const f = frameMetrics[i];
    const conv = bKey === 'cocaCodoSinclair' ? f.ccsConv : f.pauteConv;
    const sev = bKey === 'cocaCodoSinclair' ? f.ccsSev : f.pauteSev;
    const isTrigger = conv >= THRESHOLD || sev >= 1.2;

    if (!activeEvent && isTrigger) {
      activeEvent = {
        plant_key: bKey,
        detected_at: f.epochMs,
        last_checked_at: f.epochMs,
        peak_coverage_pct: conv,
        last_coverage_pct: conv,
        frames: 1
      };
    } else if (activeEvent) {
      if (isTrigger) {
        activeEvent.last_checked_at = f.epochMs;
        activeEvent.peak_coverage_pct = Math.max(activeEvent.peak_coverage_pct, conv);
        activeEvent.last_coverage_pct = conv;
        activeEvent.frames++;
      } else {
        // Event ended
        db.prepare(`
          INSERT INTO rain_events (
            plant_key, status, detected_at, last_checked_at,
            peak_coverage_pct, last_coverage_pct, cooldown_until
          ) VALUES (?, 'CLOSED', ?, ?, ?, ?, ?)
        `).run(
          activeEvent.plant_key,
          activeEvent.detected_at,
          activeEvent.last_checked_at,
          parseFloat(activeEvent.peak_coverage_pct.toFixed(1)),
          parseFloat(activeEvent.last_coverage_pct.toFixed(1)),
          activeEvent.last_checked_at + 6 * 3600 * 1000
        );
        activeEvent = null;
      }
    }
  }

  if (activeEvent) {
    // Currently active event
    db.prepare(`
      INSERT INTO rain_events (
        plant_key, status, detected_at, last_checked_at,
        peak_coverage_pct, last_coverage_pct, cooldown_until
      ) VALUES (?, 'ACTIVE', ?, ?, ?, ?, ?)
    `).run(
      activeEvent.plant_key,
      activeEvent.detected_at,
      activeEvent.last_checked_at,
      parseFloat(activeEvent.peak_coverage_pct.toFixed(1)),
      parseFloat(activeEvent.last_coverage_pct.toFixed(1)),
      0
    );
  }
}

const finalEvents = db.prepare(`
  SELECT id, plant_key, status,
         datetime(detected_at/1000, 'unixepoch', '-5 hours') as start_ect,
         datetime(last_checked_at/1000, 'unixepoch', '-5 hours') as end_ect,
         peak_coverage_pct, last_coverage_pct
  FROM rain_events ORDER BY detected_at ASC
`).all();

console.log('\n=== CALIBRATED RAIN EVENTS IN SQLITE ===');
console.table(finalEvents);
