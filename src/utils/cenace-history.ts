import fs from 'fs';
import path from 'path';

export interface CenaceHistoryRecord {
  timestamp: number;
  cocaCodoMWh: number;
}

const HISTORY_FILE_PATH = path.join(__dirname, '..', 'cenace-history.json');

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
 * Saves a new accumulated MWh history record for Coca Codo Sinclair to disk.
 */
export function saveCenaceHistory(record: CenaceHistoryRecord): void {
  try {
    const history = readCenaceHistory();
    history.push(record);
    // Keep last 48 records
    const trimmed = history.slice(-48);
    fs.writeFileSync(HISTORY_FILE_PATH, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    console.warn('[CenaceHistory] Failed to save CENACE history cache:', err);
  }
}
