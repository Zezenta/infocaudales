import { SatelliteArchiverService } from '../../services/satellite-archiver.service.js';
import { SatelliteMapService } from '../../services/satellite-map.service.js';
import { VideoCompilerService } from '../../services/video-compiler.service.js';

async function main() {
  const satelliteService = new SatelliteMapService();
  const archiver = new SatelliteArchiverService(satelliteService);
  const videoCompiler = new VideoCompilerService(satelliteService);

  console.log('Fetching archived frames...');
  const allFrames = archiver.getArchivedFrames({ limit: 1200, plantKey: 'ecuador' });
  console.log(`Loaded ${allFrames.length} frames.`);

  // 1. Compile Full Timelapse with Live Publication Alert Ticker
  console.log('\n============================================================');
  console.log('🎬 1/2: COMPILANDO TIMELAPSE COMPLETO CON TICKER DE ALERTA DE PUBLICACIÓN');
  console.log('============================================================');

  const fullResult = await videoCompiler.compileFramesToVideo(allFrames, {
    plantKey: 'ecuador',
    outputName: 'goes16_ecuador_timelapse_con_alertas',
    framerate: 8,
    minDurationSeconds: 10,
    customTitle: 'Monitoreo Satelital GOES-16 • Ecuador Continental',
    showAllPins: true,
    showDetectionBoxes: true,
    showPublicationStatusBadge: true,
    createMp4: true,
    createGif: false
  });

  console.log(`✅ [1/2] Video completo con indicador de alertas listo:`);
  console.log(`👉 file://${fullResult.mp4Path} (${fullResult.durationSeconds}s, ${fullResult.sizeBytesMp4} bytes)`);

  // 2. Compile an Example Single-Storm Publication Clip
  // Let's use Evento 13 (La gran tormenta severa de Paute: Oct 7 18:30 ECT a Oct 8 02:00 ECT)
  // Or Evento 12 (Tormenta torrencial en CCS: Oct 7 12:30 ECT a 17:30 ECT)
  console.log('\n============================================================');
  console.log('🎬 2/2: COMPILANDO CLIP INDIVIDUAL DE PUBLICACIÓN (EJEMPLO TORMENTA PAUTE)');
  console.log('============================================================');

  // Filter frames for Evento 13 (Paute: Oct 7 18:30 ECT to Oct 8 01:30 ECT = 2026-10-07T23:30:00Z to 2026-10-08T06:30:00Z)
  const pauteEventFrames = allFrames.filter(f => {
    const ts = f.timestampIso;
    return ts >= '2026-10-07T23:30:00.000Z' && ts <= '2026-10-08T05:30:00.000Z';
  });

  console.log(`Filtered ${pauteEventFrames.length} frames for Paute storm publication clip.`);

  if (pauteEventFrames.length >= 6) {
    const clipResult = await videoCompiler.compileFramesToVideo(pauteEventFrames, {
      plantKey: 'ecuador',
      outputName: 'ejemplo_clip_publicacion_tormenta_paute',
      framerate: 4, // 4 fps for ~36 frames = ~9 seconds clip
      minDurationSeconds: 8,
      customTitle: 'ALERTA METEOROLÓGICA • Tormenta en Complejo Paute',
      showAllPins: true,
      showDetectionBoxes: true,
      showPublicationStatusBadge: true,
      createMp4: true,
      createGif: false
    });

    console.log(`✅ [2/2] Clip de publicación individual listo:`);
    console.log(`👉 file://${clipResult.mp4Path} (${clipResult.durationSeconds}s, ${clipResult.sizeBytesMp4} bytes)`);
  }

  console.log('\n🎉 Proceso completado exitosamente.');
}

main().catch(err => {
  console.error('Error during video compilation:', err);
  process.exit(1);
});
