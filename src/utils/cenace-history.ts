import { CenaceService } from '../services/cenace.service.js';
import { db } from './db.js';

export interface CenaceHistoryRecord {
  timestamp: number;
  cocaCodoMWh: number;
}

/**
 * Reads accumulated MWh history records for Coca Codo Sinclair from SQLite.
 */
export function readCenaceHistory(): CenaceHistoryRecord[] {
  try {
    const rows = db.prepare(`
      SELECT timestamp, accumulated_mwh AS cocaCodoMWh 
      FROM coca_codo_raw_history 
      ORDER BY timestamp ASC
    `).all() as any[];
    return rows;
  } catch (err) {
    console.warn('[SQLite] Failed to read CENACE history from DB:', err);
  }
  return [];
}

/**
 * Saves a new accumulated MWh history record for Coca Codo Sinclair to SQLite.
 */
export function saveCenaceHistory(record: CenaceHistoryRecord): void {
  try {
    const prev = db.prepare(`
      SELECT timestamp, accumulated_mwh 
      FROM coca_codo_raw_history 
      ORDER BY timestamp DESC 
      LIMIT 1
    `).get() as any;

    let hourlyMW = 0;
    if (prev) {
      const diffMs = record.timestamp - prev.timestamp;
      const diffHours = diffMs / (1000 * 60 * 60);
      const deltaMWh = record.cocaCodoMWh - prev.accumulated_mwh;
      if (diffHours > 0.05 && deltaMWh >= 0) {
        const rawRate = deltaMWh / diffHours;
        hourlyMW = Math.min(rawRate, 1500); // Cap at Coca Codo Sinclair max capacity
      }
    }

    // Insert into raw history
    db.prepare(`
      INSERT OR REPLACE INTO coca_codo_raw_history (timestamp, accumulated_mwh)
      VALUES (?, ?)
    `).run(record.timestamp, record.cocaCodoMWh);

    // Insert into hourly telemetry
    db.prepare(`
      INSERT OR REPLACE INTO hourly_telemetry (timestamp, plant_key, generation_mw, caudal_flow, cota_level)
      VALUES (?, 'cocaCodoSinclair', ?, 0, NULL)
    `).run(record.timestamp, hourlyMW);

    console.log(`[SQLite] Saved baseline: ${record.cocaCodoMWh} MWh. Calculated rate: ${hourlyMW.toFixed(2)} MW`);
  } catch (err) {
    console.warn('[SQLite] Failed to save CENACE history to DB:', err);
  }
}

/**
 * Samples Coca Codo Sinclair's current accumulated MWh from CENACE and saves it to SQLite.
 */
export async function recordCenaceBaseline(cenaceService: CenaceService): Promise<void> {
  try {
    const currentMWh = await cenaceService.fetchPlantProduction('cocaCodoSinclair');
    if (currentMWh !== null && currentMWh > 0) {
      const nowMs = Date.now();
      saveCenaceHistory({ timestamp: nowMs, cocaCodoMWh: currentMWh });
      console.log(`[SQLite] Baseline recorded: ${currentMWh} MWh at ${new Date().toLocaleTimeString()}`);
    }
  } catch (err) {
    console.warn(`[SQLite] Failed to record CENACE baseline:`, err);
  }
}

/**
 * Validates and retrieves the Coca Codo Sinclair hourly curve for yesterday from SQLite.
 * Returns null if any of the 24 hourly intervals are missing.
 */
export function getCcsYesterdayHourlyCurve(yesterdayDate: Date): number[] | null {
  try {
    // Compute Ecuador date parts
    const ecDate = new Date(yesterdayDate.getTime() - 5 * 60 * 60 * 1000);
    const year = ecDate.getUTCFullYear();
    const month = ecDate.getUTCMonth();
    const date = ecDate.getUTCDate();

    // Create UTC timestamps for each local hour in Ecuador timezone
    const targetTimestamps: number[] = [];
    for (let h = 0; h <= 24; h++) {
      targetTimestamps.push(Date.UTC(year, month, date, h + 5));
    }

    const matchedRecords: CenaceHistoryRecord[] = [];
    const tolerance = 15 * 60 * 1000; // 15 minutes window

    const matchStmt = db.prepare(`
      SELECT timestamp, accumulated_mwh AS cocaCodoMWh 
      FROM coca_codo_raw_history 
      WHERE abs(timestamp - ?) <= ? 
      LIMIT 1
    `);

    for (const targetT of targetTimestamps) {
      const match = matchStmt.get(targetT, tolerance) as any;
      if (!match) {
        return null; // Missing hourly point!
      }
      matchedRecords.push(match);
    }

    // Calculate the 24 hourly averages in MW
    const curve: number[] = [];
    for (let i = 1; i <= 24; i++) {
      const start = matchedRecords[i - 1];
      const end = matchedRecords[i];
      
      const diffHours = (end.timestamp - start.timestamp) / (1000 * 60 * 60);
      const deltaMWh = end.cocaCodoMWh - start.cocaCodoMWh;
      
      if (diffHours <= 0.05 || deltaMWh < 0) {
        return null; // Invalid reading interval
      }
      
      const rawRate = deltaMWh / diffHours;
      curve.push(Math.min(rawRate, 1500)); // Cap at Coca Codo Sinclair max capacity
    }

    return curve;
  } catch (err) {
    console.warn('[SQLite] Error calculating yesterday hourly curve:', err);
  }
  return null;
}
