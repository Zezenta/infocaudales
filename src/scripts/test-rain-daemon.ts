import path from 'path';
import fs from 'fs';
import { RainMonitorService, RainCheckOptions } from '../services/rain-monitor.service.js';
import { SatelliteMapService } from '../services/satellite-map.service.js';
import { VideoCompilerService } from '../services/video-compiler.service.js';
import { BASIN_GEOMETRIES } from '../data/basin-geometries.js';

const CHECK_INTERVAL_SECONDS = parseInt(process.env.CHECK_INTERVAL_SECONDS || '900', 10); // default: 15 min
const TARGET_BASINS = (process.env.TARGET_BASINS || 'cocaCodoSinclair,paute').split(',').map(s => s.trim());
const STORM_THRESHOLD = process.env.STORM_THRESHOLD ? parseFloat(process.env.STORM_THRESHOLD) : undefined;
const DISSIPATION_RATIO = parseFloat(process.env.DISSIPATION_RATIO || '0.50');
const MIN_DURATION_MINUTES = parseInt(process.env.MIN_DURATION_MINUTES || '30', 10); // 30 min in testing mode
const MAX_DURATION_MINUTES = parseInt(process.env.MAX_DURATION_MINUTES || '360', 10);

const generatedDir = path.join(process.cwd(), 'generated');
if (!fs.existsSync(generatedDir)) {
  fs.mkdirSync(generatedDir, { recursive: true });
}

const satelliteService = new SatelliteMapService();
const videoCompilerService = new VideoCompilerService(satelliteService);
const rainMonitorService = new RainMonitorService(satelliteService, videoCompilerService);

const options: RainCheckOptions = {
  stormThresholdPct: STORM_THRESHOLD,
  dissipationRatio: DISSIPATION_RATIO,
  minRainDurationMinutes: MIN_DURATION_MINUTES,
  maxRainDurationMinutes: MAX_DURATION_MINUTES,
  cooldownHours: 6,
  autoCompileVideo: true,
  tileResolution: 80
};

console.log('============================================================');
console.log('🌧️ INFOCAUDALES • DEMONIO DE PRUEBA DE MONITOREO DE LLUVIAS');
console.log('============================================================');
console.log(`• Cuencas monitoreadas: ${TARGET_BASINS.join(', ')}`);
console.log(`• Intervalo de chequeo: cada ${CHECK_INTERVAL_SECONDS} segundos (${(CHECK_INTERVAL_SECONDS / 60).toFixed(1)} min)`);
console.log(`• Umbral de tormenta: ${STORM_THRESHOLD}% de cobertura`);
console.log(`• Ratio de disipación para compilar: ${DISSIPATION_RATIO * 100}% del pico`);
console.log(`• Duración mínima requerida: ${MIN_DURATION_MINUTES} min`);
console.log(`• Directorio de videos: ${generatedDir}`);
console.log('============================================================\n');

async function checkAllBasins() {
  const nowStr = new Date().toLocaleTimeString('es-EC', { timeZone: 'America/Guayaquil' });
  console.log(`[${nowStr} ECT] Verificando satélite GOES-16 en cuencas...`);

  for (const plantKey of TARGET_BASINS) {
    const basin = BASIN_GEOMETRIES[plantKey];
    const basinName = basin?.name || plantKey;

    try {
      const result = await rainMonitorService.checkBasin(plantKey, options);

      if (result.action === 'STORM_STARTED') {
        console.log('\n============================================================');
        console.log(`🚨 [ALERTA: INICIO DE TORMENTA DETECTADA]`);
        console.log(`• Cuenca: ${basinName} (${plantKey})`);
        console.log(`• Cobertura nubosa fría: ${result.coveragePct}%`);
        console.log(`• Hora de detección: ${nowStr} ECT`);
        console.log(`• Acción: Guardado en SQLite. Monitoreando desarrollo de la lluvia...`);
        console.log('============================================================\n');
      } else if (result.action === 'VIDEO_COMPILED' && result.compilationResult?.mp4Path) {
        console.log('\n============================================================');
        console.log(`🎬 [TORMENTA FINALIZADA • VIDEO COMPILADO EXITOSAMENTE]`);
        console.log(`• Cuenca: ${basinName} (${plantKey})`);
        console.log(`• Cobertura pico: ${result.peakCoveragePct}%`);
        console.log(`• Cobertura final al disiparse: ${result.coveragePct}%`);
        console.log(`• Tiempo total transcurrido: ${result.elapsedMinutes} minutos`);
        console.log(`• Video MP4 generado en:`);
        console.log(`  👉 file://${result.compilationResult.mp4Path}`);
        console.log(`• Duración del video: ${result.compilationResult.durationSeconds}s (${result.compilationResult.frameCount} frames)`);
        console.log('============================================================\n');
      } else if (result.action === 'STORM_MONITORING') {
        console.log(
          `  ⚡ [${basinName}] Tormenta en curso (${result.elapsedMinutes} min). Pico: ${result.peakCoveragePct}%, Actual: ${result.coveragePct}%. Esperando descenso/salida de la nube.`
        );
      } else if (result.action === 'IN_COOLDOWN') {
        console.log(`  ⏳ [${basinName}] En período de cooldown. ${result.message}`);
      } else {
        console.log(`  ☁️  [${basinName}] Sin lluvias (${result.coveragePct}% cobertura nubosa, umbral: ${STORM_THRESHOLD}%).`);
      }
    } catch (err: any) {
      console.error(`  ❌ Error evaluando cuenca ${plantKey}:`, err?.message || err);
    }
  }
}

// First immediate execution
checkAllBasins().then(() => {
  // Subsequent scheduled executions
  setInterval(checkAllBasins, CHECK_INTERVAL_SECONDS * 1000);
});
