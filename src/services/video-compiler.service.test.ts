import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { VideoCompilerService } from './video-compiler.service.js';
import { SatelliteFrame, SatelliteMapService } from './satellite-map.service.js';
import { BASIN_GEOMETRIES } from '../data/basin-geometries.js';

describe('VideoCompilerService', () => {
  let compiler: VideoCompilerService;
  let satelliteMapService: SatelliteMapService;

  beforeEach(() => {
    vi.clearAllMocks();
    satelliteMapService = new SatelliteMapService();
    compiler = new VideoCompilerService(satelliteMapService);
  });

  describe('projectGeoToPixel', () => {
    it('projects center coordinates to image center', () => {
      const bbox: [number, number, number, number] = [-80, -4, -70, 0]; // 10 deg lon, 4 deg lat
      const { x, y } = compiler.projectGeoToPixel(-2, -75, bbox, 800, 800);
      expect(x).toBe(400);
      expect(y).toBe(400);
    });

    it('projects top-left and bottom-right corners accurately', () => {
      const bbox: [number, number, number, number] = [-80, -4, -70, 0];
      const topLeft = compiler.projectGeoToPixel(0, -80, bbox, 800, 800);
      expect(topLeft.x).toBe(0);
      expect(topLeft.y).toBe(0);

      const bottomRight = compiler.projectGeoToPixel(-4, -70, bbox, 800, 800);
      expect(bottomRight.x).toBe(800);
      expect(bottomRight.y).toBe(800);
    });
  });

  describe('generateSvgOverlay', () => {
    it('generates SVG overlay with Ecuador header when key is ecuador', () => {
      const fakeFrame: SatelliteFrame = {
        index: 0,
        timestampIso: '2026-09-11T03:00:00.000Z',
        dateEcuador: '2026-09-10',
        timeEcuador: '22:00',
        buffer: Buffer.from(''),
        bbox: BASIN_GEOMETRIES.ecuador.bbox,
        plantKey: 'ecuador',
        source: 'geoserver'
      };

      const svg = compiler.generateSvgOverlay({
        frame: fakeFrame,
        geometry: BASIN_GEOMETRIES.ecuador,
        width: 800,
        height: 800
      });

      expect(svg).toContain('🛰️ Satélite en Vivo • Nubes y Tormentas');
      expect(svg).toContain('2026-09-10  22:00 ECT');
      expect(svg).toContain('@Hidro_Info_Bot');
    });

    it('generates SVG overlay with plant pin for specific hydro basin', () => {
      const fakeFrame: SatelliteFrame = {
        index: 0,
        timestampIso: '2026-09-11T03:00:00.000Z',
        dateEcuador: '2026-09-10',
        timeEcuador: '22:00',
        buffer: Buffer.from(''),
        bbox: BASIN_GEOMETRIES.cocaCodoSinclair.bbox,
        plantKey: 'cocaCodoSinclair',
        source: 'geoserver'
      };

      const svg = compiler.generateSvgOverlay({
        frame: fakeFrame,
        geometry: BASIN_GEOMETRIES.cocaCodoSinclair,
        width: 800,
        height: 800
      });

      expect(svg).toContain('Cuenca Coca Codo Sinclair');
      expect(svg).toContain('Captación CCS');
      expect(svg).toContain('2026-09-10  22:00 ECT');
    });
  });

  describe('compileFramesToVideo', () => {
    it('compiles frames to MP4 and GIF using ffmpeg', async () => {
      // Create a valid 800x800 test PNG frame using ffmpeg
      const workDir = path.join(process.cwd(), 'temp', 'test_frame_gen');
      fs.mkdirSync(workDir, { recursive: true });
      const testFramePath = path.join(workDir, 'test.png');
      const { execSync } = await import('child_process');
      execSync(`ffmpeg -y -f lavfi -i color=c=blue:s=800x800:d=0.1 -frames:v 1 "${testFramePath}"`);
      const samplePng = fs.readFileSync(testFramePath);
      fs.rmSync(workDir, { recursive: true, force: true });

      const frames: SatelliteFrame[] = [
        {
          index: 0,
          timestampIso: '2026-09-11T03:00:00.000Z',
          dateEcuador: '2026-09-10',
          timeEcuador: '22:00',
          buffer: samplePng,
          bbox: BASIN_GEOMETRIES.cocaCodoSinclair.bbox,
          plantKey: 'cocaCodoSinclair',
          source: 'geoserver'
        },
        {
          index: 1,
          timestampIso: '2026-09-11T03:10:00.000Z',
          dateEcuador: '2026-09-10',
          timeEcuador: '22:10',
          buffer: samplePng,
          bbox: BASIN_GEOMETRIES.cocaCodoSinclair.bbox,
          plantKey: 'cocaCodoSinclair',
          source: 'geoserver'
        }
      ];

      const outDir = path.join(process.cwd(), 'temp', 'test_out');
      fs.mkdirSync(outDir, { recursive: true });

      const result = await compiler.compileFramesToVideo(frames, {
        outputDir: outDir,
        outputName: 'test_anim',
        framerate: 2,
        createMp4: true,
        createGif: true
      });

      expect(result.plantKey).toBe('cocaCodoSinclair');
      expect(result.frameCount).toBe(2);
      expect(result.durationSeconds).toBe(1);
      expect(result.mp4Path).toBeDefined();
      expect(result.gifPath).toBeDefined();
      expect(fs.existsSync(result.mp4Path!)).toBe(true);
      expect(fs.existsSync(result.gifPath!)).toBe(true);
      expect(result.sizeBytesMp4).toBeGreaterThan(0);
      expect(result.sizeBytesGif).toBeGreaterThan(0);

      // Clean up test output
      fs.rmSync(outDir, { recursive: true, force: true });
    });
  });
});
