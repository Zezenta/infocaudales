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
