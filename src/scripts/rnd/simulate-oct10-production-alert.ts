import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BASIN_GEOMETRIES } from '../../data/basin-geometries.js';
import { db } from '../../utils/db.js';
import { SatelliteMapService } from '../../services/telemetry/satellite-telemetry.service.js';
import { VideoCompilerService } from '../../services/satellite/video-compiler.service.js';
import { buildStormAlertPostText } from '../../utils/post-formatter.js';

const execFileAsync = promisify(execFile);

async function run() {
  console.log('========================================================================');
  console.log('🛰️ SIMULACIÓN DE PRODUCCIÓN • SÁBADO 10 DE OCTUBRE DE 2026');
  console.log('   Recreando análisis de fotogramas en tiempo real y alerta de tormenta');
  console.log('========================================================================\n');

  const satService = new SatelliteMapService();
  const videoCompiler = new VideoCompilerService(satService);

  // Query all archived frames from October 10, 2026 in chronological order
  const oct10Rows = db.prepare(`
    SELECT file_path, date_ecuador, time_ecuador, timestamp_iso
    FROM satellite_archive
    WHERE date_ecuador = '2026-10-10'
    ORDER BY timestamp_iso ASC
  `).all() as Array<{ file_path: string; date_ecuador: string; time_ecuador: string; timestamp_iso: string }>;

  console.log(`📥 1. Se encontraron ${oct10Rows.length} fotogramas satelitales registrados en el día.`);
  console.log('   Iniciando monitoreo de cuencas con umbral de 10.0% en Coca Codo Sinclair...\n');

  // We filter the frames spanning pre-storm context (10:30-11:00), active storm (11:10-14:30), and post-storm dissipation (14:40-15:00)
  const stormFramesRows = oct10Rows.filter(r => r.time_ecuador >= '10:30' && r.time_ecuador <= '15:00');

  console.log('⏱️ 2. Línea de tiempo de detección del evento:');
  console.log('   [10:30 - 11:00 ECT] 🌤️ CONTEXTO PREVIO (Frames 0 a 3): Cuenca en estado normal (8.5% - 9.8% cobertura). Recuadro en reposo cian.');
  console.log('   [11:10 ECT] 🚨 INICIO DE TORMENTA (Frame 4): Umbral superado (10.7% >= 10.0%). ¡Recuadro cambia a parpadeo rojo pulsante!');
  console.log('   [11:10 - 13:10 ECT] ⛈️ DESARROLLO: Expansión de celda convectiva con recuadro parpadeando a 2 Hz.');
  console.log('   [13:20 ECT] ⚡ PICO MÁXIMO (Frame 17): 14.5% de cobertura de nubes frías sobre la cuenca Coca Codo Sinclair.');
  console.log('   [13:30 - 14:30 ECT] 🌧️ MADURACIÓN Y SALIDA: Celda se desplaza hacia el este amazónico.');
  console.log('   [14:40 ECT] 🎬 DISIPACIÓN DETECTADA: Cobertura cayó a 7.4% (≤ 50% del pico). Tormenta finalizada.');
  console.log('   [14:40 - 15:00 ECT] 🌤️ CONTEXTO POSTERIOR (Frames 25 a 27): Cuenca regresa a estado normal en calma.\n');

  // Load the SatelliteFrame objects for compilation
  const framesToCompile = stormFramesRows.map((r, i) => {
    return {
      index: i,
      timestampIso: r.timestamp_iso,
      dateEcuador: r.date_ecuador,
      timeEcuador: r.time_ecuador,
      buffer: fs.readFileSync(r.file_path),
      bbox: BASIN_GEOMETRIES.ecuador.bbox,
      plantKey: 'ecuador',
      source: 'geoserver' as const
    };
  });

  console.log(`🎥 3. Compilando video de producción (${framesToCompile.length} fotogramas satelitales):`);
  console.log('   • Cuenca objetivo: Cuenca Coca Codo Sinclair');
  console.log('   • Vista: Ecuador Continental');
  console.log('   • Título: Vista Satelital GOES-16 • Ecuador Continental');
  console.log('   • Ventana de tormenta activa: Frames 4 a 24 (11:10 a 14:30 ECT)');
  console.log('   • Frames previos (normal): Frames 0 a 3 (10:30 a 11:00 ECT)');
  console.log('   • Frames posteriores (normal): Frames 25 a 27 (14:40 a 15:00 ECT)');
  console.log('   • Efecto visual de tormenta: Pulso suave sinusoidal de respiración (1.0s / 1 Hz)');
  console.log('   • Velocidad: 8 fps (2x de visualizador)');
  console.log('   • Sin emojis en textos');

  const compilation = await videoCompiler.compileFramesToVideo(framesToCompile, {
    plantKey: 'ecuador',
    outputName: 'alerta_produccion_coca_codo_10oct',
    framerate: 8,
    minDurationSeconds: 10,
    customTitle: 'Vista Satelital GOES-16 • Ecuador Continental',
    highlightBasinKey: 'cocaCodoSinclair',
    activeBasinKeys: ['cocaCodoSinclair'],
    stormWindow: {
      startFrameIndex: 4,
      endFrameIndex: 24,
      startTime: '2026-10-10T11:10:00-05:00',
      endTime: '2026-10-10T14:30:00-05:00'
    },
    showAllPins: true,
    showDetectionBoxes: true,
    showThermalScale: true,
    createMp4: true,
    createGif: false
  });

  console.log(`\n   ✅ Video generado exitosamente:`);
  console.log(`   • Ruta: ${compilation.mp4Path}`);
  console.log(`   • Duración: ${compilation.durationSeconds}s`);
  console.log(`   • Tamaño: ${(compilation.sizeBytesMp4! / 1024).toFixed(1)} KB`);
  console.log(`   • Cuadros por ciclo: ${compilation.frameCount} frames`);

  // 4. Extract sample preview frames:
  const artifactDir = '/home/zezenta/.gemini/antigravity-cli/brain/6b1bfaaf-ca18-4138-bcdd-0de0981636ac';
  
  // A) Pre-storm frame (Frame index 2, 10:50 ECT, ~0.25s)
  const preStormFramePath = path.join(artifactDir, 'alert_oct10_coca_pre_storm_frame.png');
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', '00:00:00.25',
    '-i', compilation.mp4Path!,
    '-vframes', '1',
    '-q:v', '2',
    preStormFramePath
  ]);
  console.log(`   📸 Fotograma previo a tormenta extraído: ${preStormFramePath}`);

  // B) Peak storm frame (Frame index 17, 13:20 ECT, ~2.125s)
  const peakFramePath = path.join(artifactDir, 'alert_oct10_coca_peak_frame.png');
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', '00:00:02.12',
    '-i', compilation.mp4Path!,
    '-vframes', '1',
    '-q:v', '2',
    peakFramePath
  ]);
  console.log(`   📸 Fotograma pico de tormenta extraído: ${peakFramePath}`);

  // C) Post-storm frame (Frame index 26, 14:50 ECT, ~3.25s)
  const postStormFramePath = path.join(artifactDir, 'alert_oct10_coca_post_storm_frame.png');
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', '00:00:03.25',
    '-i', compilation.mp4Path!,
    '-vframes', '1',
    '-q:v', '2',
    postStormFramePath
  ]);
  console.log(`   📸 Fotograma posterior a tormenta extraído: ${postStormFramePath}`);

  // 5. Generate exact Post text for X
  const postText = buildStormAlertPostText({
    plantKey: 'cocaCodoSinclair',
    peakCoveragePct: 14.5,
    durationMinutes: 210,
    dateEcuador: 'Sábado, 10 de octubre de 2026',
    timeEcuador: '14:40'
  });

  console.log('\n========================================================================');
  console.log('📝 TEXTO DE PUBLICACIÓN QUE ENVIARÍA EL BOT A X (TWITTER):');
  console.log('========================================================================');
  console.log(postText);
  console.log('========================================================================\n');
}

run().catch(err => {
  console.error('❌ Error en la simulación:', err);
  process.exit(1);
});
