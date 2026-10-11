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

const rows = db.prepare('SELECT file_path, date_ecuador, time_ecuador FROM satellite_archive ORDER BY timestamp_iso ASC').all() as any[];
const ecuadorBbox = BASIN_GEOMETRIES.ecuador.bbox;

interface FrameResult {
  date: string;
  time: string;
  ccsConv: number;
  ccsSev: number;
  pauteConv: number;
  pauteSev: number;
}

console.log(`Decoding ${rows.length} archived frames...`);
const analyzedFrames: FrameResult[] = [];

for (const row of rows) {
  if (!fs.existsSync(row.file_path)) continue;
  const img = decodePng(fs.readFileSync(row.file_path));
  const px = unfilter(img.raw, img.width, img.height);

  let ccsConv = 0, ccsSev = 0, pauteConv = 0, pauteSev = 0;

  for (const bKey of ['cocaCodoSinclair', 'paute']) {
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
        const isGreen = (g > 140 && g > r + 30 && g > b + 30) || (g > 150 && r < 130 && b < 130);
        if (isSevere) { severeCount++; convCount++; }
        else if (isGreen) convCount++;
      }
    }

    const convPct = (convCount / total) * 100;
    const sevPct = (severeCount / total) * 100;
    if (bKey === 'cocaCodoSinclair') {
      ccsConv = convPct;
      ccsSev = sevPct;
    } else {
      pauteConv = convPct;
      pauteSev = sevPct;
    }
  }

  analyzedFrames.push({
    date: row.date_ecuador,
    time: row.time_ecuador,
    ccsConv,
    ccsSev,
    pauteConv,
    pauteSev
  });
}

for (const threshold of [5.0, 6.0, 7.0]) {
  console.log(`\n=============================================`);
  console.log(`EVALUATING CONVECTIVE THRESHOLD: ${threshold}%`);
  console.log(`=============================================`);

  for (const bKey of ['cocaCodoSinclair', 'paute']) {
    let activeEvent: any = null;
    const events: any[] = [];

    for (const f of analyzedFrames) {
      const conv = bKey === 'cocaCodoSinclair' ? f.ccsConv : f.pauteConv;
      const sev = bKey === 'cocaCodoSinclair' ? f.ccsSev : f.pauteSev;
      const isTrigger = conv >= threshold || sev >= 1.5;

      if (!activeEvent && isTrigger) {
        activeEvent = { start: `${f.date} ${f.time}`, peak: conv, peakSev: sev, frames: 1 };
      } else if (activeEvent) {
        if (isTrigger) {
          activeEvent.frames++;
          activeEvent.peak = Math.max(activeEvent.peak, conv);
          activeEvent.peakSev = Math.max(activeEvent.peakSev, sev);
          activeEvent.end = `${f.date} ${f.time}`;
        } else {
          activeEvent.end = `${f.date} ${f.time}`;
          events.push(activeEvent);
          activeEvent = null;
        }
      }
    }
    if (activeEvent) events.push(activeEvent);

    console.log(`\n[${bKey}] Total events detected: ${events.length}`);
    for (const ev of events) {
      console.log(`  • ${ev.start} -> ${ev.end || ev.start} (${ev.frames * 10} min) | Peak Rain: ${ev.peak.toFixed(1)}% | Peak Severe: ${ev.peakSev.toFixed(1)}%`);
    }
  }
}
