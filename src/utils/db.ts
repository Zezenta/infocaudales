import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(process.cwd(), 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const DB_PATH = path.join(dataDir, 'infocaudales.db');
export const db = new Database(DB_PATH);

// Dynamically drop table to recreate it if transitioning from the older schema containing hourly_mw
try {
  const tableInfo = db.pragma('table_info(coca_codo_hourly_log)') as any[];
  const hasHourlyMw = tableInfo.some(col => col.name === 'hourly_mw');
  if (hasHourlyMw) {
    console.log('[SQLite] Dropping old coca_codo_hourly_log table containing stale hourly_mw column...');
    db.exec('DROP TABLE IF EXISTS coca_codo_hourly_log');
  }
} catch (e) {
  // Table might not exist yet
}

// Clean up unused old tables to free database space
db.exec(`
  DROP TABLE IF EXISTS coca_codo_raw_history;
  DROP TABLE IF EXISTS hourly_telemetry;
`);

// Initialize Database Schema (strictly raw accumulated MWh tracking)
db.exec(`
  CREATE TABLE IF NOT EXISTS coca_codo_hourly_log (
    timestamp INTEGER PRIMARY KEY,
    accumulated_mwh REAL NOT NULL
  );
`);

console.log('[SQLite] Database initialized at:', DB_PATH);
