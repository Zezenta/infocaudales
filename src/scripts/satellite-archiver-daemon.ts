import { SatelliteArchiverService } from '../services/satellite-archiver.service.js';
import { SatelliteMapService } from '../services/satellite-map.service.js';
import { VideoCompilerService } from '../services/video-compiler.service.js';
import { RainMonitorService } from '../services/rain-monitor.service.js';

const POLL_INTERVAL_SECONDS = parseInt(process.env.ARCHIVE_INTERVAL_SECONDS || '600', 10); // default: 10 min
const FRAME_SCAN_LIMIT = parseInt(process.env.FRAME_SCAN_LIMIT || '18', 10); // scan last 18 frames (~3 hours)

const satelliteService = new SatelliteMapService();
const archiver = new SatelliteArchiverService(satelliteService);
const videoCompilerService = new VideoCompilerService(satelliteService);
const rainMonitorService = new RainMonitorService(satelliteService, videoCompilerService);

console.log('============================================================');
console.log('🛰️ INFOCAUDALES • ARCHIVADOR SATELITAL & MONITOR DE TORMENTAS');
console.log('============================================================');
console.log(`• Intervalo de escaneo y aviso: cada ${POLL_INTERVAL_SECONDS} segundos (${(POLL_INTERVAL_SECONDS / 60).toFixed(1)} min)`);
console.log(`• Capa satelital: GOES-16 Banda 13 IR (10.3 µm) + Provincias Ecuador`);
console.log(`• Cuencas monitoreadas: Coca Codo Sinclair, Paute`);
console.log(`• Directorio local de archivo: data/satellite_archive/`);
console.log('============================================================\n');

async function checkStorms() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('es-EC', {
    timeZone: 'America/Guayaquil',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const basins = [
    { key: 'cocaCodoSinclair', name: 'Coca Codo Sinclair' },
    { key: 'paute', name: 'Paute' }
  ];

  const activeStorms: string[] = [];
  const endedStorms: string[] = [];
  const basinStatus: string[] = [];

  for (const b of basins) {
    try {
      const result = await rainMonitorService.checkBasin(b.key, {
        autoCompileVideo: true,
        autoPublishToX: false,
        tileResolution: 80
      });

      basinStatus.push(`${b.name}: ${result.coveragePct}%`);

      if (result.action === 'STORM_STARTED' || result.action === 'STORM_MONITORING') {
        activeStorms.push(b.name);
      } else if (result.action === 'VIDEO_COMPILED' || result.action === 'TRIGGER_COMPILATION') {
        endedStorms.push(b.name);
      }
    } catch (err: any) {
      basinStatus.push(`${b.name}: ${err?.message || 'error'}`);
    }
  }

  // Formato exacto solicitado:
  // [hora] no hay tormenta en ninguna cuenca
  // [hora] hay tormenta en x cuenca
  // [hora] hay tormenta en x cuenca y en x cuenca
  // [hora] terminó la tormenta en x cuenca
  if (endedStorms.length > 0) {
    console.log(`[${timeStr}] terminó la tormenta en ${endedStorms.join(' y en ')}`);
  }

  if (activeStorms.length === 0) {
    console.log(`[${timeStr}] no hay tormenta en ninguna cuenca (${basinStatus.join(', ')})`);
  } else if (activeStorms.length === 1) {
    console.log(`[${timeStr}] hay tormenta en ${activeStorms[0]} (${basinStatus.join(', ')})`);
  } else {
    console.log(`[${timeStr}] hay tormenta en ${activeStorms.join(' y en ')} (${basinStatus.join(', ')})`);
  }
}

async function syncArchive() {
  const nowEcuador = new Date().toLocaleTimeString('es-EC', { timeZone: 'America/Guayaquil' });

  try {
    const result = await archiver.archiveLatestFrames({
      limit: FRAME_SCAN_LIMIT,
      plantKey: 'ecuador'
    });

    const stats = archiver.getStats();

    if (result.downloaded > 0) {
      console.log(
        `[Archiver ${nowEcuador}] +${result.downloaded} fotograma(s) nuevo(s) descargado(s) y guardado(s) a disco. Total: ${stats.totalFrames} frames.`
      );
    }
  } catch (err: any) {
    // GeoServer might be indexing
  }

  // Check storm activity in monitored basins
  await checkStorms();
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
