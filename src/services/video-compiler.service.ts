import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BASIN_GEOMETRIES, BasinGeometry, ALL_HYDRO_PLANTS_PINS, PlantPin, DEFAULT_REFERENCE_CITIES, CityPin } from '../data/basin-geometries.js';
import { SatelliteFrame, SatelliteMapService } from './satellite-map.service.js';
import { systemLogger } from '../utils/logger.js';
import { db } from '../utils/db.js';

const execFileAsync = promisify(execFile);

/**
 * Escapes characters with special meaning in XML/SVG to prevent parse failures or injection.
 */
export function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface MonitoredBasinBox {
  key: string;
  label: string;
  bbox: [number, number, number, number];
  defaultColor?: string;
}

export interface StormWindow {
  startTime?: string | number; // ISO string or epoch ms
  endTime?: string | number;   // ISO string or epoch ms
  startFrameIndex?: number;    // 0-based frame index where storm mode begins
  endFrameIndex?: number;      // 0-based frame index where storm mode ends
}

export interface OverlayCustomizationOptions {
  customTitle?: string;
  customBadge?: string;
  showAllPins?: boolean;
  showSinglePin?: boolean;
  singlePinLabel?: string;
  showThermalScale?: boolean;
  showDetectionBoxes?: boolean;
  highlightBasinKey?: string;
  activeBasinKeys?: string[] | Set<string>;
  customMonitoredBasins?: MonitoredBasinBox[];
  showPublicationStatusBadge?: boolean;
  stormWindow?: StormWindow;
  activeBasinResolver?: (frame: SatelliteFrame, index: number) => Set<string> | string[];
  customDateSubtitle?: string;
  showCityPins?: boolean;
  cityPins?: CityPin[];
  summaryCardItems?: BasinSummaryCardItem[];
  summaryCardsResolver?: (frame: SatelliteFrame, index: number) => DynamicSummaryCards;
  layer?: string;
  layers?: string | string[];
}

export interface DynamicSummaryCards {
  basins?: Array<{ label: string; value: string; color?: string; highlight?: boolean }>;
  regions?: Array<{ label: string; value: string; color?: string; highlight?: boolean }>;
}

export interface BasinSummaryCardItem {
  label: string;
  peakPct: number;
  hasRain: boolean;
  color?: string;
}

export interface CompileOptions extends OverlayCustomizationOptions {
  plantKey?: string;
  outputDir?: string;
  outputName?: string;
  framerate?: number;
  width?: number;
  height?: number;
  createMp4?: boolean;
  createGif?: boolean;
  gifScale?: number;
  minDurationSeconds?: number;
}

export interface CompiledAnimationResult {
  plantKey: string;
  mp4Path?: string;
  gifPath?: string;
  frameCount: number;
  durationSeconds: number;
  sizeBytesMp4?: number;
  sizeBytesGif?: number;
  timestamps: {
    start: string;
    end: string;
    startEcuador: string;
    endEcuador: string;
  };
}

export interface GenerateBasinVideoOptions extends CompileOptions {
  plantKey?: string;
  bbox?: [number, number, number, number];
  hoursBack?: number;
  frameCount?: number;
  source?: 'geoserver' | 'nasa_gibs' | 'esri_satellite';
}

export class VideoCompilerService {
  constructor(private readonly satelliteMapService: SatelliteMapService = new SatelliteMapService()) {}

  /**
   * Translates geographic (lat, lon) coordinates inside a bounding box to pixel coordinates (x, y).
   */
  public projectGeoToPixel(
    lat: number,
    lon: number,
    bbox: [number, number, number, number],
    width: number,
    height: number
  ): { x: number; y: number } {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const lonSpan = maxLon - minLon;
    const latSpan = maxLat - minLat;

    const x = Math.round(((lon - minLon) / lonSpan) * width);
    // Y coordinate is inverted (maxLat is top/0, minLat is bottom/height)
    const y = Math.round(((maxLat - lat) / latSpan) * height);

    return { x, y };
  }

  /**
   * Helper to estimate exact Space Grotesk text width in pixels.
   */
  public estimateTextWidth(text: string, fontSize: number = 10): number {
    let width = 0;
    for (const char of text) {
      if ('WM@%#'.includes(char)) width += fontSize * 0.90;
      else if ('ABCDEFGHNOPQRSTUVXYZ'.includes(char)) width += fontSize * 0.70;
      else if ('mw'.includes(char)) width += fontSize * 0.76;
      else if ('ijltfrI1 '.includes(char)) width += fontSize * 0.38;
      else if ('0123456789'.includes(char)) width += fontSize * 0.60;
      else width += fontSize * 0.56;
    }
    return Math.ceil(width);
  }

