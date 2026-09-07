import { HydroelectricPlant } from '../types/hydroelectric.js';
import { TelemetryData } from '../services/report-generator.service.js';

/**
 * Formats a number cleanly, omitting trailing decimals if it is an integer.
 */
export function formatVal(val: number, maxDecimals: number = 2): string {
  if (val === null || val === undefined || isNaN(val)) return '0';
  if (Math.abs(val - Math.round(val)) < 0.005) {
    return Math.round(val).toString();
  }
  return parseFloat(val.toFixed(maxDecimals)).toString();
}

/**
 * Builds the exact social media text payload based on plant type and rules.
 */
export function buildMessageText(
  plant: HydroelectricPlant,
  plantKey: string,
  telemetry: TelemetryData,
  nationalDemandMW?: number
): string {
  const maxEnergyMW = plant.physicalData?.maxEnergyMW ?? 100;
  const maxTurbines = plant.physicalData?.maxTurbines ?? 1;
  const minLevelMasl = plant.physicalData?.minLevelMasl;

  const flow3hAgo = telemetry.flow3hAgo ?? telemetry.flow;
  let deltaCaudal = 0;
  if (flow3hAgo === 0) {
    deltaCaudal = telemetry.flow > 0 ? 100 : 0;
  } else {
    deltaCaudal = ((telemetry.flow - flow3hAgo) / flow3hAgo) * 100;
  }
  const signoCaudal = telemetry.flow >= flow3hAgo ? '+' : '-';
  const caudalStr = `🌊Caudal: ${formatVal(telemetry.flow)} m³/s\n${signoCaudal}${formatVal(Math.abs(deltaCaudal))}% desde hace 3h`;

  const trabajoEnergia = (telemetry.gen / maxEnergyMW) * 100;
  let genStr = `🔋Generación: ${formatVal(telemetry.gen)} MWh\nAl ${formatVal(trabajoEnergia)}% de capacidad máxima`;
  if (telemetry.turbines !== undefined && maxTurbines > 0) {
    genStr += `\nTurbinas Activas: ${telemetry.turbines}/${maxTurbines}`;
  }

  let header = '';
  if (plantKey === 'cocaCodoSinclair') {
    header = `Hidroeléctrica Coca Codo Sinclair\n#CocaCodoSinclair #CCS`;
  } else {
    const plantHashtag = `#${plant.name.replace(/\s+/g, '')}`;
    const pauteHashtag = plant.isPauteComplex ? ' #Paute' : '';
    header = `Hidroeléctrica ${plantHashtag}${pauteHashtag}`;
  }

  if (plantKey === 'sopladora') {
    return `${header}\n\n${caudalStr}\n\n${genStr}`;
  }

  if (plantKey === 'cocaCodoSinclair') {
    let ccsExtra = '';
    if (nationalDemandMW && nationalDemandMW > 0) {
      const pctGrid = formatVal((telemetry.gen / nationalDemandMW) * 100);
      ccsExtra = `\n\nEstá generando el ${pctGrid}% de la energía usada en Ecuador en este momento.`;
    } else {
      ccsExtra = `\n\nEstá generando energía para el sistema eléctrico nacional en este momento.`;
    }
    return `${header}\n\n${caudalStr}\n\n${genStr}${ccsExtra}`;
  }

  let cotaStr = '';
  if (telemetry.cota !== undefined && minLevelMasl !== undefined) {
    const distMin = formatVal(telemetry.cota - minLevelMasl);
    cotaStr = `💧Cota: ${formatVal(telemetry.cota)} msnm\nA ${distMin} m de la cota mínima\n\n`;
  }

  return `${header}\n\n${cotaStr}${caudalStr}\n\n${genStr}`;
}

/**
 * Builds the exact social media text for an individual 6-hour hydrological forecast post.
 */
