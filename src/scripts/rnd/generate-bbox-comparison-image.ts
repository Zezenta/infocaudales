import { BASIN_GEOMETRIES } from '../../data/basin-geometries.js';
import { db } from '../../utils/db.js';
import fs from 'fs';
import { execFileSync } from 'child_process';

const row = db.prepare('SELECT file_path, timestamp_iso, date_ecuador, time_ecuador FROM satellite_archive ORDER BY timestamp_iso DESC LIMIT 1').get() as any;
if (!row) process.exit(1);

const nationalBbox = BASIN_GEOMETRIES.ecuador.bbox;
const width = 800;
const height = 800;

function projectGeoToPixel(lat: number, lon: number) {
  const [minLon, minLat, maxLon, maxLat] = nationalBbox;
  const x = Math.round(((lon - minLon) / (maxLon - minLon)) * width);
  const y = Math.round(((maxLat - lat) / (maxLat - minLat)) * height);
  return { x: Math.max(0, Math.min(width - 1, x)), y: Math.max(0, Math.min(height - 1, y)) };
}

const OLD_BOXES = {
  ccs: [-78.40, -0.80, -77.10, 0.50] as [number, number, number, number],
  paute: [-79.15, -3.15, -78.05, -2.05] as [number, number, number, number]
};

const NEW_BOXES = {
  ccs: BASIN_GEOMETRIES.cocaCodoSinclair.bbox,
  paute: BASIN_GEOMETRIES.paute.bbox
};

function renderBox(bbox: [number, number, number, number], color: string, isDashed: boolean, label: string, tagPlacement: 'top' | 'bottom' = 'top') {
  const tl = projectGeoToPixel(bbox[3], bbox[0]);
  const br = projectGeoToPixel(bbox[1], bbox[2]);
  const x = Math.min(tl.x, br.x);
  const y = Math.min(tl.y, br.y);
  const w = Math.abs(br.x - tl.x);
  const h = Math.abs(br.y - tl.y);

  const dashAttr = isDashed ? 'stroke-dasharray="8,6"' : '';
  const tagY = tagPlacement === 'top' ? y - 10 : y + h + 16;

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"
          fill="${color}" fill-opacity="${isDashed ? '0.04' : '0.15'}"
          stroke="${color}" stroke-width="${isDashed ? '2' : '3.5'}" ${dashAttr} />
    <rect x="${x}" y="${tagY - 14}" width="${label.length * 7 + 16}" height="20" rx="4"
          fill="#0b1120" fill-opacity="0.95" stroke="${color}" stroke-width="1.5" />
    <text x="${x + 8}" y="${tagY}" fill="${color}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="10.5">${label}</text>
  `;
}

const svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <!-- Top banner -->
  <rect x="0" y="0" width="${width}" height="64" fill="#04060c" fill-opacity="0.92" />
  <text x="24" y="32" fill="#ffffff" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="18">CALIBRACIÓN HIDROLÓGICA DE CAJAS DE CAPTACIÓN</text>
  <text x="24" y="52" fill="#94a3b8" font-family="DejaVu Sans, Arial, sans-serif" font-size="12">Línea discontinua amarilla: Box anterior (imprecisa)  |  Línea sólida: Cuenca aportante real</text>

  <!-- Old boxes (yellow dashed) -->
  ${renderBox(OLD_BOXES.ccs, '#facc15', true, '❌ CCS Anterior (-77.10 llega a Orellana)', 'top')}
  ${renderBox(OLD_BOXES.paute, '#facc15', true, '❌ Paute Anterior (corta Cajas, llega a Macas)', 'bottom')}

  <!-- New calibrated boxes (solid cyan / magenta) -->
  ${renderBox(NEW_BOXES.ccs, '#38bdf8', false, '✅ CCS Calibrada (Ríos Quijos/Salado/Coca)', 'bottom')}
  ${renderBox(NEW_BOXES.paute, '#c084fc', false, '✅ Paute Calibrada (Cajas + Embalses Mazar/Molino)', 'top')}

  <!-- Plant pins -->
  <circle cx="${projectGeoToPixel(-0.21, -77.70).x}" cy="${projectGeoToPixel(-0.21, -77.70).y}" r="6" fill="#ef4444" stroke="#ffffff" stroke-width="2" />
  <circle cx="${projectGeoToPixel(-2.58, -78.58).x}" cy="${projectGeoToPixel(-2.58, -78.58).y}" r="6" fill="#ef4444" stroke="#ffffff" stroke-width="2" />
</svg>
`;

const outPath = '/home/zezenta/.gemini/antigravity-cli/brain/6b1bfaaf-ca18-4138-bcdd-0de0981636ac/bbox_calibration_comparison.png';
fs.writeFileSync('/tmp/comp_raw.png', fs.readFileSync(row.file_path));
fs.writeFileSync('/tmp/comp_svg.svg', svg);

execFileSync('ffmpeg', [
  '-y',
  '-i', '/tmp/comp_raw.png',
  '-i', '/tmp/comp_svg.svg',
  '-filter_complex', '[0:v][1:v]overlay=0:0',
  '-frames:v', '1',
  '-update', '1',
  outPath
]);

console.log('Saved comparison to:', outPath);