  /**
   * Generates a modern, clean SVG overlay with badges, plant pin, and timestamps.
   */
  public generateSvgOverlay(options: OverlayCustomizationOptions & {
    frame: SatelliteFrame;
    geometry: BasinGeometry;
    width: number;
    height: number;
  }): string {
    const { frame, geometry, width, height } = options;
    const title = escapeXml(options.customTitle || 'Vista Satelital En Vivo');

    const subtitleBadge = escapeXml(options.customBadge || (geometry.key === 'ecuador'
      ? 'GOES-16 • Banda 13 IR (10.3 µm)'
      : (geometry.subtitle || 'GOES-16 • Banda 13 IR')));

    // Render Basin Storm Detection Boundary Boxes when displaying Ecuador Continental
    let detectionBoxesSvg = '';
    const showDetectionBoxes = options.showDetectionBoxes !== false && (geometry.key === 'ecuador' || frame.plantKey === 'ecuador');
    if (showDetectionBoxes) {
      const monitoredBasins = options.customMonitoredBasins || [
        { key: 'cocaCodoSinclair', label: 'Cuenca Coca Codo Sinclair', bbox: BASIN_GEOMETRIES.cocaCodoSinclair.bbox, defaultColor: '#38bdf8' },
        { key: 'paute', label: 'Complejo Hidroeléctrico Paute', bbox: BASIN_GEOMETRIES.paute.bbox, defaultColor: '#a855f7' }
      ];

      for (const b of monitoredBasins) {
        const isHighlighted = options.highlightBasinKey === b.key;
        const isActiveStorm = options.activeBasinKeys !== undefined
          ? (options.activeBasinKeys instanceof Set ? options.activeBasinKeys.has(b.key) : options.activeBasinKeys.includes(b.key))
          : isHighlighted;

        const frameIndex = frame.index !== undefined ? frame.index : 0;

        let color: string;
        let strokeWidth: number;
        let strokeDash: string;
        let shadowStrokeWidth: number;
        let fillOpacity: number;
        let cornerLen: number;
        let cornerStroke: number;
        let tagBg: string;
        let tagBorder: string;
        let tagBorderWidth: number;
        let dotSvg: string;

        const tl = this.projectGeoToPixel(b.bbox[3], b.bbox[0], frame.bbox, width, height);
        const br = this.projectGeoToPixel(b.bbox[1], b.bbox[2], frame.bbox, width, height);
        const boxX = Math.min(tl.x, br.x);
        const boxY = Math.min(tl.y, br.y);
        const boxW = Math.abs(br.x - tl.x);
        const boxH = Math.abs(br.y - tl.y);

        const tagText = isActiveStorm ? `ACTIVIDAD LLUVIOSA • ${b.label}` : b.label;
        const tagW = this.estimateTextWidth(tagText, 11) + 26;
        const tagH = 22;
        const tagY = (boxY - tagH - 4 < 70) ? boxY + 6 : boxY - tagH - 4;
        const textY = tagY + 15;

        if (isActiveStorm) {
          // Calm, authoritative breathing beacon pulse (1.0 second per cycle at 8 fps)
          // Smooth sine modulation avoids jerky toggling or feeling like a malfunctioning sensor
          const pulseNorm = (Math.sin((frameIndex * 2 * Math.PI) / 8) + 1) / 2; // 0.0 to 1.0 smoothly

          color = '#ef4444';
          strokeWidth = parseFloat((4.0 + 2.2 * pulseNorm).toFixed(1));
          strokeDash = '10,5'; // Stable dash pattern to prevent jumping/jittering borders
          shadowStrokeWidth = parseFloat((7.0 + 4.0 * pulseNorm).toFixed(1));
          fillOpacity = parseFloat((0.16 + 0.12 * pulseNorm).toFixed(2)); // Always visibly tinted (never looks turned off)
          cornerLen = Math.round(18 + 5 * pulseNorm);
          cornerStroke = parseFloat((5.0 + 2.5 * pulseNorm).toFixed(1));
          tagBg = '#991b1b';
          tagBorder = pulseNorm > 0.4 ? '#ff4444' : '#ef4444';
          tagBorderWidth = 2.0;

          const beaconHaloR = (5.2 + 2.3 * pulseNorm).toFixed(1);
          const beaconHaloOpacity = (0.40 + 0.35 * pulseNorm).toFixed(2);
          dotSvg = `<circle cx="${boxX + 11}" cy="${tagY + 11}" r="${beaconHaloR}" fill="#ff4444" fill-opacity="${beaconHaloOpacity}" />
                   <circle cx="${boxX + 11}" cy="${tagY + 11}" r="3.2" fill="#ffffff" />`;
        } else {
          // Normal monitoring state
          color = b.key === 'cocaCodoSinclair' ? '#38bdf8' : '#a855f7';
          strokeWidth = 2.0;
          strokeDash = '7,4';
          shadowStrokeWidth = 4.5;
          fillOpacity = 0.08;
          cornerLen = 12;
          cornerStroke = 3.0;
          tagBg = '#0b1120';
          tagBorder = color;
          tagBorderWidth = 1.5;

          dotSvg = `<circle cx="${boxX + 11}" cy="${tagY + 11}" r="3.5" fill="${color}" />`;
        }

        detectionBoxesSvg += `
        <g id="detection-box-${b.key}">
          <!-- Semi-transparent colored basin area fill -->
          <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="6"
                fill="${color}" fill-opacity="${fillOpacity}" />

          <!-- Dark shadow underlay for maximum contrast against clouds -->
          <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="6"
                fill="none" stroke="#000000" stroke-width="${shadowStrokeWidth}" stroke-opacity="0.90" />

          <!-- High-visibility dashed boundary (substantially thickened during storm) -->
          <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="6"
                fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-dasharray="${strokeDash}" />

          <!-- Corner reinforcement brackets -->
          <path d="M ${boxX} ${boxY + cornerLen} L ${boxX} ${boxY} L ${boxX + cornerLen} ${boxY}
                   M ${boxX + boxW - cornerLen} ${boxY} L ${boxX + boxW} ${boxY} L ${boxX + boxW} ${boxY + cornerLen}
                   M ${boxX} ${boxY + boxH - cornerLen} L ${boxX} ${boxY + boxH} L ${boxX + cornerLen} ${boxY + boxH}
                   M ${boxX + boxW - cornerLen} ${boxY + boxH} L ${boxX + boxW} ${boxY + boxH} L ${boxX + boxW} ${boxY + boxH - cornerLen}"
                fill="none" stroke="${color}" stroke-width="${cornerStroke}" stroke-linecap="round" stroke-linejoin="round" />

          <!-- Tag Badge -->
          <rect x="${boxX}" y="${tagY}" width="${tagW}" height="${tagH}" rx="5"
                fill="${tagBg}" fill-opacity="0.96" stroke="${tagBorder}" stroke-width="${tagBorderWidth}" />
          ${dotSvg}
          <text x="${boxX + 20}" y="${textY}" fill="#ffffff" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="11">${escapeXml(tagText)}</text>
        </g>
        `;
      }
    }

    // Determine pins to render according to browser toggle state
    const pinsToRender: PlantPin[] = [];
    const showAllPins = options.showAllPins !== undefined ? options.showAllPins : (geometry.key === 'ecuador' || geometry.key === 'paute');
    const showSinglePin = options.showSinglePin !== undefined ? options.showSinglePin : (geometry.key !== 'ecuador' && geometry.key !== 'paute');

    if (showAllPins) {
      for (const p of ALL_HYDRO_PLANTS_PINS) {
        if (p.lon >= frame.bbox[0] && p.lat >= frame.bbox[1] && p.lon <= frame.bbox[2] && p.lat <= frame.bbox[3]) {
          pinsToRender.push(p);
        }
      }
    } else if (showSinglePin && geometry.plantLocation) {
      const singlePin = { ...geometry.plantLocation };
      if (options.singlePinLabel) {
        singlePin.label = options.singlePinLabel;
      }
      pinsToRender.push(singlePin);
    }

    let pinsSvg = '';
    for (const pin of pinsToRender) {
      const { x, y } = this.projectGeoToPixel(pin.lat, pin.lon, frame.bbox, width, height);
      if (x >= -10 && x <= width + 10 && y >= -10 && y <= height + 10) {
        const padX = 8;
        const textWidth = this.estimateTextWidth(pin.label, 12);
        const boxWidth = textWidth + (padX * 2);
        let boxX = 9;
        let boxY = -12;
        let textX = 9 + padX;
        let textY = 4.5;

        if (pin.placement === 'top-left') {
          boxX = -boxWidth - 9;
          boxY = -24;
          textX = -boxWidth - 9 + padX;
          textY = -7.5;
        } else if (pin.placement === 'bottom-left') {
          boxX = -boxWidth - 9;
          boxY = 8;
          textX = -boxWidth - 9 + padX;
          textY = 24.5;
        } else if (pin.placement === 'top-right') {
          boxX = 9;
          boxY = -28;
          textX = 9 + padX;
          textY = -11.5;
        } else if (pin.placement === 'bottom-right') {
          boxX = 9;
          boxY = 8;
          textX = 9 + padX;
          textY = 24.5;
        }

        const color = pin.label.includes('CCS') || pin.label.includes('Coca') ? '#ef4444' : '#38bdf8';
        const safePinLabel = escapeXml(pin.label);

        pinsSvg += `
        <g transform="translate(${x}, ${y})">
          <circle cx="0" cy="0" r="10" fill="${color}" fill-opacity="0.25" />
          <circle cx="0" cy="0" r="5.5" fill="${color}" stroke="#ffffff" stroke-width="1.5" />
          <rect x="${boxX}" y="${boxY}" width="${boxWidth}" height="24" rx="5" fill="#0b1120" fill-opacity="0.94" stroke="${color}" stroke-width="1.2" />
          <text x="${textX}" y="${textY}" fill="#f8fafc" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="12">${safePinLabel}</text>
        </g>
        `;
      }
    }

    // Render Reference City Pins if enabled (specifically for Ecuador 24h timelapse)
    let citiesSvg = '';
    const showCityPins = options.showCityPins === true;
    if (showCityPins) {
      const citiesToRender = options.cityPins || DEFAULT_REFERENCE_CITIES;
      for (const city of citiesToRender) {
        if (city.lon >= frame.bbox[0] && city.lat >= frame.bbox[1] && city.lon <= frame.bbox[2] && city.lat <= frame.bbox[3]) {
          const { x, y } = this.projectGeoToPixel(city.lat, city.lon, frame.bbox, width, height);
          if (x >= -10 && x <= width + 10 && y >= -10 && y <= height + 10) {
            const padX = 6;
            const textWidth = this.estimateTextWidth(city.label, 9.5);
            const boxWidth = textWidth + (padX * 2);
            const boxHeight = 17;
            let boxX = 6;
            let boxY = -8.5;
            let textX = 6 + padX;
            let textY = 4;

            if (city.placement === 'left') {
              boxX = -boxWidth - 6;
              boxY = -8.5;
              textX = -boxWidth - 6 + padX;
              textY = 4;
            } else if (city.placement === 'top-left') {
              boxX = -boxWidth - 6;
              boxY = -18;
              textX = -boxWidth - 6 + padX;
              textY = -5.5;
            } else if (city.placement === 'top-right' || city.placement === 'top') {
              boxX = 6;
              boxY = -18;
              textX = 6 + padX;
              textY = -5.5;
            } else if (city.placement === 'bottom-left' || city.placement === 'bottom') {
              boxX = -boxWidth - 6;
              boxY = 6;
              textX = -boxWidth - 6 + padX;
              textY = 18.5;
            } else if (city.placement === 'bottom-right') {
              boxX = 6;
              boxY = 6;
              textX = 6 + padX;
              textY = 18.5;
            }

            const safeCityLabel = escapeXml(city.label);
            citiesSvg += `
            <g transform="translate(${x}, ${y})">
              <!-- Subtle city locator dot -->
              <circle cx="0" cy="0" r="4.5" fill="#ffffff" fill-opacity="0.30" />
              <circle cx="0" cy="0" r="2.5" fill="#ffffff" stroke="#0f172a" stroke-width="0.8" />
              <!-- Compact clean city pill badge -->
              <rect x="${boxX}" y="${boxY}" width="${boxWidth}" height="${boxHeight}" rx="3.5"
                    fill="#030712" fill-opacity="0.88" stroke="rgba(255, 255, 255, 0.28)" stroke-width="0.8" />
              <text x="${textX}" y="${textY}" fill="#f8fafc" font-family="'Space Grotesk', 'DejaVu Sans', sans-serif" font-weight="600" font-size="9.5">${safeCityLabel}</text>
            </g>
            `;
          }
        }
      }
    }

    const badgeText = subtitleBadge;
    const badgeTextWidth = this.estimateTextWidth(badgeText, 11.5);
    const badgeTotalWidth = badgeTextWidth + 32;
    const badgeX = width - badgeTotalWidth - 20;

    const showThermalScale = options.showThermalScale !== false;
    const thermalScaleSvg = showThermalScale
      ? `
      <!-- Floating Thermal Scale Bar Overlay -->
      <g transform="translate(20, ${height - 116})">
        <rect x="0" y="0" width="230" height="42" rx="7" fill="#0b1120" fill-opacity="0.92" stroke="rgba(255, 255, 255, 0.12)" stroke-width="1" />
        <text x="10" y="14" fill="#94a3b8" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="9.5" letter-spacing="0.04em">ESCALA TÉRMICA IR (°C)</text>
        <rect x="10" y="19" width="210" height="7" rx="3.5" fill="url(#thermalScaleGrad)" stroke="rgba(0,0,0,0.4)" stroke-width="0.5"/>
        <text x="10" y="37" fill="#94a3b8" font-family="'DejaVu Sans Mono', monospace" font-size="8.5" font-weight="600">+10°</text>
        <text x="88" y="37" fill="#00FFFF" font-family="'DejaVu Sans Mono', monospace" font-size="8.5" font-weight="600">-30°</text>
        <text x="132" y="37" fill="#2EFF00" font-family="'DejaVu Sans Mono', monospace" font-size="8.5" font-weight="600">-50°</text>
        <text x="172" y="37" fill="#FF0000" font-family="'DejaVu Sans Mono', monospace" font-size="8.5" font-weight="600">-70°</text>
        <text x="196" y="37" fill="#FFFFFF" font-family="'DejaVu Sans Mono', monospace" font-size="8.5" font-weight="600">-90°C</text>
      </g>
      `
      : '';

    const safeTimestamp = escapeXml(`${frame.dateEcuador}  ${frame.timeEcuador} ECT`);

    const showPublicationBadge = options.showPublicationStatusBadge === true;
    let pubStatusSvg = '';
    if (showPublicationBadge) {
      const isAnyActive = (options.activeBasinKeys && (options.activeBasinKeys instanceof Set ? options.activeBasinKeys.size > 0 : options.activeBasinKeys.length > 0)) || Boolean(options.highlightBasinKey);
      if (isAnyActive) {
        pubStatusSvg = `
        <g transform="translate(20, 44)">
          <rect x="0" y="0" width="300" height="24" rx="5" fill="#7f1d1d" fill-opacity="0.95" stroke="#ef4444" stroke-width="1.2" />
          <circle cx="12" cy="12" r="5" fill="#ef4444" />
          <circle cx="12" cy="12" r="2.5" fill="#ffffff" />
          <text x="24" y="16.5" fill="#ffffff" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="11">ALERTA DISPARADA • SEGMENTO DE PUBLICACIÓN</text>
        </g>
        `;
      } else {
        pubStatusSvg = `
        <g transform="translate(20, 44)">
          <rect x="0" y="0" width="210" height="24" rx="5" fill="#064e3b" fill-opacity="0.92" stroke="#10b981" stroke-width="1" />
          <circle cx="12" cy="12" r="4.5" fill="#10b981" />
          <text x="24" y="16.5" fill="#a7f3d0" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="11">CONDICIÓN NORMAL • SIN ALERTA</text>
        </g>
        `;
      }
    }
    // Render Lower-Right Summary Cards (Cuencas and Regiones)
    let summaryCardSvg = '';
    const dynamicCards = options.summaryCardsResolver
      ? options.summaryCardsResolver(frame, frame.index || 0)
      : undefined;

    const basinsList = dynamicCards?.basins || (options.summaryCardItems ? options.summaryCardItems.map(b => ({
      label: b.label,
      value: `${b.peakPct.toFixed(1)}%`,
      color: b.color || '#38bdf8',
      highlight: b.hasRain
    })) : undefined);

    const regionsList = dynamicCards?.regions;

    const cardW = 228;
    const cardX = width - cardW - 20;

    let card2H = 0;
    let card2Y = 0;
    let card1H = 0;
    let card1Y = 0;

    if (regionsList && regionsList.length > 0) {
      card2H = 22 + regionsList.length * 24 + 6;
      card2Y = height - 60 - 12 - card2H;
    }

    if (basinsList && basinsList.length > 0) {
      card1H = 22 + basinsList.length * 24 + 6;
      card1Y = card2Y > 0 ? (card2Y - 8 - card1H) : (height - 60 - 12 - card1H);
    }

    // Build Card 1: Cuencas Hidroeléctricas
    let card1Svg = '';
    if (basinsList && basinsList.length > 0) {
      let rowsSvg = '';
      for (let idx = 0; idx < basinsList.length; idx++) {
        const item = basinsList[idx];
        const rowY = 34 + idx * 24;
        const color = item.color || '#38bdf8';
        const valColor = item.highlight ? '#f87171' : '#cbd5e1';

        rowsSvg += `
        <circle cx="12" cy="${rowY}" r="3.2" fill="${color}" />
        <text x="21" y="${rowY + 3.5}" fill="#f1f5f9" font-family="'Space Grotesk', sans-serif" font-weight="600" font-size="10.5">${escapeXml(item.label)}</text>
        <text x="${cardW - 12}" y="${rowY + 3.5}" fill="${valColor}" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="11.5" text-anchor="end">${escapeXml(item.value)}</text>
        `;
      }

      card1Svg = `
      <g transform="translate(${cardX}, ${card1Y})">
        <rect x="0" y="0" width="${cardW}" height="${card1H}" rx="7"
              fill="#0b1120" fill-opacity="0.93" stroke="rgba(255, 255, 255, 0.14)" stroke-width="1" />
        <rect x="0" y="0" width="${cardW}" height="22" rx="7" fill="#1e293b" fill-opacity="0.75" />
        <circle cx="12" cy="11" r="3.2" fill="#38bdf8" />
        <text x="21" y="14.5" fill="#94a3b8" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="9" letter-spacing="0.05em">CUENCAS HIDROELÉCTRICAS</text>
        <line x1="0" y1="22" x2="${cardW}" y2="22" stroke="rgba(255, 255, 255, 0.08)" stroke-width="1" />
        ${rowsSvg}
      </g>
      `;
    }

    // Build Card 2: Cobertura por Región
    let card2Svg = '';
    if (regionsList && regionsList.length > 0) {
      let rowsSvg = '';
      for (let idx = 0; idx < regionsList.length; idx++) {
        const item = regionsList[idx];
        const rowY = 34 + idx * 24;
        const color = item.color || '#38bdf8';
        const valColor = item.highlight ? '#f87171' : '#cbd5e1';

        rowsSvg += `
        <circle cx="12" cy="${rowY}" r="3.2" fill="${color}" />
        <text x="21" y="${rowY + 3.5}" fill="#f1f5f9" font-family="'Space Grotesk', sans-serif" font-weight="600" font-size="10.5">${escapeXml(item.label)}</text>
        <text x="${cardW - 12}" y="${rowY + 3.5}" fill="${valColor}" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="11.5" text-anchor="end">${escapeXml(item.value)}</text>
        `;
      }

      card2Svg = `
      <g transform="translate(${cardX}, ${card2Y})">
        <rect x="0" y="0" width="${cardW}" height="${card2H}" rx="7"
              fill="#0b1120" fill-opacity="0.93" stroke="rgba(255, 255, 255, 0.14)" stroke-width="1" />
        <rect x="0" y="0" width="${cardW}" height="22" rx="7" fill="#1e293b" fill-opacity="0.75" />
        <circle cx="12" cy="11" r="3.2" fill="#f59e0b" />
        <text x="21" y="14.5" fill="#94a3b8" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="9" letter-spacing="0.05em">POR REGIÓN</text>
        <line x1="0" y1="22" x2="${cardW}" y2="22" stroke="rgba(255, 255, 255, 0.08)" stroke-width="1" />
        ${rowsSvg}
      </g>
      `;
    }

    summaryCardSvg = `${card1Svg}\n${card2Svg}`;

    return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          @font-face {
            font-family: 'Space Grotesk';
            src: url('/fonts/SpaceGrotesk-Variable.ttf') format('truetype');
            font-weight: 100 900;
          }
        </style>
        <linearGradient id="topBarGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#04060c" stop-opacity="0.98"/>
          <stop offset="65%" stop-color="#04060c" stop-opacity="0.94"/>
          <stop offset="100%" stop-color="#04060c" stop-opacity="0.0"/>
        </linearGradient>
        <linearGradient id="bottomBarGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#04060c" stop-opacity="0.0"/>
          <stop offset="35%" stop-color="#04060c" stop-opacity="0.94"/>
          <stop offset="100%" stop-color="#04060c" stop-opacity="0.98"/>
        </linearGradient>
        <linearGradient id="thermalScaleGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#262626"/>
          <stop offset="10%" stop-color="#404040"/>
          <stop offset="35%" stop-color="#808080"/>
          <stop offset="40%" stop-color="#00FFFF"/>
          <stop offset="50%" stop-color="#000073"/>
          <stop offset="60%" stop-color="#2EFF00"/>
          <stop offset="70%" stop-color="#FFFF00"/>
          <stop offset="80%" stop-color="#FF0000"/>
          <stop offset="85%" stop-color="#921313"/>
          <stop offset="100%" stop-color="#FFFFFF"/>
        </linearGradient>
      </defs>

      <!-- Header Top Bar -->
      <rect x="0" y="0" width="${width}" height="${options.customDateSubtitle ? 78 : (showPublicationBadge ? 92 : 68)}" fill="url(#topBarGrad)"/>
      <text x="20" y="${options.customDateSubtitle ? 31 : (showPublicationBadge ? 34 : 38)}" fill="#ffffff" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="${options.customDateSubtitle ? 18 : 20}">${title}</text>
      ${options.customDateSubtitle ? `<text x="20" y="52" fill="#cbd5e1" font-family="'Space Grotesk', sans-serif" font-weight="500" font-size="12.5">${escapeXml(options.customDateSubtitle)}</text>` : ''}
      ${pubStatusSvg}
      
      <!-- Top Right Watermark strictly identical to Telemetry & Forecast Cards -->
      <g transform="translate(${width - 180}, 18)">
        <!-- X Icon Box: 24x24, solid black bg, subtle border -->
        <rect x="0" y="0" width="24" height="24" rx="4.5" fill="#000000" stroke="rgba(255, 255, 255, 0.2)" stroke-width="1"/>
        <g transform="translate(5, 5)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="#ffffff">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
          </svg>
        </g>
        <!-- Handle Text in high contrast Space Grotesk -->
        <text x="32" y="17" fill="#cbd5e1" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="16">@Hidro_Info_Bot</text>
      </g>

      <!-- Basin Storm Detection Boundary Boxes -->
      ${detectionBoxesSvg}

      <!-- Plant Pin Markers -->
      ${pinsSvg}

      <!-- Reference City Pin Markers -->
      ${citiesSvg}

      <!-- Lower-Right 24h Summary Card -->
      ${summaryCardSvg}

      ${thermalScaleSvg}

      <!-- Footer Bottom Bar -->
      <rect x="0" y="${height - 60}" width="${width}" height="60" fill="url(#bottomBarGrad)"/>
      <circle cx="30" cy="${height - 30}" r="7" fill="#22c55e" />
      <text x="46" y="${height - 24}" fill="#f8fafc" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="17">${safeTimestamp}</text>
      
      <!-- Subtitle Pill Badge on Bottom Right -->
      <g transform="translate(${badgeX}, ${height - 46})">
        <rect x="0" y="0" width="${badgeTotalWidth}" height="28" rx="6" fill="#0b1120" fill-opacity="0.92" stroke="rgba(56, 189, 248, 0.35)" stroke-width="1" />
        <circle cx="12" cy="14" r="3.5" fill="#38bdf8" />
        <text x="22" y="18" fill="#38bdf8" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="11.5">${badgeText}</text>
      </g>
    </svg>
    `.trim();
  }

  /**
   * Compiles an array of SatelliteFrame objects into an MP4 video and/or GIF animation.
   */
  public async compileFramesToVideo(
    frames: SatelliteFrame[],
    options: CompileOptions = {}
  ): Promise<CompiledAnimationResult> {
    if (!frames || frames.length === 0) {
      throw new Error('No satellite frames provided for animation compilation');
    }

    const plantKey = frames[0].plantKey || 'ecuador';
    const geometry = BASIN_GEOMETRIES[plantKey] || {
      key: plantKey,
      name: plantKey,
      subtitle: '',
      bbox: frames[0].bbox
    };

    const framerate = Math.max(1, Math.min(30, options.framerate || 8));
    let width = Math.max(128, Math.min(2048, options.width || 800));
    let height = Math.max(128, Math.min(2048, options.height || 800));
    // Ensure even dimensions for libx264 compatibility
    width = Math.floor(width / 2) * 2;
    height = Math.floor(height / 2) * 2;
    const createMp4 = options.createMp4 !== false;
    const createGif = options.createGif !== false;
    const gifScale = Math.max(64, Math.min(1920, options.gifScale || 600));

    const runId = crypto.randomBytes(6).toString('hex');
    const workDir = path.join(process.cwd(), 'temp', `render_${runId}`);
    fs.mkdirSync(workDir, { recursive: true });

    const targetOutputDir = options.outputDir || path.join(process.cwd(), 'generated');
    fs.mkdirSync(targetOutputDir, { recursive: true });

    const sanitizedOutputName = options.outputName ? options.outputName.replace(/[^a-zA-Z0-9_-]/g, '_') : undefined;
    const baseName = sanitizedOutputName || `goes16_${plantKey.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}`;
    const mp4Path = path.join(targetOutputDir, `${baseName}.mp4`);
    const gifPath = path.join(targetOutputDir, `${baseName}.gif`);

    systemLogger.info(`[VideoCompilerService] Rendering ${frames.length} frames in ${workDir}...`);

    try {
      // 0. Pre-query SQLite rain_events to dynamically identify basins with active storms during each frame
      let dbRainEvents: Array<{ plant_key: string; detected_at: number; last_checked_at: number }> = [];
      try {
        dbRainEvents = db.prepare('SELECT plant_key, detected_at, last_checked_at FROM rain_events').all() as any;
      } catch (err) {}

      // 1. Write raw images, overlays, and stamp via ffmpeg in parallel chunks
      const concurrency = 4;
      for (let i = 0; i < frames.length; i += concurrency) {
        const chunk = frames.slice(i, i + concurrency);
        await Promise.all(
          chunk.map(async (frame, chunkIdx) => {
            const idx = i + chunkIdx;
            frame.index = idx;
            const pad = String(idx).padStart(3, '0');
            const rawPath = path.join(workDir, `raw_${pad}.png`);
            const svgPath = path.join(workDir, `overlay_${pad}.svg`);
            const outPath = path.join(workDir, `frame_${pad}.png`);

            fs.writeFileSync(rawPath, frame.buffer);

            // Determine if this specific frame falls within the active storm window
            const ts = frame.timestampIso || (frame as any).timestamp;
            const frameTime = ts ? new Date(ts).getTime() : 0;
            const activeBasinKeys = new Set<string>();

            let isWithinStormWindow = true;
            if (options.stormWindow) {
              const { startTime, endTime, startFrameIndex, endFrameIndex } = options.stormWindow;
              if (startFrameIndex !== undefined && idx < startFrameIndex) {
                isWithinStormWindow = false;
              }
              if (endFrameIndex !== undefined && idx > endFrameIndex) {
                isWithinStormWindow = false;
              }
              if (startTime !== undefined && frameTime > 0) {
                const startMs = typeof startTime === 'number' ? startTime : new Date(startTime).getTime();
                if (frameTime < startMs) isWithinStormWindow = false;
              }
              if (endTime !== undefined && frameTime > 0) {
                const endMs = typeof endTime === 'number' ? endTime : new Date(endTime).getTime();
                if (frameTime > endMs) isWithinStormWindow = false;
              }
            }

            if (isWithinStormWindow) {
              if (options.highlightBasinKey) {
                activeBasinKeys.add(options.highlightBasinKey);
              }
              if (options.activeBasinKeys) {
                if (options.activeBasinKeys instanceof Set) {
                  options.activeBasinKeys.forEach(k => activeBasinKeys.add(k));
                } else if (Array.isArray(options.activeBasinKeys)) {
                  options.activeBasinKeys.forEach(k => activeBasinKeys.add(k));
                }
              }
            }

            if (options.activeBasinResolver) {
              const resolved = options.activeBasinResolver(frame, idx);
              if (resolved) {
                if (resolved instanceof Set) {
                  resolved.forEach(k => activeBasinKeys.add(k));
                } else if (Array.isArray(resolved)) {
                  resolved.forEach(k => activeBasinKeys.add(k));
                }
              }
            }

            if (options.activeBasinKeys === undefined && !options.highlightBasinKey && !options.activeBasinResolver && frameTime > 0 && dbRainEvents.length > 0) {
              for (const ev of dbRainEvents) {
                if (frameTime >= ev.detected_at && frameTime <= ev.last_checked_at) {
                  activeBasinKeys.add(ev.plant_key);
                }
              }
            }

            const svgContent = this.generateSvgOverlay({
              ...options,
              frame,
              geometry,
              width,
              height,
              activeBasinKeys
            });
            fs.writeFileSync(svgPath, svgContent);

            await execFileAsync('ffmpeg', [
              '-y',
              '-i', rawPath,
              '-i', svgPath,
              '-filter_complex', '[0:v][1:v]overlay=0:0',
              '-frames:v', '1',
              '-update', '1',
              outPath
            ]);
          })
        );
      }

      const inputPattern = path.join(workDir, 'frame_%03d.png');
      let sizeBytesMp4: number | undefined;
      let sizeBytesGif: number | undefined;

      // Calculate repetition for video to reach at least minDurationSeconds (default: 10s)
      const minDurationSeconds = options.minDurationSeconds !== undefined ? options.minDurationSeconds : 10;
      const baseDuration = frames.length / framerate;
      const loopCount = (minDurationSeconds > 0 && baseDuration < minDurationSeconds)
        ? Math.ceil(minDurationSeconds / baseDuration) - 1
        : 0;
      const totalPlays = loopCount + 1;
      const durationSeconds = parseFloat((baseDuration * totalPlays).toFixed(2));

      // 2. Compile MP4 Video
      if (createMp4) {
        systemLogger.info(
          `[VideoCompilerService] Encoding MP4 video to ${mp4Path} (${totalPlays} cycles, target duration: ${durationSeconds}s)...`
        );
        const mp4Args = [
          '-y',
          '-framerate', framerate.toString(),
        ];
        if (loopCount > 0) {
          mp4Args.push('-stream_loop', loopCount.toString());
        }
        mp4Args.push(
          '-i', inputPattern,
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          mp4Path
        );
        await execFileAsync('ffmpeg', mp4Args);
        sizeBytesMp4 = fs.statSync(mp4Path).size;
      }

      // 3. Compile GIF Animation
      if (createGif) {
        systemLogger.info(`[VideoCompilerService] Encoding GIF animation to ${gifPath}...`);
        await execFileAsync('ffmpeg', [
          '-y',
          '-framerate', framerate.toString(),
          '-i', inputPattern,
          '-filter_complex', `[0:v] scale=${gifScale}:${gifScale},split [a][b];[a] palettegen [p];[b][p] paletteuse`,
          gifPath
        ]);
        sizeBytesGif = fs.statSync(gifPath).size;
      }

      const firstFrame = frames[0];
      const lastFrame = frames[frames.length - 1];

      systemLogger.info(
        `[VideoCompilerService] Successfully compiled animation for ${plantKey} (${frames.length} frames, ${totalPlays} cycles, duration: ${durationSeconds}s)`
      );

      return {
        plantKey,
        mp4Path: createMp4 ? mp4Path : undefined,
        gifPath: createGif ? gifPath : undefined,
        frameCount: frames.length,
        durationSeconds,
        sizeBytesMp4,
        sizeBytesGif,
        timestamps: {
          start: firstFrame.timestampIso,
          end: lastFrame.timestampIso,
          startEcuador: `${firstFrame.dateEcuador} ${firstFrame.timeEcuador}`,
          endEcuador: `${lastFrame.dateEcuador} ${lastFrame.timeEcuador}`
        }
      };
    } finally {
      // Clean up temporary work directory
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (err: any) {
        systemLogger.warn(`[VideoCompilerService] Failed to remove temp directory ${workDir}: ${err?.message || err}`);
      }
    }
  }

  /**
   * High-level helper to fetch recent frames and generate video/GIF for a given basin or Ecuador.
   */
  public async generateBasinAnimation(options: GenerateBasinVideoOptions = {}): Promise<CompiledAnimationResult> {
    const plantKey = options.plantKey || 'ecuador';
    const hoursBack = options.hoursBack || 3;
    const frameCount = options.frameCount || Math.round(hoursBack * 6); // 6 frames per hour (10-min cadence)

    // Resolve source & layers from layer parameter if provided
    let source = options.source;
    let layers = options.layers;
    if (options.layer) {
      if (options.layer === 'esri_satellite') {
        source = 'esri_satellite';
      } else if (options.layer === 'blue_marble') {
        source = 'nasa_gibs';
        layers = 'BlueMarble_NextGeneration';
      } else if (options.layer === 'nasa_gibs') {
        source = 'nasa_gibs';
        layers = 'GOES-East_ABI_Band13_Clean_Infrared';
      } else if (options.layer === 'persiann_24h') {
        source = 'geoserver';
        layers = 'satellite_based_precipitation:persiann_pdir_24h,ecuador:provincias';
      } else if (options.layer === 'wrf_daily') {
        source = 'geoserver';
        layers = 'wrf:wrf_precipitation_daily,ecuador:provincias';
      } else {
        source = 'geoserver';
        layers = 'goes:goes_abi_l2_cmipf_13,ecuador:provincias';
      }
    }

    systemLogger.info(`[VideoCompilerService] Starting basin animation generation for ${plantKey} (${hoursBack}h back, ${frameCount} frames)...`);

    const frames = await this.satelliteMapService.fetchBasinRecentFrames({
      plantKey,
      bbox: options.bbox,
      frameCount,
      source,
      layers,
      width: options.width,
      height: options.height
    });

    return this.compileFramesToVideo(frames, options);
  }
}
