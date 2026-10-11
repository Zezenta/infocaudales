import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { BASIN_GEOMETRIES } from '../../data/basin-geometries.js';
import { db } from '../../utils/db.js';

function unfilterPngScanlines(raw: Buffer, width: number, height: number, bytesPerPixel: number): Buffer {
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
      if (filterType === 1) val = (byte + a) & 0xff;
      else if (filterType === 2) val = (byte + b) & 0xff;
      else if (filterType === 3) val = (byte + Math.floor((a + b) / 2)) & 0xff;
      else if (filterType === 4) {
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

function decodePng(buf: Buffer) {
  let offset = 8;
  let width = 0, height = 0, colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
      colorType = buf.readUInt8(offset + 17);
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(offset + 8, offset + 8 + len));
    } else if (type === 'IEND') break;
    offset += 12 + len;
  }

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = colorType === 6 ? 4 : 3;
  const pixels = unfilterPngScanlines(inflated, width, height, bpp);
  return { width, height, bpp, pixels };
}

function projectGeoToPixel(lat: number, lon: number, bbox: [number, number, number, number], width: number, height: number) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const x = Math.round(((lon - minLon) / (maxLon - minLon)) * width);
  const y = Math.round(((maxLat - lat) / (maxLat - minLat)) * height);
  return { x: Math.max(0, Math.min(width - 1, x)), y: Math.max(0, Math.min(height - 1, y)) };
}

async function analyze() {
  const rows = db.prepare('SELECT file_path, date_ecuador, time_ecuador, timestamp_iso FROM satellite_archive ORDER BY timestamp_iso ASC').all() as any[];
  console.log(`Analyzing ${rows.length} archived frames on disk...`);

  const ccsBbox = BASIN_GEOMETRIES.cocaCodoSinclair.bbox;
  const pauteBbox = BASIN_GEOMETRIES.paute.bbox;
  const ecuadorBbox = BASIN_GEOMETRIES.ecuador.bbox;

  // Let's sample frames across different times
  for (let idx = 0; idx < rows.length; idx += 10) {
    const row = rows[idx];
    if (!fs.existsSync(row.file_path)) continue;

    const buf = fs.readFileSync(row.file_path);
    const img = decodePng(buf);

    for (const basinKey of ['cocaCodoSinclair', 'paute']) {
      const bbox = basinKey === 'cocaCodoSinclair' ? ccsBbox : pauteBbox;
      const tl = projectGeoToPixel(bbox[3], bbox[0], ecuadorBbox, img.width, img.height);
      const br = projectGeoToPixel(bbox[1], bbox[2], ecuadorBbox, img.width, img.height);

      const minX = Math.min(tl.x, br.x);
      const maxX = Math.max(tl.x, br.x);
      const minY = Math.min(tl.y, br.y);
      const maxY = Math.max(tl.y, br.y);

      let totalPx = 0;
      let cyanPx = 0;      // -30°C to -40°C (light clouds)
      let greenPx = 0;     // -50°C to -60°C (moderate convective rain)
      let yellowPx = 0;    // -60°C to -70°C (strong convective rain)
      let redPx = 0;       // -70°C to -85°C (severe storm)
      let whiteCorePx = 0; // -85°C to -90°C (extreme convective core)

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          totalPx++;
          const pi = (y * img.width + x) * img.bpp;
          const r = img.pixels[pi];
          const g = img.pixels[pi + 1];
          const b = img.pixels[pi + 2];

          // Classify NOAA GOES-16 IR Band 13 thermal colors:
          // Cyan: R low, G high, B high
          if (b > 150 && g > 150 && r < 100) {
            cyanPx++;
          }
          // Deep Blue: B high, R low, G low
          else if (b > 100 && r < 60 && g < 60) {
            cyanPx++; // Cold cirrus / high cloud
          }
          // Green: G high, R low, B low
          else if (g > 150 && r < 120 && b < 100) {
            greenPx++;
          }
          // Yellow: R high, G high, B low
          else if (r > 180 && g > 180 && b < 100) {
            yellowPx++;
          }
          // Red / Crimson: R high, G low, B low
          else if (r > 140 && g < 80 && b < 80) {
            redPx++;
          }
          // White core inside cold zone: R > 200, G > 200, B > 200 with surrounding cold
          else if (r > 220 && g > 220 && b > 220) {
            whiteCorePx++;
          }
        }
      }

      const severeStormPct = ((redPx + whiteCorePx) / totalPx) * 100;
      const convectiveRainPct = ((greenPx + yellowPx + redPx + whiteCorePx) / totalPx) * 100;
      const totalColdPct = ((cyanPx + greenPx + yellowPx + redPx + whiteCorePx) / totalPx) * 100;

      if (convectiveRainPct > 2 || severeStormPct > 0.5) {
        console.log(`[${row.date_ecuador} ${row.time_ecuador}] ${basinKey.padEnd(16)} | Convective Rain (Grn+Yel+Red): ${convectiveRainPct.toFixed(1)}% | Severe (Red+Wht): ${severeStormPct.toFixed(1)}% | Thin Cirrus (Cyan/Blue): ${((cyanPx/totalPx)*100).toFixed(1)}% | Total: ${totalColdPct.toFixed(1)}%`);
      }
    }
  }
}

analyze().catch(console.error);
