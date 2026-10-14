import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(process.cwd(), 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
const defaultDbName = isTestEnv ? 'infocaudales.test.db' : 'infocaudales.db';
const DB_PATH = process.env.DB_PATH || path.join(dataDir, defaultDbName);
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

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

  CREATE TABLE IF NOT EXISTS rain_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plant_key TEXT NOT NULL,
    status TEXT NOT NULL, -- 'ACTIVE', 'COMPILING', 'COOLDOWN', 'CLOSED'
    detected_at INTEGER NOT NULL,
    last_checked_at INTEGER NOT NULL,
    peak_coverage_pct REAL NOT NULL,
    last_coverage_pct REAL NOT NULL,
    video_compiled_at INTEGER,
    video_path TEXT,
    video_duration_seconds REAL,
    cooldown_until INTEGER NOT NULL,
    published_at INTEGER,
    tweet_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_rain_events_plant_status 
    ON rain_events (plant_key, status);

  CREATE TABLE IF NOT EXISTS satellite_archive (
    timestamp_iso TEXT NOT NULL,
    date_ecuador TEXT NOT NULL,
    time_ecuador TEXT NOT NULL,
    plant_key TEXT NOT NULL DEFAULT 'ecuador',
    file_path TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'geoserver',
    PRIMARY KEY (timestamp_iso, source)
  );

  CREATE INDEX IF NOT EXISTS idx_satellite_archive_ts 
    ON satellite_archive (timestamp_iso);
  CREATE INDEX IF NOT EXISTS idx_satellite_archive_src_ts 
    ON satellite_archive (source, timestamp_iso);
`);

try {
  db.exec(`ALTER TABLE rain_events ADD COLUMN published_at INTEGER;`);
} catch {}
try {
  db.exec(`ALTER TABLE rain_events ADD COLUMN tweet_id TEXT;`);
} catch {}
try {
  // Check if primary key on satellite_archive already includes source
  const tableInfo = db.prepare("PRAGMA table_info(satellite_archive)").all() as Array<{ name: string; pk: number }>;
  const sourceCol = tableInfo.find(c => c.name === 'source');
  if (!sourceCol || sourceCol.pk === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS satellite_archive_v2 (
        timestamp_iso TEXT NOT NULL,
        date_ecuador TEXT NOT NULL,
        time_ecuador TEXT NOT NULL,
        plant_key TEXT NOT NULL DEFAULT 'ecuador',
        file_path TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'geoserver',
        PRIMARY KEY (timestamp_iso, source)
      );
      INSERT OR IGNORE INTO satellite_archive_v2 (
        timestamp_iso, date_ecuador, time_ecuador, plant_key, file_path, file_size_bytes, recorded_at, source
      )
      SELECT 
        timestamp_iso, date_ecuador, time_ecuador, plant_key, file_path, file_size_bytes, recorded_at, COALESCE(source, 'geoserver')
      FROM satellite_archive;
      DROP TABLE satellite_archive;
      ALTER TABLE satellite_archive_v2 RENAME TO satellite_archive;
      CREATE INDEX IF NOT EXISTS idx_satellite_archive_ts ON satellite_archive (timestamp_iso);
      CREATE INDEX IF NOT EXISTS idx_satellite_archive_src_ts ON satellite_archive (source, timestamp_iso);
    `);
  }
} catch (migErr) {
  // Migration already completed or handled
}

console.log('[SQLite] Database initialized at:', DB_PATH);
