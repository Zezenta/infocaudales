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
  console.log('🛰️ GENERACIÓN DE RESUMEN SATELITAL 24H • DOMINGO 11 DE OCTUBRE DE 2026');
  console.log('   Compilando timelapse de 24 horas completas con activación dinámica');
  console.log('========================================================================\n');

  const satService = new SatelliteMapService();
  const compiler = new VideoCompilerService(satService);
  const rainMonitor = new RainMonitorService(satService, compiler);

  const result = await rainMonitor.generateDailySummaryVideo({
    dateEcuador: '2026-10-11',
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

  // Extract preview frames into artifact directory and generated directory
  const artifactDir = '/home/zezenta/.gemini/antigravity-cli/brain/6b1bfaaf-ca18-4138-bcdd-0de0981636ac';
  const generatedDir = path.join(process.cwd(), 'generated');

  // 1. Frame around 04:40 ECT: Paute active in early morning
  // At 8 fps, 04:40 is approx frame 28 -> t = 28 / 8 = 3.5s
  const pauteActiveFrame = path.join(artifactDir, 'oct11_24h_paute_active_frame.png');
  const pauteActiveFrameGen = path.join(generatedDir, 'oct11_24h_paute_active_frame.png');
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', '00:00:03.5',
    '-i', result.compilation.mp4Path!,
    '-vframes', '1',
    '-q:v', '2',
    pauteActiveFrame
  ]);
  fs.copyFileSync(pauteActiveFrame, pauteActiveFrameGen);
  console.log(`📸 Preview Paute activa (madrugada): ${pauteActiveFrameGen}`);

  // 2. Frame around 14:20 ECT: Coca Codo Sinclair active in afternoon
  // At 8 fps, 14:20 is approx frame 85 -> t = 85 / 8 = 10.6s
  const ccsActiveFrame = path.join(artifactDir, 'oct11_24h_ccs_active_frame.png');
  const ccsActiveFrameGen = path.join(generatedDir, 'oct11_24h_ccs_active_frame.png');
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', '00:00:10.6',
    '-i', result.compilation.mp4Path!,
    '-vframes', '1',
    '-q:v', '2',
    ccsActiveFrame
  ]);
  fs.copyFileSync(ccsActiveFrame, ccsActiveFrameGen);
  console.log(`📸 Preview Coca Codo activa (tarde): ${ccsActiveFrameGen}`);

  // 3. Frame around 09:30 ECT: Calm state across both basins (clear view of city labels)
  // At 8 fps, 09:30 is approx frame 57 -> t = 57 / 8 = 7.1s
  const calmFrame = path.join(artifactDir, 'oct11_24h_calm_state_frame.png');
  const calmFrameGen = path.join(generatedDir, 'oct11_24h_calm_state_frame.png');
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', '00:00:07.1',
    '-i', result.compilation.mp4Path!,
    '-vframes', '1',
    '-q:v', '2',
    calmFrame
  ]);
  fs.copyFileSync(calmFrame, calmFrameGen);
  console.log(`📸 Preview estado en calma (etiquetas de ciudades): ${calmFrameGen}`);

  console.log('\n========================================================================');
  console.log('📝 TEXTO QUE SE PUBLICARÍA EN X (TWITTER) A LAS 00:00 ECT:');
  console.log('========================================================================');
  console.log(result.postText);
  console.log('========================================================================\n');
}

main().catch(err => {
  console.error('Error generating Oct 11 summary:', err);
  process.exit(1);
});
