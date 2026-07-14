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
      FROM coca_codo_hourly_log 
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
    // Round timestamp to the nearest hour mark
    const hourlyTimestamp = Math.round(record.timestamp / (3600 * 1000)) * (3600 * 1000);

    db.prepare(`
      INSERT OR REPLACE INTO coca_codo_hourly_log (timestamp, accumulated_mwh)
      VALUES (?, ?)
    `).run(hourlyTimestamp, record.cocaCodoMWh);

    console.log(`[SQLite] Saved hourly baseline: ${record.cocaCodoMWh} MWh at timestamp ${hourlyTimestamp}`);
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

    // Create UTC timestamps for each local hour in Ecuador timezone (0 to 24)
    const targetTimestamps: number[] = [];
    for (let h = 0; h <= 24; h++) {
      targetTimestamps.push(Date.UTC(year, month, date, h + 5));
    }

    const matchedRecords: (CenaceHistoryRecord | null)[] = [];
    const tolerance = 15 * 60 * 1000; // 15 minutes window

    const matchStmt = db.prepare(`
      SELECT timestamp, accumulated_mwh AS cocaCodoMWh 
      FROM coca_codo_hourly_log 
      WHERE abs(timestamp - ?) <= ? 
      LIMIT 1
    `);

    for (const targetT of targetTimestamps) {
      const match = matchStmt.get(targetT, tolerance) as any;
      matchedRecords.push(match || null);
    }

    // Count how many records were successfully found
    const foundCount = matchedRecords.filter(r => r !== null).length;
    if (foundCount < 20) {
      console.warn(`[SQLite] Too many missing hourly readings for yesterday (${25 - foundCount} missing). Aborting curve generation.`);
      return null;
    }

    // Interpolate missing entries
    for (let i = 0; i < matchedRecords.length; i++) {
      if (matchedRecords[i] === null) {
        const targetT = targetTimestamps[i];

        // Find closest available record before i
        let prevRecord: CenaceHistoryRecord | null = null;
        for (let j = i - 1; j >= 0; j--) {
          if (matchedRecords[j] !== null) {
            prevRecord = matchedRecords[j]!;
            break;
          }
        }
        // If not found in yesterday's bounds, query database for closest record before targetT
        if (!prevRecord) {
          prevRecord = db.prepare(`
            SELECT timestamp, accumulated_mwh AS cocaCodoMWh
            FROM coca_codo_hourly_log
            WHERE timestamp < ?
            ORDER BY timestamp DESC
            LIMIT 1
          `).get(targetT) as any;
        }

        // Find closest available record after i
        let nextRecord: CenaceHistoryRecord | null = null;
        for (let j = i + 1; j < matchedRecords.length; j++) {
          if (matchedRecords[j] !== null) {
            nextRecord = matchedRecords[j]!;
            break;
          }
        }
        // If not found in yesterday's bounds, query database for closest record after targetT
        if (!nextRecord) {
          nextRecord = db.prepare(`
            SELECT timestamp, accumulated_mwh AS cocaCodoMWh
            FROM coca_codo_hourly_log
            WHERE timestamp > ?
            ORDER BY timestamp ASC
            LIMIT 1
          `).get(targetT) as any;
        }

        if (prevRecord && nextRecord) {
          const timeRange = nextRecord.timestamp - prevRecord.timestamp;
          const timeFraction = (targetT - prevRecord.timestamp) / timeRange;
          const interpolatedMWh = prevRecord.cocaCodoMWh + (nextRecord.cocaCodoMWh - prevRecord.cocaCodoMWh) * timeFraction;
          matchedRecords[i] = { timestamp: targetT, cocaCodoMWh: interpolatedMWh };
          console.log(`[SQLite] Interpolated missing hour at timestamp ${targetT} (${new Date(targetT).toLocaleTimeString()} local): ${interpolatedMWh.toFixed(2)} MWh`);
        } else {
          console.warn(`[SQLite] Cannot interpolate missing hour at timestamp ${targetT}. Aborting.`);
          return null;
        }
      }
    }

    // Calculate the 24 hourly averages in MW on-the-fly, capping at max capacity
    const curve: number[] = [];
    for (let i = 1; i <= 24; i++) {
      const start = matchedRecords[i - 1]!;
      const end = matchedRecords[i]!;
      
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
    console.warn('[SQLite] Error retrieving yesterday hourly curve:', err);
  }
  return null;
}
