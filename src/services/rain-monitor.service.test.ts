import { describe, it, expect, beforeEach, vi } from 'vitest';
import zlib from 'zlib';
import { db } from '../utils/db.js';
import {
  RainMonitorService,
  analyzeStormCloudCoverage,
  unfilterPngScanlines
} from './rain-monitor.service.js';
import { SatelliteMapService } from './satellite-map.service.js';
import { VideoCompilerService } from './video-compiler.service.js';

function createMockPng(
  width: number,
  height: number,
  stormPixelsCount: number,
  stormColor: [number, number, number] = [0, 200, 0]
): Buffer {
  const bytesPerPixel = 4; // RGBA
  const rawScanlines = Buffer.alloc(height * (1 + width * bytesPerPixel));
  let offset = 0;

  let stormRemaining = stormPixelsCount;
  for (let y = 0; y < height; y++) {
    rawScanlines[offset++] = 0; // Filter None (0)
    for (let x = 0; x < width; x++) {
      if (stormRemaining > 0) {
        // Convective cloud pixel (e.g., green: [0, 200, 0], red: [255, 0, 0])
        rawScanlines[offset++] = stormColor[0];
        rawScanlines[offset++] = stormColor[1];
        rawScanlines[offset++] = stormColor[2];
        rawScanlines[offset++] = 255;
        stormRemaining--;
      } else {
        // Grayscale / warm surface pixel (e.g., R=80, G=80, B=80)
        rawScanlines[offset++] = 80;
        rawScanlines[offset++] = 80;
        rawScanlines[offset++] = 80;
        rawScanlines[offset++] = 255;
      }
    }
  }

  const deflated = zlib.deflateSync(rawScanlines);

  // Build basic valid PNG
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // 8-bit depth
  ihdr.writeUInt8(6, 9); // RGBA

  const ihdrChunk = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR'),
    ihdr,
    Buffer.alloc(4) // CRC placeholder
  ]);

  const idatLen = Buffer.alloc(4);
  idatLen.writeUInt32BE(deflated.length, 0);
  const idatChunk = Buffer.concat([
    idatLen,
    Buffer.from('IDAT'),
    deflated,
    Buffer.alloc(4)
  ]);

  const iendChunk = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('IEND'),
    Buffer.alloc(4)
  ]);

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

