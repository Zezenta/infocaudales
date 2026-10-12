import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SatelliteArchiverService } from '../../services/satellite-archiver.service.js';
import { SatelliteMapService } from '../../services/satellite-map.service.js';
import { VideoCompilerService } from '../../services/video-compiler.service.js';
import { buildStormAlertPostText } from '../../utils/post-formatter.js';

const execFileAsync = promisify(execFile);

async function run() {
  console.log('🎬 1. Cargando 16 fotogramas recientes para el video de alerta...');
  const satService = new SatelliteMapService();
  const archiver = new SatelliteArchiverService(satService);
  const videoCompiler = new VideoCompilerService(satService);

  // Fetch the latest 16 frames (approx 2h 40m window)
  const frames = archiver.getArchivedFrames({ limit: 16, plantKey: 'ecuador', latest: true });
  if (frames.length < 6) {
    throw new Error(`Se requieren fotogramas, encontrados: ${frames.length}`);
  }

  console.log(`   ✅ ${frames.length} fotogramas cargados.`);
  console.log(`   Rango temporal: ${frames[0].timeEcuador} a ${frames[frames.length - 1].timeEcuador} ECT`);

  const targetBasin = 'paute'; // Complejo Hidroeléctrico Paute
  const customTitle = 'Vista Satelital GOES-16 • Ecuador Continental';

  console.log('🎥 2. Compilando video con especificaciones exactas de alerta real:');
  console.log('   • Velocidad: 8 fps (2x de visualizer)');
  console.log('   • Duración mínima: 10 segundos');
  console.log('   • Detección de cuenca: TORMENTA ACTIVA • Complejo Hidroeléctrico Paute');
  console.log('   • Pines de centrales y barra térmica GOES-16');

  const compilation = await videoCompiler.compileFramesToVideo(frames, {
    plantKey: 'ecuador',
    outputName: 'video_alerta_tormenta_paute',
    framerate: 8, // 2x speed matching visualizer default
    minDurationSeconds: 10,
    customTitle,
    highlightBasinKey: targetBasin,
    activeBasinKeys: [targetBasin],
    showAllPins: true,
    showDetectionBoxes: true,
    showThermalScale: true,
    createMp4: true,
    createGif: false
  });

  console.log(`   ✅ Video MP4 generado exitosamente:`);
  console.log(`   • Archivo: ${compilation.mp4Path}`);
  console.log(`   • Duración: ${compilation.durationSeconds}s`);
  console.log(`   • Tamaño: ${(compilation.sizeBytesMp4! / 1024).toFixed(1)} KB`);
  console.log(`   • Fotogramas por ciclo: ${compilation.frameCount}`);

  // 3. Extract sample frame using ffmpeg for artifact preview
  const artifactDir = '/home/zezenta/.gemini/antigravity-cli/brain/6b1bfaaf-ca18-4138-bcdd-0de0981636ac';
  const previewFramePath = path.join(artifactDir, 'alert_video_sample_frame_8fps.png');
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', '00:00:01',
    '-i', compilation.mp4Path!,
    '-vframes', '1',
    '-q:v', '2',
    previewFramePath
  ]);
  console.log(`   📸 Fotograma de muestra extraído para preview: ${previewFramePath}`);

  // 4. Generate the exact post text that accompanies the real alert on X
  const samplePostText = buildStormAlertPostText({
    plantKey: targetBasin,
    peakCoveragePct: 18.5,
    durationMinutes: 65,
    dateEcuador: frames[frames.length - 1].dateEcuador,
    timeEcuador: frames[frames.length - 1].timeEcuador
  });

  console.log('\n============================================================');
  console.log('📝 TEXTO EXACTO DE LA PUBLICACIÓN DE ALERTA PARA X:');
  console.log('============================================================');
  console.log(samplePostText);
  console.log('============================================================\n');
}

run().catch(err => {
  console.error('❌ Error compilando video de alerta:', err);
  process.exit(1);
});
