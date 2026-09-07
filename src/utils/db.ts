import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(process.cwd(), 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const DB_PATH = path.join(dataDir, 'infocaudales.db');
export const db = new Database(DB_PATH);

// Initialize Database Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS coca_codo_hourly_log (
    timestamp INTEGER PRIMARY KEY,
    accumulated_mwh REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS forecast_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plant_key TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    target_time INTEGER NOT NULL,
    horizon_hours INTEGER NOT NULL,
    model_name TEXT NOT NULL,
    initial_flow REAL NOT NULL,
    predicted_flow REAL NOT NULL,
    p10 REAL NOT NULL,
    p25 REAL NOT NULL,
    p75 REAL NOT NULL,
    p90 REAL NOT NULL,
    mae_expected REAL NOT NULL,
    actual_flow REAL,
    resolved_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_forecast_unresolved 
    ON forecast_logs (plant_key, target_time) 
    WHERE actual_flow IS NULL;

  CREATE INDEX IF NOT EXISTS idx_forecast_issued 
    ON forecast_logs (issued_at);

  CREATE INDEX IF NOT EXISTS idx_forecast_target 
    ON forecast_logs (target_time);
`);

console.log('[SQLite] Database initialized at:', DB_PATH);
