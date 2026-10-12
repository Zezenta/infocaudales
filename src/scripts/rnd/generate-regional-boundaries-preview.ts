import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { BASIN_GEOMETRIES } from '../../data/basin-geometries.js';
import { db } from '../../utils/db.js';

async function main() {
  console.log('Generando imagen de delimitación de regiones Costa, Sierra y Amazonía...');

  // 1. Get latest or representative satellite frame from DB
  const row = db.prepare(`
    SELECT file_path, timestamp_iso, date_ecuador, time_ecuador 
    FROM satellite_archive 
    WHERE plant_key = 'ecuador' OR file_path LIKE '%ecuador%'
    ORDER BY timestamp_iso DESC 
    LIMIT 1
  `).get() as any;

  let baseFrameBuffer: Buffer;
  if (row && fs.existsSync(row.file_path)) {
    baseFrameBuffer = fs.readFileSync(row.file_path);
    console.log(`Usando fotograma satelital de archivo: ${row.file_path} (${row.date_ecuador} ${row.time_ecuador})`);
  } else {
    throw new Error('No se encontró un fotograma satelital en la base de datos.');
  }

  const nationalBbox = BASIN_GEOMETRIES.ecuador.bbox;
  const width = 800;
  const height = 800;

  function projectGeoToPixel(lat: number, lon: number) {
    const [minLon, minLat, maxLon, maxLat] = nationalBbox;
    const x = Math.round(((lon - minLon) / (maxLon - minLon)) * width);
    const y = Math.round(((maxLat - lat) / (maxLat - minLat)) * height);
    return { x: Math.max(0, Math.min(width - 1, x)), y: Math.max(0, Math.min(height - 1, y)) };
  }

  // 2. Definición de la línea divisoria occidental (Costa vs Sierra)
  const costaSierraDivide: Array<[number, number]> = [
    [-78.80, 1.45],  // Norte Mataje
    [-78.95, 0.85],  // Lita
    [-79.10, 0.10],  // Noroccidente Pichincha
    [-79.20, -0.30], // Santo Domingo oeste
    [-79.25, -0.95], // Quevedo / La Maná
    [-79.30, -1.45], // Ventanas / Echeandía
    [-79.38, -1.85], // Babahoyo / Montalvo
    [-79.48, -2.30], // Bucay / El Triunfo
    [-79.58, -2.75], // Naranjal / La Troncal
    [-79.68, -3.20], // Machala oriental
    [-79.82, -3.70], // Santa Rosa / Piñas
    [-79.98, -4.10], // Arenillas / Alamor
    [-80.20, -4.45], // Macará / Zapotillo
    [-80.45, -4.65], // Frontera sur costera
  ];

  // 3. Definición de la línea divisoria oriental (Sierra vs Amazonía)
  const sierraAmazoniaDivide: Array<[number, number]> = [
    [-77.55, 0.75],  // Norte Carchi / Sucumbíos
    [-77.85, -0.05], // Cayambe oriental / El Chaco
    [-77.95, -0.55], // Papallacta / Cosanga oriental
    [-78.05, -1.05], // Archidona / Tena occidental
    [-78.18, -1.45], // Baños / Puyo
    [-78.32, -2.05], // Sangay / Palora / Macas
    [-78.45, -2.85], // Paute oriental / Méndez
    [-78.60, -3.45], // Gualaquiza occidental
    [-78.85, -4.00], // Zamora occidental
    [-79.05, -4.65], // Zumba occidental
    [-79.15, -4.95], // Frontera sur oriental
  ];

  // 4. Polígonos de cada región
  // Costa: Desde el oeste (-81.30) hasta la divisoria Costa-Sierra
  const costaPolygonPoints: Array<[number, number]> = [
    [-81.35, 1.45],
    ...costaSierraDivide,
    [-81.35, -4.65],
  ];

  // Sierra: Entre la divisoria Costa-Sierra y la divisoria Sierra-Amazonía
  const sierraPolygonPoints: Array<[number, number]> = [
    ...costaSierraDivide,
    [-79.15, -4.95], // Empalme sur
    ...[...sierraAmazoniaDivide].reverse(),
    [-78.80, 1.45]  // Empalme norte
  ];

  // Amazonía: Desde la divisoria Sierra-Amazonía hacia el este (-75.10)
  const amazoniaPolygonPoints: Array<[number, number]> = [
    [-75.10, 0.75],
    ...sierraAmazoniaDivide,
    [-75.10, -4.95]
  ];

  function toSvgPoints(coords: Array<[number, number]>): string {
    return coords.map(([lon, lat]) => {
      const p = projectGeoToPixel(lat, lon);
      return `${p.x},${p.y}`;
    }).join(' ');
  }

  // Ciudades de referencia
  const cities = [
    // Costa
    { name: 'Guayaquil', lat: -2.19, lon: -79.89, reg: 'costa' },
    { name: 'Manta', lat: -0.95, lon: -80.72, reg: 'costa' },
    { name: 'Machala', lat: -3.26, lon: -79.96, reg: 'costa' },
    { name: 'Esmeraldas', lat: 0.97, lon: -79.65, reg: 'costa' },
    { name: 'Sto. Domingo', lat: -0.25, lon: -79.17, reg: 'costa' },
    // Sierra
    { name: 'Quito', lat: -0.18, lon: -78.47, reg: 'sierra' },
    { name: 'Cuenca', lat: -2.90, lon: -79.00, reg: 'sierra' },
    { name: 'Ambato', lat: -1.24, lon: -78.63, reg: 'sierra' },
    { name: 'Loja', lat: -4.00, lon: -79.20, reg: 'sierra' },
    { name: 'Tulcán', lat: 0.81, lon: -77.72, reg: 'sierra' },
    // Amazonía
    { name: 'El Coca', lat: -0.47, lon: -76.99, reg: 'amazonia' },
    { name: 'Lago Agrio', lat: 0.08, lon: -76.88, reg: 'amazonia' },
    { name: 'Tena', lat: -0.99, lon: -77.81, reg: 'amazonia' },
    { name: 'Puyo', lat: -1.48, lon: -77.99, reg: 'amazonia' },
    { name: 'Macas', lat: -2.31, lon: -78.12, reg: 'amazonia' }
  ];

  // Cuencas hidroeléctricas
  const ccsBbox = BASIN_GEOMETRIES.cocaCodoSinclair.bbox;
  const pauteBbox = BASIN_GEOMETRIES.paute.bbox;

  function renderBbox(bbox: [number, number, number, number], color: string, label: string) {
    const tl = projectGeoToPixel(bbox[3], bbox[0]);
    const br = projectGeoToPixel(bbox[1], bbox[2]);
    const x = Math.min(tl.x, br.x);
    const y = Math.min(tl.y, br.y);
    const w = Math.abs(br.x - tl.x);
    const h = Math.abs(br.y - tl.y);

    return `
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5"
            fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="2.5" stroke-dasharray="6,4" />
      <rect x="${x}" y="${y - 18}" width="${label.length * 6.5 + 14}" height="18" rx="3"
            fill="#090d16" fill-opacity="0.92" stroke="${color}" stroke-width="1.2" />
      <text x="${x + 7}" y="${y - 5}" fill="${color}" font-family="Space Grotesk, DejaVu Sans, sans-serif" font-weight="bold" font-size="9.5">${label}</text>
    `;
  }

  const svg = `
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <!-- Drop shadows for badges -->
      <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
        <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000000" flood-opacity="0.7"/>
      </filter>
    </defs>

    <!-- 1. Regional Shaded Polygons -->
    <!-- Costa: Amber tint -->
    <polygon points="${toSvgPoints(costaPolygonPoints)}"
             fill="#f59e0b" fill-opacity="0.16" stroke="#f59e0b" stroke-width="2.5" />

    <!-- Sierra: Cyan tint -->
    <polygon points="${toSvgPoints(sierraPolygonPoints)}"
             fill="#06b6d4" fill-opacity="0.18" stroke="#06b6d4" stroke-width="2.5" />

    <!-- Amazonía: Purple tint -->
    <polygon points="${toSvgPoints(amazoniaPolygonPoints)}"
             fill="#a855f7" fill-opacity="0.16" stroke="#a855f7" stroke-width="2.5" />

    <!-- 2. Boundary Lines between Regions (Dashed high-contrast) -->
    <polyline points="${costaSierraDivide.map(([lon, lat]) => `${projectGeoToPixel(lat, lon).x},${projectGeoToPixel(lat, lon).y}`).join(' ')}"
              fill="none" stroke="#ffffff" stroke-width="2.5" stroke-dasharray="8,5" />
    <polyline points="${sierraAmazoniaDivide.map(([lon, lat]) => `${projectGeoToPixel(lat, lon).x},${projectGeoToPixel(lat, lon).y}`).join(' ')}"
              fill="none" stroke="#ffffff" stroke-width="2.5" stroke-dasharray="8,5" />

    <!-- 3. Hydroelectric Basins for Context -->
    ${renderBbox(ccsBbox, '#38bdf8', 'Cuenca Coca Codo')}
    ${renderBbox(pauteBbox, '#e879f9', 'Complejo Paute')}

    <!-- 4. Reference City Markers -->
    ${cities.map(c => {
      const p = projectGeoToPixel(c.lat, c.lon);
      const color = c.reg === 'costa' ? '#fbbf24' : (c.reg === 'sierra' ? '#38bdf8' : '#c084fc');
      return `
        <circle cx="${p.x}" cy="${p.y}" r="3.5" fill="#ffffff" stroke="${color}" stroke-width="2" />
        <rect x="${p.x + 5}" y="${p.y - 8}" width="${c.name.length * 6 + 10}" height="14" rx="3"
              fill="#030712" fill-opacity="0.85" />
        <text x="${p.x + 9}" y="${p.y + 2.5}" fill="#f1f5f9" font-family="DejaVu Sans, Arial, sans-serif" font-size="8.5" font-weight="600">${c.name}</text>
      `;
    }).join('\n')}

    <!-- 5. Large Region Label Badges -->
    <!-- Badge Costa -->
    <g transform="translate(140, 360)" filter="url(#shadow)">
      <rect x="0" y="0" width="130" height="34" rx="6" fill="#1e1b4b" fill-opacity="0.90" stroke="#f59e0b" stroke-width="2" />
      <text x="65" y="16" fill="#fbbf24" font-family="Space Grotesk, DejaVu Sans, sans-serif" font-weight="bold" font-size="11.5" text-anchor="middle">REGIÓN COSTA</text>
      <text x="65" y="28" fill="#fde68a" font-family="DejaVu Sans, Arial, sans-serif" font-size="8.5" text-anchor="middle">(Litoral Pacífico)</text>
    </g>

    <!-- Badge Sierra -->
    <g transform="translate(325, 290)" filter="url(#shadow)">
      <rect x="0" y="0" width="135" height="34" rx="6" fill="#082f49" fill-opacity="0.90" stroke="#06b6d4" stroke-width="2" />
      <text x="67" y="16" fill="#38bdf8" font-family="Space Grotesk, DejaVu Sans, sans-serif" font-weight="bold" font-size="11.5" text-anchor="middle">REGIÓN SIERRA</text>
      <text x="67" y="28" fill="#bae6fd" font-family="DejaVu Sans, Arial, sans-serif" font-size="8.5" text-anchor="middle">(Cordillera / Interandina)</text>
    </g>

    <!-- Badge Amazonía -->
    <g transform="translate(565, 360)" filter="url(#shadow)">
      <rect x="0" y="0" width="145" height="34" rx="6" fill="#3b0764" fill-opacity="0.90" stroke="#a855f7" stroke-width="2" />
      <text x="72" y="16" fill="#c084fc" font-family="Space Grotesk, DejaVu Sans, sans-serif" font-weight="bold" font-size="11.5" text-anchor="middle">REGIÓN AMAZÓNICA</text>
      <text x="72" y="28" fill="#e9d5ff" font-family="DejaVu Sans, Arial, sans-serif" font-size="8.5" text-anchor="middle">(Vertiente Oriental)</text>
    </g>

    <!-- 6. Top Header Banner -->
    <rect x="0" y="0" width="${width}" height="68" fill="#04060c" fill-opacity="0.94" />
    <rect x="0" y="66" width="${width}" height="2" fill="#3b82f6" />
    <text x="24" y="28" fill="#ffffff" font-family="Space Grotesk, DejaVu Sans, sans-serif" font-weight="bold" font-size="16" letter-spacing="0.5">PROPUESTA DE DELIMITACIÓN REGIONAL PARA ANÁLISIS DE LLUVIAS</text>
    <text x="24" y="50" fill="#94a3b8" font-family="DejaVu Sans, Arial, sans-serif" font-size="11.5">Delimitación orográfica: Costa (Litoral) • Sierra (Andina) • Amazonía (Oriente) con cuencas hidroeléctricas</text>

    <!-- 7. Bottom Legend -->
    <rect x="16" y="${height - 48}" width="${width - 32}" height="36" rx="6" fill="#030712" fill-opacity="0.92" stroke="#1f2937" stroke-width="1.5" />
    <circle cx="36" cy="${height - 30}" r="6" fill="#f59e0b" />
    <text x="48" y="${height - 26}" fill="#f1f5f9" font-family="DejaVu Sans, Arial, sans-serif" font-size="10" font-weight="bold">Costa</text>

    <circle cx="120" cy="${height - 30}" r="6" fill="#06b6d4" />
    <text x="132" y="${height - 26}" fill="#f1f5f9" font-family="DejaVu Sans, Arial, sans-serif" font-size="10" font-weight="bold">Sierra</text>

    <circle cx="205" cy="${height - 30}" r="6" fill="#a855f7" />
    <text x="217" y="${height - 26}" fill="#f1f5f9" font-family="DejaVu Sans, Arial, sans-serif" font-size="10" font-weight="bold">Amazonía</text>

    <line x1="310" y1="${height - 30}" x2="340" y2="${height - 30}" stroke="#ffffff" stroke-width="2" stroke-dasharray="6,4" />
    <text x="348" y="${height - 26}" fill="#94a3b8" font-family="DejaVu Sans, Arial, sans-serif" font-size="10">Divisoria Orográfica</text>

    <rect x="500" y="${height - 36}" width="14" height="12" rx="2" fill="none" stroke="#38bdf8" stroke-width="2" stroke-dasharray="4,2" />
    <text x="522" y="${height - 26}" fill="#38bdf8" font-family="DejaVu Sans, Arial, sans-serif" font-size="10" font-weight="bold">Cuenca CCS</text>

    <rect x="635" y="${height - 36}" width="14" height="12" rx="2" fill="none" stroke="#e879f9" stroke-width="2" stroke-dasharray="4,2" />
    <text x="657" y="${height - 26}" fill="#e879f9" font-family="DejaVu Sans, Arial, sans-serif" font-size="10" font-weight="bold">Cuenca Paute</text>
  </svg>
  `;

  const artifactDir = '/home/zezenta/.gemini/antigravity-cli/brain/6b1bfaaf-ca18-4138-bcdd-0de0981636ac';
  const outPath = path.join(artifactDir, 'delimitacion_regiones_costa_sierra_amazonia.png');
  const tempRaw = '/tmp/reg_raw.png';
  const tempSvg = '/tmp/reg_svg.svg';

  fs.writeFileSync(tempRaw, baseFrameBuffer);
  fs.writeFileSync(tempSvg, svg);

  execFileSync('ffmpeg', [
    '-y',
    '-i', tempRaw,
    '-i', tempSvg,
    '-filter_complex', '[0:v][1:v]overlay=0:0',
    '-frames:v', '1',
    '-update', '1',
    outPath
  ]);

  console.log(`✅ Imagen generada exitosamente en: ${outPath}`);
}

main().catch(err => {
  console.error('Error al generar delimitación:', err);
  process.exit(1);
});