describe('RainMonitorService', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM rain_events').run();
  });

  describe('analyzeStormCloudCoverage', () => {
    it('correctly calculates percentage of convective storm pixels', () => {
      const width = 10;
      const height = 10;
      const totalPixels = width * height; // 100
      const stormPixels = 25; // 25%

      const png = createMockPng(width, height, stormPixels);
      const coverage = analyzeStormCloudCoverage(png);

      expect(coverage).toBe(25.0);
    });

    it('returns 0 for purely grayscale (clear/warm) images', () => {
      const png = createMockPng(10, 10, 0);
      const coverage = analyzeStormCloudCoverage(png);

      expect(coverage).toBe(0);
    });

    it('filters out non-raining high cirrus clouds (cyan/blue)', () => {
      // Cyan cirrus pixel: R=0, G=255, B=255
      const png = createMockPng(10, 10, 30, [0, 255, 255]);
      const coverage = analyzeStormCloudCoverage(png);

      expect(coverage).toBe(0);
    });

    it('weights severe overshooting storm cores (red/white) higher', () => {
      // 20 severe red pixels out of 100: convPct = 20, sevPct = 20 -> effective = 20 + 20*1.5 = 50%
      const png = createMockPng(10, 10, 20, [255, 0, 0]);
      const coverage = analyzeStormCloudCoverage(png);

      expect(coverage).toBe(50.0);
    });
  });

  describe('checkBasin state machine', () => {
    it('transitions to STORM_STARTED when cloud coverage exceeds threshold', async () => {
      const mockSat = new SatelliteMapService();
      vi.spyOn(mockSat, 'fetchGoesTimestamps').mockResolvedValue(['2026-10-01T20:00:00.000Z']);
      vi.spyOn(mockSat, 'fetchMapTile').mockResolvedValue(createMockPng(10, 10, 30)); // 30% coverage

      const rainMonitor = new RainMonitorService(mockSat);
      const result = await rainMonitor.checkBasin('cocaCodoSinclair', {
        stormThresholdPct: 20
      });

      expect(result.action).toBe('STORM_STARTED');
      expect(result.coveragePct).toBe(30);
      expect(result.peakCoveragePct).toBe(30);

      const saved = rainMonitor.getActiveOrCooldownEvent('cocaCodoSinclair');
      expect(saved).not.toBeNull();
      expect(saved?.status).toBe('ACTIVE');
      expect(saved?.peak_coverage_pct).toBe(30);
    });

    it('stays in STORM_MONITORING while storm is active and growing', async () => {
      const mockSat = new SatelliteMapService();
      vi.spyOn(mockSat, 'fetchGoesTimestamps').mockResolvedValue(['2026-10-01T20:00:00.000Z']);
      vi.spyOn(mockSat, 'fetchMapTile').mockResolvedValue(createMockPng(10, 10, 35)); // 35% peak

      const rainMonitor = new RainMonitorService(mockSat);

      // 1. Initial detection
      await rainMonitor.checkBasin('cocaCodoSinclair', { stormThresholdPct: 20 });

      // 2. Subsequent check 20 minutes later (still growing, not yet passing)
      const result = await rainMonitor.checkBasin('cocaCodoSinclair', {
        minRainDurationMinutes: 60,
        maxRainDurationMinutes: 150
      });

      expect(result.action).toBe('STORM_MONITORING');
      expect(result.peakCoveragePct).toBe(35);
    });

    it('triggers compilation when storm passes (dissipates) after minimum duration', async () => {
      const mockSat = new SatelliteMapService();
      vi.spyOn(mockSat, 'fetchGoesTimestamps').mockResolvedValue(['2026-10-01T20:00:00.000Z']);
      // Clouds dropped to 10% (less than 50% of the 40% peak)
      vi.spyOn(mockSat, 'fetchMapTile').mockResolvedValue(createMockPng(10, 10, 10));

      const mockVideo = new VideoCompilerService();
      vi.spyOn(mockVideo, 'generateBasinAnimation').mockResolvedValue({
        plantKey: 'cocaCodoSinclair',
        mp4Path: '/tmp/test_rain.mp4',
        frameCount: 18,
        durationSeconds: 11.25,
        timestamps: {
          start: '2026-10-01T17:00:00Z',
          end: '2026-10-01T20:00:00Z',
          startEcuador: '2026-10-01 12:00',
          endEcuador: '2026-10-01 15:00'
        }
      });

      const rainMonitor = new RainMonitorService(mockSat, mockVideo);

      // Pre-seed an active event started 75 minutes ago with a peak of 40%
      const now = Date.now();
      const detectedAt = now - 75 * 60 * 1000;
      db.prepare(`
        INSERT INTO rain_events (
          plant_key, status, detected_at, last_checked_at,
          peak_coverage_pct, last_coverage_pct, cooldown_until
        ) VALUES ('cocaCodoSinclair', 'ACTIVE', ?, ?, 40, 30, 0)
      `).run(detectedAt, now - 15 * 60 * 1000);

      const result = await rainMonitor.checkBasin('cocaCodoSinclair', {
        minRainDurationMinutes: 60,
        dissipationRatio: 0.50, // 10% <= 40% * 0.5 = 20%
        cooldownHours: 6
      });

      expect(result.action).toBe('VIDEO_COMPILED');
      expect(result.compilationResult?.durationSeconds).toBe(11.25);

      const event = rainMonitor.getActiveOrCooldownEvent('cocaCodoSinclair');
      expect(event?.status).toBe('COOLDOWN');
      expect(event?.video_path).toBe('/tmp/test_rain.mp4');
      expect(event?.cooldown_until).toBeGreaterThan(now);
    });

    it('enforces cooldown period and ignores new checks while in cooldown', async () => {
      const mockSat = new SatelliteMapService();
      const rainMonitor = new RainMonitorService(mockSat);

      const now = Date.now();
      db.prepare(`
        INSERT INTO rain_events (
          plant_key, status, detected_at, last_checked_at,
          peak_coverage_pct, last_coverage_pct, cooldown_until
        ) VALUES ('cocaCodoSinclair', 'COOLDOWN', ?, ?, 50, 10, ?)
      `).run(now - 3600000, now, now + 5 * 3600 * 1000); // 5h left of cooldown

      const result = await rainMonitor.checkBasin('cocaCodoSinclair');
      expect(result.action).toBe('IN_COOLDOWN');
      expect(result.message).toContain('período de enfriamiento');
    });

    it('executes real satellite query for Coca Codo Sinclair', async () => {
      const rainMonitor = new RainMonitorService();
      const result = await rainMonitor.getBasinCurrentStormCoverage('cocaCodoSinclair', 50);

      expect(result.coveragePct).toBeGreaterThanOrEqual(0);
      expect(result.coveragePct).toBeLessThanOrEqual(100);
      expect(result.timestampIso).toBeDefined();
    });
  });
});
