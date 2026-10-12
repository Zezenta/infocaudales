import dotenv from 'dotenv';
dotenv.config();

import { SatelliteArchiverService } from '../../services/satellite-archiver.service.js';
import { SatelliteMapService } from '../../services/satellite-map.service.js';
import { VideoCompilerService } from '../../services/video-compiler.service.js';
import { XService } from '../../services/x.service.js';

async function run() {
  console.log('🎬 1. Obteniendo 6 fotogramas recientes del archivo satelital...');
  const satService = new SatelliteMapService();
  const archiver = new SatelliteArchiverService(satService);
  const videoCompiler = new VideoCompilerService(satService);
  const xService = new XService();

  // Get the latest 6 frames
  const allRecent = archiver.getArchivedFrames({ limit: 6, plantKey: 'ecuador', latest: true });
  if (allRecent.length < 6) {
    throw new Error(`Se requieren al menos 6 fotogramas, se encontraron: ${allRecent.length}`);
  }

  console.log(`   ✅ ${allRecent.length} fotogramas cargados.`);
  console.log(`   Rango: ${allRecent[0].timeEcuador} a ${allRecent[allRecent.length - 1].timeEcuador} ECT`);

  console.log('🎥 2. Compilando video de 6 frames con duración de 10 segundos...');
  const compilation = await videoCompiler.compileFramesToVideo(allRecent, {
    plantKey: 'ecuador',
    outputName: 'test_6frames_10s',
    framerate: 3,
    minDurationSeconds: 10,
    customTitle: 'Prueba de Monitoreo Satelital GOES-16',
    showAllPins: true,
    showDetectionBoxes: true,
    createMp4: true,
    createGif: false
  });

  console.log(`   ✅ Video MP4 generado exitosamente:`);
  console.log(`   Ruta: ${compilation.mp4Path}`);
  console.log(`   Duración: ${compilation.durationSeconds}s`);
  console.log(`   Tamaño: ${(compilation.sizeBytesMp4! / 1024).toFixed(1)} KB`);

  console.log('🐦 3. Subiendo video y publicando en la cuenta de X con caption "Test"...');
  const tweetResult = await xService.postVideo('Test', compilation.mp4Path!);

  console.log('============================================================');
  console.log('🎉 TWEET PUBLICADO CON ÉXITO');
  console.log('============================================================');
  const tweetId = tweetResult?.data?.id || (tweetResult as any)?.id;
  console.log(`• Tweet ID: ${tweetId}`);
  if (tweetId) {
    console.log(`• Enlace: https://x.com/i/status/${tweetId}`);
  }
  console.log('• Respuesta completa:', JSON.stringify(tweetResult, null, 2));
}

run().catch(err => {
  console.error('❌ Error durante la prueba de publicación:', err);
  process.exit(1);
});
