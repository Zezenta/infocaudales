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
        INSERT OR IGNORE INTO coca_codo_hourly_log (timestamp, accumulated_mwh)
        VALUES (?, ?)
      `);

      const insertMany = db.transaction((rows: any[]) => {
        for (const row of rows) {
          const hourlyTimestamp = Math.round(row.timestamp / (3600 * 1000)) * (3600 * 1000);
          const res = insertRaw.run(hourlyTimestamp, row.cocaCodoMWh);
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
        INSERT OR IGNORE INTO coca_codo_hourly_log (timestamp, accumulated_mwh)
        VALUES (?, ?)
      `);

      const migrationTx = db.transaction((rows: any[]) => {
        for (const row of rows) {
          const hourlyTimestamp = Math.round(row.timestamp / (3600 * 1000)) * (3600 * 1000);
          const resRaw = insertRaw.run(hourlyTimestamp, row.accumulatedMWh);
          if (resRaw.changes > 0) {
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
          if (!isNaN(timestamp) && !isNaN(accumulatedMWh)) {
            parsedRows.push({ timestamp, accumulatedMWh });
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
