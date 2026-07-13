import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(process.cwd(), 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const DB_PATH = path.join(dataDir, 'infocaudales.db');
export const db = new Database(DB_PATH);

// Initialize Database Schema (strictly raw accumulated MWh tracking)
db.exec(`
  CREATE TABLE IF NOT EXISTS coca_codo_hourly_log (
    timestamp INTEGER PRIMARY KEY,
    accumulated_mwh REAL NOT NULL
  );
`);

console.log('[SQLite] Database initialized at:', DB_PATH);
