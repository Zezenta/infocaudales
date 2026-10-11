import { SatelliteMapService } from '../../services/satellite-map.service.js';
import { SatelliteArchiverService } from '../../services/satellite-archiver.service.js';
import { db } from '../../utils/db.js';

async function main() {
  const satelliteService = new SatelliteMapService();
  const archiver = new SatelliteArchiverService(satelliteService);

  const dbMax = db.prepare('SELECT max(timestamp_iso) as max_ts FROM satellite_archive').get() as any;
  console.log('Current DB max timestamp:', dbMax?.max_ts);

  const available = await satelliteService.fetchGoesTimestamps({ limit: 200 });
  console.log(`GeoServer reports ${available.length} available timestamps.`);
  if (available.length > 0) {
    console.log('Newest on GeoServer:', available[0]);
    console.log('Oldest in batch (limit 200):', available[available.length - 1]);
  }

  // How many are missing from DB?
  let missing = 0;
  for (const ts of available) {
    const exists = db.prepare('SELECT 1 FROM satellite_archive WHERE timestamp_iso = ?').get(ts);
    if (!exists) missing++;
  }
  console.log(`Missing frames from this batch of 200: ${missing}`);

  // Archive all missing frames!
  console.log('Downloading and archiving all missing frames now...');
  const result = await archiver.archiveLatestFrames({ limit: 200, plantKey: 'ecuador' });
  console.log(`Archiving result: downloaded=${result.downloaded}, skipped=${result.skipped}`);

  const updatedMax = db.prepare('SELECT count(*) as count, max(timestamp_iso) as max_ts FROM satellite_archive').get() as any;
  console.log(`Updated archive in DB: total=${updatedMax.count}, max_ts=${updatedMax.max_ts}`);
}

main().catch(console.error);
