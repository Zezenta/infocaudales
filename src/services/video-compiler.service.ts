import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { BASIN_GEOMETRIES, BasinGeometry } from '../data/basin-geometries.js';
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
      ? '🛰️ GOES-16 IR (Banda 13) • Satélite Ecuador'
      : `⚡ ${geometry.name} • GOES-16 IR`;

    const subtitleBadge = geometry.subtitle || 'INAMHI / NOAA';

    let pinSvg = '';
    if (geometry.plantLocation) {
      const { lat, lon, label } = geometry.plantLocation;
      const { x, y } = this.projectGeoToPixel(lat, lon, frame.bbox, width, height);

      // Only draw pin if it falls inside visible image area
      if (x >= 0 && x <= width && y >= 0 && y <= height) {
        const textWidth = Math.max(90, label.length * 8 + 16);
        pinSvg = `
        <g transform="translate(${x}, ${y})">
          <circle cx="0" cy="0" r="16" fill="#ef4444" fill-opacity="0.35" />
          <circle cx="0" cy="0" r="6" fill="#ef4444" stroke="#ffffff" stroke-width="1.5" />
          <rect x="12" y="-13" width="${textWidth}" height="26" rx="5" fill="#0f172a" fill-opacity="0.9" stroke="#ef4444" stroke-width="1" />
          <text x="20" y="4" fill="#f8fafc" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="11">${label}</text>
        </g>
        `;
      }
    }

    return `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="topBarGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#090d16" stop-opacity="0.95"/>
          <stop offset="100%" stop-color="#090d16" stop-opacity="0.5"/>
        </linearGradient>
        <linearGradient id="bottomBarGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#090d16" stop-opacity="0.5"/>
          <stop offset="100%" stop-color="#090d16" stop-opacity="0.95"/>
        </linearGradient>
      </defs>

      <!-- Header Top Bar -->
      <rect x="0" y="0" width="${width}" height="60" fill="url(#topBarGrad)"/>
      <text x="20" y="38" fill="#ffffff" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="19">${title}</text>
      
      <!-- Subtitle Pill Badge -->
      <rect x="${width - 150}" y="16" width="130" height="28" rx="6" fill="#1e293b" stroke="#334155" stroke-width="1" />
      <text x="${width - 85}" y="35" text-anchor="middle" fill="#38bdf8" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="12">${subtitleBadge}</text>

      <!-- Plant Pin Marker -->
      ${pinSvg}

      <!-- Footer Bottom Bar -->
      <rect x="0" y="${height - 60}" width="${width}" height="60" fill="url(#bottomBarGrad)"/>
      <circle cx="30" cy="${height - 30}" r="7" fill="#22c55e" />
      <text x="46" y="${height - 24}" fill="#f8fafc" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="17">${frame.dateEcuador}  ${frame.timeEcuador} ECT</text>
      <text x="${width - 24}" y="${height - 24}" text-anchor="end" fill="#94a3b8" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="15">@infocaudales</text>
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
