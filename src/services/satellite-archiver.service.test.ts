import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../utils/db.js';
import { SatelliteArchiverService } from './satellite-archiver.service.js';
import { SatelliteMapService } from './satellite-map.service.js';

describe('SatelliteArchiverService', () => {
  const testArchiveDir = path.join(process.cwd(), 'temp', 'test_satellite_archive');

  beforeEach(() => {
    db.prepare('DELETE FROM satellite_archive').run();
    if (fs.existsSync(testArchiveDir)) {
      fs.rmSync(testArchiveDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testArchiveDir)) {
      fs.rmSync(testArchiveDir, { recursive: true, force: true });
    }
  });

  it('archives new frames and stores them on disk and SQLite', async () => {
    const mockSat = new SatelliteMapService();
    vi.spyOn(mockSat, 'fetchGoesTimestamps').mockResolvedValue([
      '2026-10-02T12:00:00.000Z',
      '2026-10-02T12:10:00.000Z'
    ]);

    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    vi.spyOn(mockSat, 'fetchMapTile').mockResolvedValue(fakePng);

    const archiver = new SatelliteArchiverService(mockSat, testArchiveDir);

    const result = await archiver.archiveLatestFrames({ limit: 2 });
    expect(result.downloaded).toBe(2);
    expect(result.skipped).toBe(0);

    const stats = archiver.getStats();
    expect(stats.totalFrames).toBe(2);
    expect(stats.oldestTimestamp).toBe('2026-10-02T12:00:00.000Z');
    expect(stats.newestTimestamp).toBe('2026-10-02T12:10:00.000Z');

    // Subsequent check skips already downloaded frames
    const secondPass = await archiver.archiveLatestFrames({ limit: 2 });
    expect(secondPass.downloaded).toBe(0);
    expect(secondPass.skipped).toBe(2);
  });

  it('retrieves archived frames as SatelliteFrame objects', async () => {
    const mockSat = new SatelliteMapService();
    vi.spyOn(mockSat, 'fetchGoesTimestamps').mockResolvedValue(['2026-10-02T12:00:00.000Z']);
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.spyOn(mockSat, 'fetchMapTile').mockResolvedValue(fakePng);

    const archiver = new SatelliteArchiverService(mockSat, testArchiveDir);
    await archiver.archiveLatestFrames({ limit: 1 });

    const frames = archiver.getArchivedFrames({ limit: 10 });
    expect(frames.length).toBe(1);
    expect(frames[0].timestampIso).toBe('2026-10-02T12:00:00.000Z');
    expect(frames[0].buffer.length).toBe(fakePng.length);
  });

  it('prunes frames older than specified days', async () => {
    const mockSat = new SatelliteMapService();
    const archiver = new SatelliteArchiverService(mockSat, testArchiveDir);

    // Pre-insert an old frame record
    const oldRecordedAt = Date.now() - 40 * 24 * 3600 * 1000; // 40 days ago
    const dummyFile = path.join(testArchiveDir, 'old_frame.png');
    fs.mkdirSync(testArchiveDir, { recursive: true });
    fs.writeFileSync(dummyFile, 'dummy');

    db.prepare(`
      INSERT INTO satellite_archive (
        timestamp_iso, date_ecuador, time_ecuador, plant_key,
        file_path, file_size_bytes, recorded_at
      ) VALUES ('2026-08-01T00:00:00Z', '2026-07-31', '19:00', 'ecuador', ?, 5, ?)
    `).run(dummyFile, oldRecordedAt);

    const pruned = archiver.pruneOldFrames(30);
    expect(pruned).toBe(1);
    expect(fs.existsSync(dummyFile)).toBe(false);

    const count = db.prepare('SELECT COUNT(*) as count FROM satellite_archive').get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('handles GeoServer failures gracefully without corrupting archive', async () => {
    const mockSat = new SatelliteMapService();
    vi.spyOn(mockSat, 'fetchGoesTimestamps').mockRejectedValue(new Error('GeoServer 503 Service Unavailable'));

    const archiver = new SatelliteArchiverService(mockSat, testArchiveDir);
    const result = await archiver.archiveLatestFrames({ limit: 5 });

    expect(result.downloaded).toBe(0);
    expect(result.scanned).toBe(0);

    const stats = archiver.getStats();
    expect(stats.totalFrames).toBe(0);
  });

  it('archives NASA GIBS frames and allows coexistence with GeoServer for the same timestamp', async () => {
    const mockSat = new SatelliteMapService();
    const sameTimestamp = '2026-10-14T08:00:00.000Z';
    vi.spyOn(mockSat, 'fetchGoesTimestamps').mockResolvedValue([sameTimestamp]);

    const fakeGeoPng = Buffer.alloc(30000, 1);
    const fakeNasaPng = Buffer.alloc(40000, 2);
    vi.spyOn(mockSat, 'fetchMapTile').mockImplementation(async (opts) => {
      if (opts.source === 'nasa_gibs') return fakeNasaPng;
      return fakeGeoPng;
    });

    const archiver = new SatelliteArchiverService(mockSat, testArchiveDir);

    // Archive GeoServer frame
    const geoRes = await archiver.archiveLatestFrames({ limit: 1, source: 'geoserver' });
    expect(geoRes.downloaded).toBe(1);

    // Archive NASA frame for the exact same timestamp
    const nasaRes = await archiver.archiveLatestFrames({ limit: 1, source: 'nasa_gibs' });
    expect(nasaRes.downloaded).toBe(1);

    // Both should coexist in DB and have distinct file paths
    const totalStats = archiver.getStats();
    expect(totalStats.totalFrames).toBe(2);

    const geoStats = archiver.getStats('geoserver');
    expect(geoStats.totalFrames).toBe(1);

    const nasaStats = archiver.getStats('nasa_gibs');
    expect(nasaStats.totalFrames).toBe(1);

    const geoFrames = archiver.getArchivedFrames({ source: 'geoserver' });
    expect(geoFrames.length).toBe(1);
    expect(geoFrames[0].source).toBe('geoserver');

    const nasaFrames = archiver.getArchivedFrames({ source: 'nasa_gibs' });
    expect(nasaFrames.length).toBe(1);
    expect(nasaFrames[0].source).toBe('nasa_gibs');
  });

  it('triggers 24-hour backfill (144 frames) for NASA GIBS when archive has 0 NASA frames', async () => {
    const mockSat = new SatelliteMapService();
    const timestamps144 = Array.from({ length: 144 }, (_, i) => `2026-10-13T${String(i).padStart(2, '0')}:00:00.000Z`);
    const fetchTimestampsSpy = vi.spyOn(mockSat, 'fetchGoesTimestamps').mockResolvedValue(timestamps144);

    const fakeNasaPng = Buffer.alloc(35000, 9);
    vi.spyOn(mockSat, 'fetchMapTile').mockResolvedValue(fakeNasaPng);

    const archiver = new SatelliteArchiverService(mockSat, testArchiveDir);

    // No limit passed, count is 0 -> should request 144 frames
    const res = await archiver.archiveLatestFrames({ source: 'nasa_gibs' });
    expect(fetchTimestampsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 144, source: 'nasa_gibs' })
    );
    expect(res.downloaded).toBe(144);

    const nasaStats = archiver.getStats('nasa_gibs');
    expect(nasaStats.totalFrames).toBe(144);
  });
});
