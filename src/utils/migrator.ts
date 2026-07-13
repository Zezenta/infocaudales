import fs from 'fs';
import path from 'path';
import { db } from './db.js';

const JSON_PATH = path.join(__dirname, '..', 'cenace-history.json');
const CSV_PATH = path.join(__dirname, '..', 'coca-codo-hourly-log.csv');

export function runMigration(): void {
  try {
    let jsonMigratedCount = 0;
    let csvMigratedCount = 0;

    // 1. Migrate JSON History
    if (fs.existsSync(JSON_PATH)) {
      console.log('[Migrator] Found legacy JSON history cache. Starting import...');
      const raw = fs.readFileSync(JSON_PATH, 'utf-8');
      const records = JSON.parse(raw);
      
      const insertRaw = db.prepare(`
        INSERT OR IGNORE INTO coca_codo_raw_history (timestamp, accumulated_mwh)
        VALUES (?, ?)
      `);

      const insertMany = db.transaction((rows: any[]) => {
        for (const row of rows) {
          const res = insertRaw.run(row.timestamp, row.cocaCodoMWh);
          if (res.changes > 0) jsonMigratedCount++;
        }
      });

      if (Array.isArray(records)) {
        insertMany(records);
      }
    }

    // 2. Migrate CSV Logs
    if (fs.existsSync(CSV_PATH)) {
      console.log('[Migrator] Found legacy CSV hourly log. Starting import...');
      const content = fs.readFileSync(CSV_PATH, 'utf-8');
      const lines = content.split('\n');

      const insertRaw = db.prepare(`
        INSERT OR IGNORE INTO coca_codo_raw_history (timestamp, accumulated_mwh)
        VALUES (?, ?)
      `);

      const insertHourly = db.prepare(`
        INSERT OR IGNORE INTO hourly_telemetry (timestamp, plant_key, generation_mw, caudal_flow, cota_level)
        VALUES (?, 'cocaCodoSinclair', ?, 0, NULL)
      `);

      const migrationTx = db.transaction((rows: any[]) => {
        for (const row of rows) {
          const resRaw = insertRaw.run(row.timestamp, row.accumulatedMWh);
          const resHourly = insertHourly.run(row.timestamp, row.hourlyMW);
          if (resRaw.changes > 0 || resHourly.changes > 0) {
            csvMigratedCount++;
          }
        }
      });

      const parsedRows: any[] = [];
      for (const line of lines) {
        if (!line.trim() || line.startsWith('Timestamp')) continue;
        const parts = line.split(',');
        if (parts.length >= 4) {
          const timestamp = Number(parts[0]);
          const accumulatedMWh = Number(parts[2]);
          const hourlyMW = Number(parts[3]);
          if (!isNaN(timestamp) && !isNaN(accumulatedMWh) && !isNaN(hourlyMW)) {
            parsedRows.push({ timestamp, accumulatedMWh, hourlyMW });
          }
        }
      }

      if (parsedRows.length > 0) {
        migrationTx(parsedRows);
      }
    }

    if (jsonMigratedCount > 0 || csvMigratedCount > 0) {
      console.log(`[Migrator] Migration complete: Imported ${jsonMigratedCount} JSON records and ${csvMigratedCount} CSV records into SQLite.`);
    }
  } catch (err) {
    console.error('[Migrator] Error running migration to SQLite:', err);
  }
}
