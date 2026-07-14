import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from './db.js';
import { 
  saveCenaceHistory, 
  readCenaceHistory, 
  getCcsYesterdayHourlyCurve 
} from './cenace-history.js';

describe('Coca Codo Sinclair SQLite History & Queries', () => {
  // Save current database state
  let backupRecords: any[] = [];

  beforeEach(() => {
    // Read and backup existing records before each test
    backupRecords = db.prepare('SELECT timestamp, accumulated_mwh FROM coca_codo_hourly_log').all();
    // Clean database for fresh test runs
    db.prepare('DELETE FROM coca_codo_hourly_log').run();
  });

  afterEach(() => {
    // Restore backup records to prevent developer database loss during tests
    db.prepare('DELETE FROM coca_codo_hourly_log').run();
    const insert = db.prepare('INSERT INTO coca_codo_hourly_log (timestamp, accumulated_mwh) VALUES (?, ?)');
    const restoreTx = db.transaction((rows: any[]) => {
      for (const row of rows) {
        insert.run(row.timestamp, row.accumulated_mwh);
      }
    });
    restoreTx(backupRecords);
  });

  it('should round timestamps to the nearest hour mark when saving', () => {
    // Test timestamp: 2026-07-12T12:00:03.500Z (not exactly on the hour)
    const baseTime = Date.UTC(2026, 6, 12, 12, 0, 3, 500); // July is 0-indexed, so 6
    const expectedRoundedTime = Date.UTC(2026, 6, 12, 12, 0, 0, 0);

    saveCenaceHistory({ timestamp: baseTime, cocaCodoMWh: 5000 });

    const history = readCenaceHistory();
    expect(history.length).toBe(1);
    expect(history[0].timestamp).toBe(expectedRoundedTime);
    expect(history[0].cocaCodoMWh).toBe(5000);
  });

  it('should calculate the hourly MW rate correctly on-the-fly between adjacent hours', () => {
    const time6AM = Date.UTC(2026, 6, 12, 11, 0, 0, 0); // 6:00 AM local (11:00 UTC)
    const time7AM = Date.UTC(2026, 6, 12, 12, 0, 0, 0); // 7:00 AM local (12:00 UTC)

    // Save accumulated MWh baselines
    saveCenaceHistory({ timestamp: time6AM, cocaCodoMWh: 10000 });
    saveCenaceHistory({ timestamp: time7AM, cocaCodoMWh: 11200 }); // +1200 MWh generated in 1 hour

    // Simulate index.ts rate query
    const rows = db.prepare(`
      SELECT timestamp, accumulated_mwh 
      FROM coca_codo_hourly_log 
      WHERE timestamp = ? OR timestamp = ?
      ORDER BY timestamp ASC
    `).all(time6AM, time7AM) as any[];

    expect(rows.length).toBe(2);

    const start = rows[0];
    const end = rows[1];
    const diffHours = (end.timestamp - start.timestamp) / (1000 * 60 * 60);
    const deltaMWh = end.accumulated_mwh - start.accumulated_mwh;
    
    expect(diffHours).toBe(1);
    expect(deltaMWh).toBe(1200);

    const rate = Math.min(deltaMWh / diffHours, 1500);
    expect(rate).toBe(1200); // 1200 MW running rate
  });

  it('should cap calculated rate at the 1500 MW physical maximum limit', () => {
    const time6AM = Date.UTC(2026, 6, 12, 11, 0, 0, 0);
    const time7AM = Date.UTC(2026, 6, 12, 12, 0, 0, 0);

    saveCenaceHistory({ timestamp: time6AM, cocaCodoMWh: 10000 });
    // Save a massive jump (+1800 MWh), simulating a batch-update spike
    saveCenaceHistory({ timestamp: time7AM, cocaCodoMWh: 11800 }); 

    const rows = db.prepare(`
      SELECT timestamp, accumulated_mwh 
      FROM coca_codo_hourly_log 
      WHERE timestamp = ? OR timestamp = ?
      ORDER BY timestamp ASC
    `).all(time6AM, time7AM) as any[];

    expect(rows.length).toBe(2);
    
    const start = rows[0];
    const end = rows[1];
    const diffHours = (end.timestamp - start.timestamp) / (1000 * 60 * 60);
    const deltaMWh = end.accumulated_mwh - start.accumulated_mwh;

    const rate = Math.min(deltaMWh / diffHours, 1500);
    expect(rate).toBe(1500); // Capped at physical limit!
  });

  it('should return yesterday hourly curve if all 25 records are complete', () => {
    // Generate mock target date (yesterday local time)
    const yesterdayDate = new Date(Date.UTC(2026, 6, 12, 12, 0, 0, 0));
    
    // Inject 25 consecutive hourly records (00:00 to 24:00 local time)
    // 00:00 local = 05:00 UTC
    // 24:00 local = 29:00 UTC (05:00 UTC of next day)
    let baseline = 5000;
    for (let h = 0; h <= 24; h++) {
      const ts = Date.UTC(2026, 6, 12, h + 5, 0, 0, 0);
      saveCenaceHistory({ timestamp: ts, cocaCodoMWh: baseline });
      baseline += 800; // Generate 800 MW hourly rate
    }

    const curve = getCcsYesterdayHourlyCurve(yesterdayDate);
    expect(curve).not.toBeNull();
    expect(curve?.length).toBe(24);
    expect(curve?.every(val => val === 800)).toBe(true);
  });

  it('should successfully interpolate missing hours if at least 20 records are present', () => {
    const yesterdayDate = new Date(Date.UTC(2026, 6, 12, 12, 0, 0, 0));
    
    // Inject 25 records, but miss 12:00 local (index 12)
    let baseline = 5000;
    for (let h = 0; h <= 24; h++) {
      if (h === 12) {
        baseline += 800; // Increment baseline anyway to simulate generation during the missing hour
        continue;
      }
      const ts = Date.UTC(2026, 6, 12, h + 5, 0, 0, 0);
      saveCenaceHistory({ timestamp: ts, cocaCodoMWh: baseline });
      baseline += 800;
    }

    const curve = getCcsYesterdayHourlyCurve(yesterdayDate);
    expect(curve).not.toBeNull();
    expect(curve?.length).toBe(24);
    // Verified that it interpolated index 11 (from 11:00 to 12:00 local) and index 12 (from 12:00 to 1:00 PM local) correctly
    expect(curve?.[11]).toBe(800);
    expect(curve?.[12]).toBe(800);
    expect(curve?.every(val => val === 800)).toBe(true);
  });

  it('should return null for getCcsYesterdayHourlyCurve if too many hours are missing (less than 20 records)', () => {
    const yesterdayDate = new Date(Date.UTC(2026, 6, 12, 12, 0, 0, 0));
    
    // Inject only 18 records (7 hours missing)
    let baseline = 5000;
    for (let h = 0; h <= 24; h++) {
      if (h % 3 === 0) continue; // Skip multiple hours
      const ts = Date.UTC(2026, 6, 12, h + 5, 0, 0, 0);
      saveCenaceHistory({ timestamp: ts, cocaCodoMWh: baseline });
      baseline += 800;
    }

    const curve = getCcsYesterdayHourlyCurve(yesterdayDate);
    expect(curve).toBeNull(); // Too many missing records triggers validation abort
  });
});
