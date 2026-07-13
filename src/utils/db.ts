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
  CREATE TABLE IF NOT EXISTS coca_codo_raw_history (
    timestamp INTEGER PRIMARY KEY,
    accumulated_mwh REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hourly_telemetry (
    timestamp INTEGER,
    plant_key TEXT,
    generation_mw REAL NOT NULL,
    caudal_flow REAL NOT NULL,
    cota_level REAL,
    PRIMARY KEY (timestamp, plant_key)
  );

  CREATE INDEX IF NOT EXISTS idx_telemetry_range ON hourly_telemetry (timestamp, plant_key);
`);

console.log('[SQLite] Database initialized at:', DB_PATH);
