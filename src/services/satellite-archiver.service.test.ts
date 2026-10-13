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
});
