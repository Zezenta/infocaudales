import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { BASIN_GEOMETRIES, BasinGeometry, ALL_HYDRO_PLANTS_PINS, PlantPin } from '../data/basin-geometries.js';
import { SatelliteFrame, SatelliteMapService } from './satellite-map.service.js';
import { systemLogger } from '../utils/logger.js';

const execAsync = promisify(exec);

export interface CompileOptions {
  outputDir?: string;
  outputName?: string;
  framerate?: number;
  width?: number;
  height?: number;
  createMp4?: boolean;
  createGif?: boolean;
  gifScale?: number;
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
  source?: 'geoserver' | 'nasa_gibs';
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
  public generateSvgOverlay(options: {
    frame: SatelliteFrame;
    geometry: BasinGeometry;
    width: number;
    height: number;
  }): string {
    const { frame, geometry, width, height } = options;
    const title = geometry.key === 'ecuador'
      ? 'Vista Satelital En Vivo'
      : `⚡ ${geometry.name} • Vista Satelital`;

    const subtitleBadge = geometry.key === 'ecuador'
      ? 'GOES-16 • Banda 13 IR (10.3 µm)'
      : (geometry.subtitle || 'GOES-16 • Banda 13 IR');

    // Collect all relevant pins for this view
    const pinsToRender: PlantPin[] = [];
    if (geometry.key === 'ecuador' || geometry.key === 'paute') {
      for (const p of ALL_HYDRO_PLANTS_PINS) {
        if (p.lon >= frame.bbox[0] && p.lat >= frame.bbox[1] && p.lon <= frame.bbox[2] && p.lat <= frame.bbox[3]) {
          pinsToRender.push(p);
        }
      }
    } else if (geometry.plantLocation) {
      pinsToRender.push(geometry.plantLocation);
    }

    let pinsSvg = '';
    for (const pin of pinsToRender) {
      const { x, y } = this.projectGeoToPixel(pin.lat, pin.lon, frame.bbox, width, height);
      if (x >= 0 && x <= width && y >= 0 && y <= height) {
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

        pinsSvg += `
        <g transform="translate(${x}, ${y})">
          <circle cx="0" cy="0" r="10" fill="${color}" fill-opacity="0.25" />
          <circle cx="0" cy="0" r="5.5" fill="${color}" stroke="#ffffff" stroke-width="1.5" />
          <rect x="${boxX}" y="${boxY}" width="${boxWidth}" height="24" rx="5" fill="#0b1120" fill-opacity="0.94" stroke="${color}" stroke-width="1.2" />
          <text x="${textX}" y="${textY}" fill="#f8fafc" font-family="'Space Grotesk', 'Outfit', DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="12">${pin.label}</text>
        </g>
        `;
      }
    }

    const badgeText = subtitleBadge;
    const badgeTextWidth = this.estimateTextWidth(badgeText, 11.5);
    const badgeTotalWidth = badgeTextWidth + 32;
    const badgeX = width - badgeTotalWidth - 20;

    return `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
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
          <stop offset="0%" stop-color="#0f172a"/>
          <stop offset="20%" stop-color="#38bdf8"/>
          <stop offset="45%" stop-color="#22c55e"/>
          <stop offset="68%" stop-color="#f59e0b"/>
          <stop offset="85%" stop-color="#ef4444"/>
          <stop offset="100%" stop-color="#ec4899"/>
        </linearGradient>
      </defs>

      <!-- Header Top Bar -->
      <rect x="0" y="0" width="${width}" height="68" fill="url(#topBarGrad)"/>
      <text x="20" y="38" fill="#ffffff" font-family="'Space Grotesk', 'Outfit', DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="20">${title}</text>
      
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
        <text x="32" y="17" fill="#cbd5e1" font-family="'Space Grotesk', 'Outfit', DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="16">@Hidro_Info_Bot</text>
      </g>

      <!-- Plant Pin Markers -->
      ${pinsSvg}

      <!-- Floating Thermal Scale Bar Overlay -->
      <g transform="translate(20, ${height - 116})">
        <rect x="0" y="0" width="220" height="42" rx="7" fill="#0b1120" fill-opacity="0.92" stroke="rgba(255, 255, 255, 0.12)" stroke-width="1" />
        <text x="10" y="14" fill="#94a3b8" font-family="'Space Grotesk', 'Outfit', DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="9.5" letter-spacing="0.04em">ESCALA TÉRMICA IR (°C)</text>
        <rect x="10" y="19" width="200" height="7" rx="3.5" fill="url(#thermalScaleGrad)" stroke="rgba(0,0,0,0.4)" stroke-width="0.5"/>
        <text x="10" y="37" fill="#64748b" font-family="'DejaVu Sans Mono', monospace" font-size="8.5" font-weight="600">+30°</text>
        <text x="72" y="37" fill="#38bdf8" font-family="'DejaVu Sans Mono', monospace" font-size="8.5" font-weight="600">-20°</text>
        <text x="135" y="37" fill="#f59e0b" font-family="'DejaVu Sans Mono', monospace" font-size="8.5" font-weight="600">-50°</text>
        <text x="186" y="37" fill="#ec4899" font-family="'DejaVu Sans Mono', monospace" font-size="8.5" font-weight="600">-80°C</text>
      </g>

      <!-- Footer Bottom Bar -->
      <rect x="0" y="${height - 60}" width="${width}" height="60" fill="url(#bottomBarGrad)"/>
      <circle cx="30" cy="${height - 30}" r="7" fill="#22c55e" />
      <text x="46" y="${height - 24}" fill="#f8fafc" font-family="'Space Grotesk', 'Outfit', DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="17">${frame.dateEcuador}  ${frame.timeEcuador} ECT</text>
      
      <!-- Subtitle Pill Badge on Bottom Right -->
      <g transform="translate(${badgeX}, ${height - 46})">
        <rect x="0" y="0" width="${badgeTotalWidth}" height="28" rx="6" fill="#0b1120" fill-opacity="0.92" stroke="rgba(56, 189, 248, 0.35)" stroke-width="1" />
        <circle cx="12" cy="14" r="3.5" fill="#38bdf8" />
        <text x="22" y="18" fill="#38bdf8" font-family="'Space Grotesk', 'Outfit', DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="11.5">${badgeText}</text>
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

    const framerate = options.framerate || 4;
    const width = options.width || 800;
    const height = options.height || 800;
    const createMp4 = options.createMp4 !== false;
    const createGif = options.createGif !== false;
    const gifScale = options.gifScale || 600;

    const runId = crypto.randomBytes(6).toString('hex');
    const workDir = path.join(process.cwd(), 'temp', `render_${runId}`);
    fs.mkdirSync(workDir, { recursive: true });

    const targetOutputDir = options.outputDir || path.join(process.cwd(), 'generated');
    fs.mkdirSync(targetOutputDir, { recursive: true });

    const baseName = options.outputName || `goes16_${plantKey}_${Date.now()}`;
    const mp4Path = path.join(targetOutputDir, `${baseName}.mp4`);
    const gifPath = path.join(targetOutputDir, `${baseName}.gif`);

    systemLogger.info(`[VideoCompilerService] Rendering ${frames.length} frames in ${workDir}...`);

    try {
      // 1. Write raw and labeled images
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const pad = String(i).padStart(3, '0');
        const rawPath = path.join(workDir, `raw_${pad}.png`);
        const svgPath = path.join(workDir, `overlay_${pad}.svg`);
        const outPath = path.join(workDir, `frame_${pad}.png`);

        fs.writeFileSync(rawPath, frame.buffer);

        const svgContent = this.generateSvgOverlay({
          frame,
          geometry,
          width,
          height
        });
        fs.writeFileSync(svgPath, svgContent);

        // Apply SVG overlay via ffmpeg
        const overlayCmd = `ffmpeg -y -i "${rawPath}" -i "${svgPath}" -filter_complex "[0:v][1:v]overlay=0:0" -frames:v 1 -update 1 "${outPath}"`;
        await execAsync(overlayCmd);
      }

      const inputPattern = path.join(workDir, 'frame_%03d.png');
      let sizeBytesMp4: number | undefined;
      let sizeBytesGif: number | undefined;

      // 2. Compile MP4 Video
      if (createMp4) {
        systemLogger.info(`[VideoCompilerService] Encoding MP4 video to ${mp4Path}...`);
        // Ensure dimensions are even (required by libx264 with yuv420p)
        const mp4Cmd = `ffmpeg -y -framerate ${framerate} -i "${inputPattern}" -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -pix_fmt yuv420p "${mp4Path}"`;
        await execAsync(mp4Cmd);
        sizeBytesMp4 = fs.statSync(mp4Path).size;
      }

      // 3. Compile GIF Animation
      if (createGif) {
        systemLogger.info(`[VideoCompilerService] Encoding GIF animation to ${gifPath}...`);
        const gifCmd = `ffmpeg -y -framerate ${framerate} -i "${inputPattern}" -filter_complex "[0:v] scale=${gifScale}:${gifScale},split [a][b];[a] palettegen [p];[b][p] paletteuse" "${gifPath}"`;
        await execAsync(gifCmd);
        sizeBytesGif = fs.statSync(gifPath).size;
      }

      const durationSeconds = parseFloat((frames.length / framerate).toFixed(2));
      const firstFrame = frames[0];
      const lastFrame = frames[frames.length - 1];

      systemLogger.info(
        `[VideoCompilerService] Successfully compiled animation for ${plantKey} (${frames.length} frames, duration: ${durationSeconds}s)`
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

    systemLogger.info(`[VideoCompilerService] Starting basin animation generation for ${plantKey} (${hoursBack}h back, ${frameCount} frames)...`);

    const frames = await this.satelliteMapService.fetchBasinRecentFrames({
      plantKey,
      bbox: options.bbox,
      frameCount,
      source: options.source,
      width: options.width,
      height: options.height
    });

    return this.compileFramesToVideo(frames, options);
  }
}
