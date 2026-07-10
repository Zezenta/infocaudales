import fs from 'fs';
import path from 'path';
import { CenaceService } from '../services/cenace.service.js';

export interface CenaceHistoryRecord {
  timestamp: number;
  cocaCodoMWh: number;
}

const HISTORY_FILE_PATH = path.join(__dirname, '..', 'cenace-history.json');
const CSV_FILE_PATH = path.join(__dirname, '..', 'coca-codo-hourly-log.csv');

/**
 * Reads accumulated MWh history records for Coca Codo Sinclair from disk.
 */
export function readCenaceHistory(): CenaceHistoryRecord[] {
  try {
    if (fs.existsSync(HISTORY_FILE_PATH)) {
      const raw = fs.readFileSync(HISTORY_FILE_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[CenaceHistory] Failed to read CENACE history cache:', err);
  }
  return [];
}

/**
 * Reads all records from the CSV file log.
 */
export function readCenaceCsvHistory(): CenaceHistoryRecord[] {
  const records: CenaceHistoryRecord[] = [];
  try {
    if (fs.existsSync(CSV_FILE_PATH)) {
      const content = fs.readFileSync(CSV_FILE_PATH, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim() || line.startsWith('Timestamp')) continue;
        const parts = line.split(',');
        if (parts.length >= 3) {
          const timestamp = Number(parts[0]);
          const cocaCodoMWh = Number(parts[2]);
          if (!isNaN(timestamp) && !isNaN(cocaCodoMWh)) {
            records.push({ timestamp, cocaCodoMWh });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[CenaceHistory] Failed to read CSV log:', err);
  }
  return records;
}

/**
 * Appends a formatted row to the permanent CSV log.
 */
export function appendCenaceCsvLog(timestamp: number, accumulatedMWh: number, hourlyMW: number): void {
  try {
    const dateStr = new Date(timestamp).toLocaleString('en-US', { timeZone: 'America/Guayaquil' });
    const escapedDateStr = `"${dateStr}"`;
    
    if (!fs.existsSync(CSV_FILE_PATH)) {
      fs.writeFileSync(CSV_FILE_PATH, 'Timestamp,DateString,AccumulatedMWh,HourlyMW\n', 'utf-8');
    }
    
    const row = `${timestamp},${escapedDateStr},${accumulatedMWh.toFixed(2)},${hourlyMW.toFixed(2)}\n`;
    fs.appendFileSync(CSV_FILE_PATH, row, 'utf-8');
    console.log(`[CenaceHistory] CSV log appended: CCS at ${accumulatedMWh} MWh, Hourly: ${hourlyMW.toFixed(2)} MW`);
  } catch (err) {
    console.warn('[CenaceHistory] Failed to append to CSV log:', err);
  }
}

/**
 * Saves a new accumulated MWh history record for Coca Codo Sinclair to disk and logs to CSV.
 */
export function saveCenaceHistory(record: CenaceHistoryRecord): void {
  try {
    const history = readCenaceHistory();
    
    let hourlyMW = 0;
    if (history.length > 0) {
      const prev = history[history.length - 1];
      const diffMs = record.timestamp - prev.timestamp;
      const diffHours = diffMs / (1000 * 60 * 60);
      const deltaMWh = record.cocaCodoMWh - prev.cocaCodoMWh;
      if (diffHours > 0.05 && deltaMWh >= 0) {
        hourlyMW = deltaMWh / diffHours;
      }
    }
    
    history.push(record);
    // Keep last 48 records
    const trimmed = history.slice(-48);
    fs.writeFileSync(HISTORY_FILE_PATH, JSON.stringify(trimmed, null, 2));
    
    // Append to CSV log
    appendCenaceCsvLog(record.timestamp, record.cocaCodoMWh, hourlyMW);
  } catch (err) {
    console.warn('[CenaceHistory] Failed to save CENACE history cache:', err);
  }
}

/**
 * Samples Coca Codo Sinclair's current accumulated MWh from CENACE and saves it to history.
 */
export async function recordCenaceBaseline(cenaceService: CenaceService): Promise<void> {
  try {
    const currentMWh = await cenaceService.fetchPlantProduction('cocaCodoSinclair');
    if (currentMWh !== null && currentMWh > 0) {
      const nowMs = Date.now();
      saveCenaceHistory({ timestamp: nowMs, cocaCodoMWh: currentMWh });
      console.log(`[CenaceHistory] Baseline recorded: ${currentMWh} MWh at ${new Date().toLocaleTimeString()}`);
    }
  } catch (err) {
    console.warn(`[CenaceHistory] Failed to record CENACE baseline:`, err);
  }
}

/**
 * Validates and retrieves the Coca Codo Sinclair hourly curve for yesterday from JSON or CSV.
 * Returns null if any of the 24 hourly intervals are missing.
 */
export function getCcsYesterdayHourlyCurve(yesterdayDate: Date): number[] | null {
  // Combine both JSON and CSV histories to find records
  const jsonHistory = readCenaceHistory();
  const csvHistory = readCenaceCsvHistory();
  
  // Merge histories and de-duplicate by timestamp
  const mergedMap = new Map<number, number>();
  for (const r of [...jsonHistory, ...csvHistory]) {
    mergedMap.set(r.timestamp, r.cocaCodoMWh);
  }
  
  const mergedRecords = Array.from(mergedMap.entries()).map(([timestamp, cocaCodoMWh]) => ({
    timestamp,
    cocaCodoMWh
  })).sort((a, b) => a.timestamp - b.timestamp);

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

  for (const targetT of targetTimestamps) {
    const match = mergedRecords.find(r => Math.abs(r.timestamp - targetT) <= tolerance);
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
    
    curve.push(deltaMWh / diffHours);
  }

  return curve;
}
