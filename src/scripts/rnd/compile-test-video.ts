import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { SatelliteArchiverService } from '../../services/satellite-archiver.service.js';
import { SatelliteMapService } from '../../services/satellite-map.service.js';
import { VideoCompilerService } from '../../services/video-compiler.service.js';

async function main() {
  console.log('🎬 ============================================================');
  console.log('🎥 COMPILACIÓN DE VIDEOS DE PRUEBA (fb-ig)');
  console.log('============================================================\n');

  const satService = new SatelliteMapService();
  const archiver = new SatelliteArchiverService(satService);
  const videoCompiler = new VideoCompilerService(satService);

  // 1. Video de prueba con fotogramas GEOGLOWS
  console.log('📹 1. Cargando fotogramas recientes de GEOGLOWS...');
  const geoFrames = archiver.getArchivedFrames({ limit: 24, source: 'geoserver', plantKey: 'ecuador', latest: true });
  console.log(`   • Fotogramas disponibles: ${geoFrames.length}`);

  if (geoFrames.length >= 6) {
    console.log(`   • Rango: ${geoFrames[0].dateEcuador} ${geoFrames[0].timeEcuador} ECT -> ${geoFrames[geoFrames.length - 1].dateEcuador} ${geoFrames[geoFrames.length - 1].timeEcuador} ECT`);
    const geoCompilation = await videoCompiler.compileFramesToVideo(geoFrames, {
      plantKey: 'ecuador',
      outputName: 'test_video_geoglows',
      framerate: 8,
      minDurationSeconds: 10,
      customTitle: 'Monitoreo Satelital GOES-16 • GEOGLOWS (GeoServer)',
      showAllPins: true,
      showDetectionBoxes: true,
      showThermalScale: true,
      createMp4: true,
      createGif: false
    });
    console.log(`   ✅ Video GEOGLOWS MP4 generado con éxito:`);
    console.log(`      - Ruta: ${geoCompilation.mp4Path}`);
    console.log(`      - Duración: ${geoCompilation.durationSeconds}s`);
    console.log(`      - Tamaño: ${(geoCompilation.sizeBytesMp4! / 1024).toFixed(1)} KB`);
    console.log(`      - Frames por ciclo: ${geoCompilation.frameCount}\n`);
  } else {
    console.log('   ⚠️ No hay suficientes fotogramas de GEOGLOWS (mínimo 6).\n');
  }

  // 2. Video de prueba con fotogramas NASA GIBS
  console.log('🛰️ 2. Cargando fotogramas recientes de NASA GIBS...');
  const nasaFrames = archiver.getArchivedFrames({ limit: 24, source: 'nasa_gibs', plantKey: 'ecuador', latest: true });
  console.log(`   • Fotogramas disponibles: ${nasaFrames.length}`);

  if (nasaFrames.length >= 6) {
    console.log(`   • Rango: ${nasaFrames[0].dateEcuador} ${nasaFrames[0].timeEcuador} ECT -> ${nasaFrames[nasaFrames.length - 1].dateEcuador} ${nasaFrames[nasaFrames.length - 1].timeEcuador} ECT`);
    const nasaCompilation = await videoCompiler.compileFramesToVideo(nasaFrames, {
      plantKey: 'ecuador',
      outputName: 'test_video_nasa_gibs',
      framerate: 8,
      minDurationSeconds: 10,
      customTitle: 'Monitoreo Satelital GOES-16 • NASA GIBS',
      showAllPins: true,
      showDetectionBoxes: true,
      showThermalScale: true,
      createMp4: true,
      createGif: false
    });
    console.log(`   ✅ Video NASA GIBS MP4 generado con éxito:`);
    console.log(`      - Ruta: ${nasaCompilation.mp4Path}`);
    console.log(`      - Duración: ${nasaCompilation.durationSeconds}s`);
    console.log(`      - Tamaño: ${(nasaCompilation.sizeBytesMp4! / 1024).toFixed(1)} KB`);
    console.log(`      - Frames por ciclo: ${nasaCompilation.frameCount}\n`);
  } else {
    console.log('   ⚠️ No hay suficientes fotogramas de NASA GIBS (mínimo 6).\n');
  }

  console.log('🎉 Compilación de prueba completada exitosamente.');
}

main().catch(err => {
  console.error('❌ Error compilando videos de prueba:', err);
  process.exit(1);
});
