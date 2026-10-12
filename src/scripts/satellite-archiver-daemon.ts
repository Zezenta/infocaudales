import { SatelliteArchiverService } from '../services/satellite-archiver.service.js';
import { SatelliteMapService } from '../services/satellite-map.service.js';

const POLL_INTERVAL_SECONDS = parseInt(process.env.ARCHIVE_INTERVAL_SECONDS || '600', 10); // default: 10 min
const FRAME_SCAN_LIMIT = parseInt(process.env.FRAME_SCAN_LIMIT || '18', 10); // scan last 18 frames (~3 hours)

const satelliteService = new SatelliteMapService();
const archiver = new SatelliteArchiverService(satelliteService);

console.log('============================================================');
console.log('🛰️ INFOCAUDALES • ARCHIVADOR SATELITAL GOES-16');
console.log('============================================================');
console.log(`• Intervalo de escaneo satelital: cada ${POLL_INTERVAL_SECONDS} segundos (${(POLL_INTERVAL_SECONDS / 60).toFixed(1)} min)`);
console.log(`• Capa satelital: GOES-16 Banda 13 IR (10.3 µm) + Provincias Ecuador`);
console.log(`• Directorio local de archivo: data/satellite_archive/`);
console.log('============================================================\n');

async function syncArchive() {
  const nowEcuador = new Date().toLocaleTimeString('es-EC', { timeZone: 'America/Guayaquil' });
  console.log(`[${nowEcuador} ECT] Comprobando nuevos fotogramas en GeoServer...`);

  try {
    const result = await archiver.archiveLatestFrames({
      limit: FRAME_SCAN_LIMIT,
      plantKey: 'ecuador'
    });

    const stats = archiver.getStats();

    if (result.downloaded > 0) {
      console.log(
        `  📥 [Archiver] +${result.downloaded} fotograma(s) nuevo(s) descargado(s) y guardado(s) a disco.`
      );
    } else {
      console.log(`  ✨ [Archiver] Archivo al día. Todos los fotogramas ya estaban en disco (saltados: ${result.skipped}).`);
    }

    console.log(
      `  📊 [Estado] Total acumulado: ${stats.totalFrames} fotogramas (${stats.totalSizeMb} MB) | Rango: ${stats.oldestTimestamp?.slice(0, 16) || 'N/A'} a ${stats.newestTimestamp?.slice(0, 16) || 'N/A'}`
    );
  } catch (err: any) {
    console.error(`  ❌ [Archiver Error]:`, err?.message || err);
  }
}

// Initial sync and scheduled polling
async function main() {
  await syncArchive();

  // Schedule recurring sync
  setInterval(syncArchive, POLL_INTERVAL_SECONDS * 1000);
}

main().catch(err => {
  console.error('Fatal archiver daemon error:', err);
});

