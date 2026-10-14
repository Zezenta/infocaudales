import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { db } from '../../utils/db.js';
import { SatelliteArchiverService } from '../../services/satellite-archiver.service.js';
import { SatelliteMapService } from '../../services/satellite-map.service.js';
import { VideoCompilerService } from '../../services/video-compiler.service.js';

async function main() {
  console.log('🛰️ ============================================================');
  console.log('🔄 RE-DESCARGA COMPLETA DE FOTOGRAMAS NASA GIBS (24 HORAS)');
  console.log('============================================================\n');

  const satService = new SatelliteMapService();
  const archiver = new SatelliteArchiverService(satService);
  const compiler = new VideoCompilerService(satService);

  // 1. Limpiar fotogramas existentes de NASA GIBS
  const existingNasaRows = db.prepare(`
    SELECT file_path FROM satellite_archive WHERE source = 'nasa_gibs'
  `).all() as Array<{ file_path: string }>;

  console.log(`🧹 Eliminando ${existingNasaRows.length} fotogramas antiguos/incompletos de NASA en disco y SQLite...`);
  for (const row of existingNasaRows) {
    try {
      if (fs.existsSync(row.file_path)) {
        fs.unlinkSync(row.file_path);
      }
      const jsonMetaPath = row.file_path.replace(/\.png$/, '.json');
      if (fs.existsSync(jsonMetaPath)) {
        fs.unlinkSync(jsonMetaPath);
      }
    } catch {}
  }

  db.prepare(`DELETE FROM satellite_archive WHERE source = 'nasa_gibs'`).run();
  console.log('   ✅ Registros anteriores de NASA limpiados.\n');

  // 2. Descargar 144 fotogramas continuos (24 horas atrás)
  console.log('⬇️ 2. Descargando 144 fotogramas (24 horas) continuos desde NASA GIBS...');
  const tStart = Date.now();
  const result = await archiver.archiveLatestFrames({
    limit: 144,
    source: 'nasa_gibs',
    plantKey: 'ecuador'
  });
  const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(1);

  console.log(`\n   ✅ Descarga completada en ${elapsedSec}s:`);
  console.log(`   • Escaneados: ${result.scanned}`);
  console.log(`   • Descargados con éxito: ${result.downloaded}`);
  console.log(`   • Omitidos/Fallidos: ${result.skipped}`);
  console.log(`   • Fotograma más reciente: ${result.newestTimestamp}\n`);

  // 3. Verificar fotogramas en BD
  const nasaFrames = archiver.getArchivedFrames({ limit: 144, source: 'nasa_gibs', plantKey: 'ecuador' });
  console.log(`📊 Total fotogramas válidos de NASA disponibles: ${nasaFrames.length}`);

  if (nasaFrames.length < 6) {
    throw new Error('No se obtuvieron suficientes fotogramas de NASA.');
  }

  // 4. Compilar video de prueba reciente (últimas 24 frames = 4 horas)
  const recent24Frames = archiver.getArchivedFrames({ limit: 24, source: 'nasa_gibs', plantKey: 'ecuador', latest: true });
  console.log(`\n🎥 4. Compilando video de prueba NASA GIBS (24 frames recientes)...`);
  const recentRes = await compiler.compileFramesToVideo(recent24Frames, {
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

  console.log(`   ✅ Video reciente compilado con éxito:`);
  console.log(`   • Archivo: ${recentRes.mp4Path}`);
  console.log(`   • Duración: ${recentRes.durationSeconds}s`);
  console.log(`   • Tamaño: ${(recentRes.sizeBytesMp4! / 1024).toFixed(1)} KB`);

  // 5. Compilar video completo de 24 horas (todos los 144 frames)
  console.log(`\n🎥 5. Compilando video completo de 24 horas NASA GIBS (144 frames)...`);
  const fullRes = await compiler.compileFramesToVideo(nasaFrames, {
    plantKey: 'ecuador',
    outputName: 'test_video_nasa_gibs_24h_full',
    framerate: 12,
    minDurationSeconds: 12,
    customTitle: 'Resumen Satelital 24 Horas GOES-16 • NASA GIBS',
    showAllPins: true,
    showDetectionBoxes: true,
    showThermalScale: true,
    createMp4: true,
    createGif: false
  });

  console.log(`   ✅ Video 24h compilado con éxito:`);
  console.log(`   • Archivo: ${fullRes.mp4Path}`);
  console.log(`   • Duración: ${fullRes.durationSeconds}s`);
  console.log(`   • Tamaño: ${(fullRes.sizeBytesMp4! / 1024).toFixed(1)} KB`);

  console.log('\n🎉 ¡Proceso finalizado con éxito!');
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
