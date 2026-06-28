import { HydroelectricPlant } from '../types/hydroelectric.js';
import { TelemetryData } from '../services/report-generator.service.js';

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
  const caudalStr = `🌊Caudal: ${telemetry.flow.toFixed(2)} m³/s\n${signoCaudal}${Math.abs(deltaCaudal).toFixed(2)}% desde hace 3h`;

  const trabajoEnergia = (telemetry.gen / maxEnergyMW) * 100;
  let genStr = `🔋Generación: ${telemetry.gen.toFixed(2)} MWh\nAl ${trabajoEnergia.toFixed(2)}% de capacidad máxima`;
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
      const pctGrid = ((telemetry.gen / nationalDemandMW) * 100).toFixed(2);
      ccsExtra = `\n\nEstá generando el ${pctGrid}% de la energía usada en Ecuador en este momento.`;
    } else {
      ccsExtra = `\n\nEstá generando energía para el sistema eléctrico nacional en este momento.`;
    }
    return `${header}\n\n${caudalStr}\n\n${genStr}${ccsExtra}`;
  }

  let cotaStr = '';
  if (telemetry.cota !== undefined && minLevelMasl !== undefined) {
    const distMin = (telemetry.cota - minLevelMasl).toFixed(2);
    cotaStr = `💧Cota: ${telemetry.cota.toFixed(2)} msnm\nA ${distMin} m de la cota mínima\n\n`;
  }

  return `${header}\n\n${cotaStr}${caudalStr}\n\n${genStr}`;
}
