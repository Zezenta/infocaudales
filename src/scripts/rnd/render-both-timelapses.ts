import { SatelliteArchiverService } from '../../services/satellite-archiver.service.js';
import { SatelliteMapService } from '../../services/satellite-map.service.js';
import { VideoCompilerService } from '../../services/video-compiler.service.js';
import { BASIN_GEOMETRIES } from '../../data/basin-geometries.js';

async function main() {
  const satelliteService = new SatelliteMapService();
  const archiver = new SatelliteArchiverService(satelliteService);
  const videoCompiler = new VideoCompilerService(satelliteService);

  console.log('Fetching all archived frames...');
  const frames = archiver.getArchivedFrames({ limit: 1200, plantKey: 'ecuador' });
  console.log(`Loaded ${frames.length} frames for compilation.`);

  if (frames.length < 4) {
    console.error('Not enough frames to compile.');
    process.exit(1);
  }

  const framerate = 8; // 8 fps for ~900 frames gives ~110 seconds of smooth animation
  const firstFrame = frames[0];
  const lastFrame = frames[frames.length - 1];

  console.log(`\n============================================================`);
  console.log(`🎬 1/2: COMPILANDO TIMELAPSE CON CUENCAS CALIBRADAS`);
  console.log(`• Rango: ${firstFrame.dateEcuador} ${firstFrame.timeEcuador} ECT  ➔  ${lastFrame.dateEcuador} ${lastFrame.timeEcuador} ECT`);
  console.log(`• Cuencas calibradas:`);
  console.log(`   - CCS: ${BASIN_GEOMETRIES.cocaCodoSinclair.bbox}`);
  console.log(`   - Paute: ${BASIN_GEOMETRIES.paute.bbox}`);
  console.log(`============================================================`);

  const resCalibrated = await videoCompiler.compileFramesToVideo(frames, {
    plantKey: 'ecuador',
    outputName: 'goes16_ecuador_timelapse',
    framerate,
    minDurationSeconds: 10,
    customTitle: 'Monitoreo Satelital GOES-16 • Cuencas Calibradas',
    showAllPins: true,
    showDetectionBoxes: true,
    createMp4: true,
    createGif: false
  });

  console.log(`✅ [1/2 COMPLETADO] Video con Cuencas Calibradas listo:`);
  console.log(`👉 file://${resCalibrated.mp4Path} (${resCalibrated.durationSeconds}s, ${resCalibrated.sizeBytesMp4} bytes)`);

  console.log(`\n============================================================`);
  console.log(`🎬 2/2: COMPILANDO TIMELAPSE CON CUENCAS ANTERIORES`);
  console.log(`• Cuencas anteriores:`);
  console.log(`   - CCS Anterior: [-78.40, -0.80, -77.10, 0.50]`);
  console.log(`   - Paute Anterior: [-79.15, -3.15, -78.05, -2.05]`);
  console.log(`============================================================`);

  const previousBoxes = [
    {
      key: 'cocaCodoSinclair',
      label: 'Cuenca Coca Codo Sinclair (Anterior)',
      bbox: [-78.40, -0.80, -77.10, 0.50] as [number, number, number, number],
      defaultColor: '#facc15'
    },
    {
      key: 'paute',
      label: 'Complejo Paute (Anterior)',
      bbox: [-79.15, -3.15, -78.05, -2.05] as [number, number, number, number],
      defaultColor: '#e879f9'
    }
  ];

  const resPrevious = await videoCompiler.compileFramesToVideo(frames, {
    plantKey: 'ecuador',
    outputName: 'goes16_ecuador_timelapse_cuencas_anteriores',
    framerate,
    minDurationSeconds: 10,
    customTitle: 'Monitoreo Satelital GOES-16 • Cuencas Anteriores',
    showAllPins: true,
    showDetectionBoxes: true,
    customMonitoredBasins: previousBoxes,
    createMp4: true,
    createGif: false
  });

  console.log(`✅ [2/2 COMPLETADO] Video con Cuencas Anteriores listo:`);
  console.log(`👉 file://${resPrevious.mp4Path} (${resPrevious.durationSeconds}s, ${resPrevious.sizeBytesMp4} bytes)`);
  console.log(`\n🎉 Ambos videos compilados exitosamente.`);
}

main().catch(err => {
  console.error('Error during video compilation:', err);
  process.exit(1);
});
