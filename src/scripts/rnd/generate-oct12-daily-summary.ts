import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RainMonitorService } from '../../services/rain-monitor.service.js';
import { SatelliteMapService } from '../../services/satellite-map.service.js';
import { VideoCompilerService } from '../../services/video-compiler.service.js';

const execFileAsync = promisify(execFile);

async function main() {
  console.log('========================================================================');
  console.log('🛰️ GENERACIÓN DE RESUMEN SATELITAL 24H • LUNES 12 DE OCTUBRE DE 2026');
  console.log('   Compilando timelapse de 24 horas completas con activación dinámica');
  console.log('========================================================================\n');

  const satService = new SatelliteMapService();
  const compiler = new VideoCompilerService(satService);
  const rainMonitor = new RainMonitorService(satService, compiler);

  const result = await rainMonitor.generateDailySummaryVideo({
    dateEcuador: '2026-10-12',
    autoPublishToX: false,
    framerate: 8 // 8 fps
  });

  console.log('\n✅ Video compilado exitosamente:');
  console.log(`• Ruta: ${result.compilation.mp4Path}`);
  console.log(`• Duración: ${result.compilation.durationSeconds}s`);
  console.log(`• Fotogramas: ${result.compilation.frameCount}`);
  console.log(`• Tamaño: ${(result.compilation.sizeBytesMp4! / 1024).toFixed(1)} KB`);

  console.log('\n📊 Resumen de lluvia por cuenca:');
  for (const b of result.basinSummaries) {
    console.log(`• ${b.plantKey}: ${b.hasRain ? 'Lluvia detectada' : 'Sin lluvia'} | Pico: ${b.peakCoveragePct.toFixed(1)}% | Frames activos: ${b.rainFrames}`);
  }

  if (result.regionPeaks) {
    console.log('\n📊 Picos máximos por región:');
    console.log(`• Costa: ${result.regionPeaks.costa.toFixed(1)}%`);
    console.log(`• Sierra: ${result.regionPeaks.sierra.toFixed(1)}%`);
    console.log(`• Amazonía: ${result.regionPeaks.amazonia.toFixed(1)}%`);
  }

  // Extract preview frames into artifact directory and generated directory
  const artifactDir = '/home/zezenta/.gemini/antigravity-cli/brain/6b1bfaaf-ca18-4138-bcdd-0de0981636ac';
  const generatedDir = path.join(process.cwd(), 'generated');

  // Preview frame 1: Afternoon around 15:00 ECT (approx frame 75 -> t = 75 / 8 = 9.3s)
  const afternoonFrame = path.join(artifactDir, 'oct12_24h_afternoon_storm_frame.png');
  const afternoonFrameGen = path.join(generatedDir, 'oct12_24h_afternoon_storm_frame.png');
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', '00:00:09.3',
    '-i', result.compilation.mp4Path!,
    '-vframes', '1',
    '-q:v', '2',
    afternoonFrame
  ]);
  fs.copyFileSync(afternoonFrame, afternoonFrameGen);
  console.log(`📸 Preview Tarde (tormenta activa): ${afternoonFrameGen}`);

  // Preview frame 2: Night around 21:00 ECT (approx frame 115 -> t = 115 / 8 = 14.3s)
  const nightFrame = path.join(artifactDir, 'oct12_24h_night_frame.png');
  const nightFrameGen = path.join(generatedDir, 'oct12_24h_night_frame.png');
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', '00:00:14.3',
    '-i', result.compilation.mp4Path!,
    '-vframes', '1',
    '-q:v', '2',
    nightFrame
  ]);
  fs.copyFileSync(nightFrame, nightFrameGen);
  console.log(`📸 Preview Noche: ${nightFrameGen}`);

  console.log('\n========================================================================');
  console.log('📝 TEXTO QUE SE DEBE PUBLICAR EN X (TWITTER) PARA EL 12 DE OCTUBRE:');
  console.log('========================================================================');
  console.log(result.postText);
  console.log('========================================================================\n');
}

main().catch(err => {
  console.error('Error generating Oct 12 summary:', err);
  process.exit(1);
});
