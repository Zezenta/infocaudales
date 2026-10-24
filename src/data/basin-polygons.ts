import fs from 'fs';
import path from 'path';

export type PolygonPoint = [number, number]; // [lon, lat]
export type BasinPolygonMap = Record<string, PolygonPoint[]>;

export interface BasinRasterMask {
  plantKey: string;
  width: number;
  height: number;
  nationalBbox: [number, number, number, number];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  boxW: number;
  boxH: number;
  mask: Uint8Array;
  totalPixels: number;
}

let cachedPolygons: BasinPolygonMap | null = null;
const rasterMaskCache = new Map<string, BasinRasterMask>();

/**
 * Resolves aliases to canonical hydrological polygon keys.
 */
export function resolveBasinKey(plantKey: string): string {
  const normalized = plantKey.trim().toLowerCase();
  if (normalized === 'coca' || normalized === 'cocacodosinclair' || normalized === 'ccs') {
    return 'cocaCodoSinclair';
  }
  if (normalized === 'paute' || normalized === 'mazar' || normalized === 'molino' || normalized === 'sopladora') {
    return 'paute';
  }
  if (normalized === 'agoyan' || normalized === 'pastaza') {
    return 'agoyan';
  }
  if (normalized === 'minassanfrancisco' || normalized === 'jubones' || normalized === 'msf') {
    return 'minasSanFrancisco';
  }
  return plantKey;
}

/**
 * Loads the official INAMHI / GeoServer WFS basin polygons from disk.
 */
export function loadBasinPolygons(): BasinPolygonMap {
  if (cachedPolygons) {
    return cachedPolygons;
  }

  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

  const candidates = [
    path.join(baseDir, 'basin-polygons.json'),
    path.join(baseDir, '..', 'data', 'basin-polygons.json'),
    path.join(process.cwd(), 'src', 'data', 'basin-polygons.json'),
    path.join(process.cwd(), 'dist', 'src', 'data', 'basin-polygons.json'),
    path.join(process.cwd(), 'data', 'basin-polygons.json')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf-8');
        cachedPolygons = JSON.parse(raw);
        return cachedPolygons!;
      } catch (err) {
        // Try next candidate
      }
    }
  }

  cachedPolygons = {};
  return cachedPolygons;
}

/**
 * Retrieves the polygon boundary points for a given hydroelectric plant basin.
 */
export function getBasinPolygon(plantKey: string): PolygonPoint[] | null {
  const polys = loadBasinPolygons();
  const canonicalKey = resolveBasinKey(plantKey);
  return polys[canonicalKey] || null;
}

/**
 * Fast ray-casting point-in-polygon algorithm.
 * Evaluates whether a coordinate (lon, lat) lies strictly inside the polygon boundary.
 */
export function isPointInPolygon(lon: number, lat: number, polygon: PolygonPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Precomputes and caches an optimized 2D raster bitmask for a basin polygon at a specific image resolution.
 * Memory footprint is minimal (~8-15 KB per basin), allowing sub-millisecond O(1) pixel checks.
 */
export function getBasinRasterMask(
  plantKey: string,
  width: number,
  height: number,
  nationalBbox: [number, number, number, number]
): BasinRasterMask | null {
  const canonicalKey = resolveBasinKey(plantKey);
  const cacheKey = `${canonicalKey}_${width}x${height}_${nationalBbox.join(',')}`;

  const cached = rasterMaskCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const polygon = getBasinPolygon(canonicalKey);
  if (!polygon || polygon.length < 3) {
    return null;
  }

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  for (const [x, y] of polygon) {
    if (x < minLon) minLon = x;
    if (x > maxLon) maxLon = x;
    if (y < minLat) minLat = y;
    if (y > maxLat) maxLat = y;
  }

  const [ecMinLon, ecMinLat, ecMaxLon, ecMaxLat] = nationalBbox;
  const lonSpan = ecMaxLon - ecMinLon;
  const latSpan = ecMaxLat - ecMinLat;

  const minX = Math.max(0, Math.floor(((minLon - ecMinLon) / lonSpan) * width));
  const maxX = Math.min(width - 1, Math.ceil(((maxLon - ecMinLon) / lonSpan) * width));
  const minY = Math.max(0, Math.floor(((ecMaxLat - maxLat) / latSpan) * height));
  const maxY = Math.min(height - 1, Math.ceil(((ecMaxLat - minLat) / latSpan) * height));

  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  const mask = new Uint8Array(boxW * boxH);
  let totalPixels = 0;

  for (let y = minY; y <= maxY; y++) {
    const lat = ecMaxLat - (y / height) * latSpan;
    const rowOffset = (y - minY) * boxW;
    for (let x = minX; x <= maxX; x++) {
      const lon = ecMinLon + (x / width) * lonSpan;
      if (isPointInPolygon(lon, lat, polygon)) {
        mask[rowOffset + (x - minX)] = 1;
        totalPixels++;
      }
    }
  }

  const result: BasinRasterMask = {
    plantKey: canonicalKey,
    width,
    height,
    nationalBbox,
    minX,
    maxX,
    minY,
    maxY,
    boxW,
    boxH,
    mask,
    totalPixels
  };

  rasterMaskCache.set(cacheKey, result);
  return result;
}