export function buildForecastPostText(
  plant: HydroelectricPlant,
  plantKey: string,
  forecast: {
    currentFlow: number;
    targetFlow: number;
    p25: number;
    p75: number;
    horizonHours: number;
    modelName: string;
    mae: number;
  }
): string {
  const deltaPct = ((forecast.targetFlow - forecast.currentFlow) / Math.max(0.1, forecast.currentFlow)) * 100;
  const deltaSign = deltaPct >= 0 ? '+' : '-';
  const deltaFormatted = `${deltaSign}${formatVal(Math.abs(deltaPct), 1)}%`;

  let header = '';
  if (plantKey === 'cocaCodoSinclair') {
    header = `Pronóstico Coca Codo Sinclair (+${forecast.horizonHours}h)\n#CocaCodoSinclair #CCS`;
  } else {
    const plantHashtag = `#${plant.name.replace(/\s+/g, '')}`;
    const pauteHashtag = plant.isPauteComplex ? ' #Paute' : '';
    header = `Pronóstico ${plantHashtag}${pauteHashtag} (+${forecast.horizonHours}h)`;
  }

  const flowLine = `Caudal actual: ${formatVal(forecast.currentFlow)} m³/s\nProyección (${forecast.horizonHours}h): ${formatVal(forecast.targetFlow)} m³/s (${deltaFormatted})`;
  const probLine = `Rango esperado 50%: ${formatVal(forecast.p25)} - ${formatVal(forecast.p75)} m³/s`;
  const modelLine = `Modelo: ${forecast.modelName} (MAE: ${formatVal(forecast.mae, 1)} m³/s)`;

  return `${header}\n\n${flowLine}\n${probLine}\n${modelLine}\n\n#Ecuador #Energía #Hidrología`;
}

/**
 * Builds the text-only weekly accuracy and calibration summary post for Sundays.
 * Editable template for easy customization.
 */
export function buildWeeklyAccuracyReportText(summary: import('../services/forecast-history.service.js').WeeklyAccuracyReportSummary): string {
  if (summary.totalForecastsResolved === 0) {
    return `Reporte Semanal de Precisión Hidrológica (Modelos 6h)\n\n` +
      `No se registraron suficientes pronósticos concluidos en los últimos 7 días para evaluar.\n\n` +
      `#Ecuador #Energía #Hidrología`;
  }

  const dirAccPct = formatVal(summary.overallDirectionalAccuracy * 100, 1);
  const p25Pct = formatVal(summary.overallP25P75Coverage * 100, 1);
  const maeVal = formatVal(summary.overallMae, 1);

  let highlightsStr = '';
  const best = summary.mostAccuratePlant ? summary.plants[summary.mostAccuratePlant] : null;
  const worst = summary.leastAccuratePlant ? summary.plants[summary.leastAccuratePlant] : null;

  if (best) {
    highlightsStr += `Mayor precisión: ${best.plantName} (MAE: ${formatVal(best.observedMae, 1)} m³/s)\n`;
  }
  if (worst && worst.plantKey !== best?.plantKey) {
    highlightsStr += `Menor precisión: ${worst.plantName} (MAE: ${formatVal(worst.observedMae, 1)} m³/s)\n`;
  }
  if (highlightsStr) {
    highlightsStr += '\n';
  }

  const plantLines = Object.values(summary.plants).map(p => {
    return `• ${p.plantName}: MAE ${formatVal(p.observedMae, 1)} m³/s | Tendencia: ${formatVal(p.directionalAccuracy * 100, 0)}%`;
  }).join('\n');

  return `Reporte Semanal de Calibración y Precisión (Modelos 6h)\n\n` +
    `Evaluación de los pronósticos emitidos esta semana:\n` +
    `Acierto de Tendencia: ${dirAccPct}%\n` +
    `Error Medio (MAE): ${maeVal} m³/s\n` +
    `Cobertura Rango 50%: ${p25Pct}%\n\n` +
    `${highlightsStr}` +
    `Desempeño por central:\n${plantLines}\n\n` +
    `Transparencia y calibración continua de modelos multi-COMID.\n` +
    `#Ecuador #Energía #Hidrología`;
}
