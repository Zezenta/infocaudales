import { CenaceService } from '../services/cenace.service.js';
import { db } from './db.js';
import { dbLogger } from './logger.js';

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
    dbLogger.warn(`Failed to read CENACE history from DB: ${err}`);
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

    dbLogger.info(`Saved hourly baseline: ${record.cocaCodoMWh} MWh at timestamp ${hourlyTimestamp}`);
  } catch (err) {
    dbLogger.warn(`Failed to save CENACE history to DB: ${err}`);
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
      dbLogger.info(`Baseline recorded: ${currentMWh} MWh at ${new Date().toLocaleTimeString()}`);
    }
  } catch (err) {
    dbLogger.warn(`Failed to record CENACE baseline: ${err}`);
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
      dbLogger.warn(`Too many missing hourly readings for yesterday (${25 - foundCount} missing). Aborting curve generation.`);
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
        // If still not found (e.g. database has no history before targetT), fallback to backward extrapolation from first available points
        if (!prevRecord) {
          let firstAvailableIdx = -1;
          for (let j = 0; j < matchedRecords.length; j++) {
            if (matchedRecords[j] !== null) {
              firstAvailableIdx = j;
              break;
            }
          }
          if (firstAvailableIdx !== -1) {
            const firstAvailable = matchedRecords[firstAvailableIdx]!;
            let secondAvailable: CenaceHistoryRecord | null = null;
            for (let j = firstAvailableIdx + 1; j < matchedRecords.length; j++) {
              if (matchedRecords[j] !== null) {
                secondAvailable = matchedRecords[j]!;
                break;
              }
            }
            const rate = secondAvailable
              ? (secondAvailable.cocaCodoMWh - firstAvailable.cocaCodoMWh) / ((secondAvailable.timestamp - firstAvailable.timestamp) / (3600 * 1000))
              : 500; // fallback to 500 MW rate
            const hoursDiff = (firstAvailable.timestamp - targetT) / (3600 * 1000);
            const extrapolatedMWh = Math.max(0, firstAvailable.cocaCodoMWh - rate * hoursDiff);
            prevRecord = { timestamp: targetT, cocaCodoMWh: extrapolatedMWh };
          }
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
        // If still not found (e.g. database has no history after targetT), fallback to forward extrapolation from last available points
        if (!nextRecord) {
          let lastAvailableIdx = -1;
          for (let j = matchedRecords.length - 1; j >= 0; j--) {
            if (matchedRecords[j] !== null) {
              lastAvailableIdx = j;
              break;
            }
          }
          if (lastAvailableIdx !== -1) {
            const lastAvailable = matchedRecords[lastAvailableIdx]!;
            let secondToLastAvailable: CenaceHistoryRecord | null = null;
            for (let j = lastAvailableIdx - 1; j >= 0; j--) {
              if (matchedRecords[j] !== null) {
                secondToLastAvailable = matchedRecords[j]!;
                break;
              }
            }
            const rate = secondToLastAvailable
              ? (lastAvailable.cocaCodoMWh - secondToLastAvailable.cocaCodoMWh) / ((lastAvailable.timestamp - secondToLastAvailable.timestamp) / (3600 * 1000))
              : 500;
            const hoursDiff = (targetT - lastAvailable.timestamp) / (3600 * 1000);
            const extrapolatedMWh = lastAvailable.cocaCodoMWh + rate * hoursDiff;
            nextRecord = { timestamp: targetT, cocaCodoMWh: extrapolatedMWh };
          }
        }

        if (prevRecord && nextRecord) {
          const timeRange = nextRecord.timestamp - prevRecord.timestamp;
          const timeFraction = (targetT - prevRecord.timestamp) / timeRange;
          const interpolatedMWh = prevRecord.cocaCodoMWh + (nextRecord.cocaCodoMWh - prevRecord.cocaCodoMWh) * timeFraction;
          matchedRecords[i] = { timestamp: targetT, cocaCodoMWh: interpolatedMWh };
          dbLogger.info(`Interpolated missing hour at timestamp ${targetT} (${new Date(targetT).toLocaleTimeString()} local): ${interpolatedMWh.toFixed(2)} MWh`);
        } else {
          dbLogger.warn(`Cannot interpolate missing hour at timestamp ${targetT}. Aborting.`);
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
      let deltaMWh = end.cocaCodoMWh - start.cocaCodoMWh;
      if (deltaMWh < 0) {
        // Midnight counter reset: at 00:00 local time, CENACE resets its accumulated MWh counter to 0.
        // Therefore, end.cocaCodoMWh at 01:00 AM represents the generation accumulated since midnight.
        deltaMWh = end.cocaCodoMWh;
      }
      
      if (diffHours <= 0.05 || deltaMWh < 0) {
        return null; // Invalid reading interval
      }
      
      const rawRate = deltaMWh / diffHours;
      curve.push(Math.min(rawRate, 1500)); // Cap at Coca Codo Sinclair max capacity
    }

    return curve;
  } catch (err) {
    dbLogger.warn(`Error retrieving yesterday hourly curve: ${err}`);
  }
  return null;
}
