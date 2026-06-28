import dotenv from 'dotenv';
import { CronJob } from 'cron';
import { hydroelectricPlants } from './data/hydroelectric-plants.js';
import { CelecService, CelecPointValue } from './services/celec.service.js';
import { CenaceService } from './services/cenace.service.js';
import { generateReportCard } from './services/report-generator.service.js';
import { XService } from './services/x.service.js';
import { buildMessageText } from './utils/post-formatter.js';
import { readCenaceHistory, saveCenaceHistory } from './utils/cenace-history.js';

dotenv.config();

const celecService = new CelecService();
const cenaceService = new CenaceService();
const xService = new XService();

export class DataPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataPendingError';
  }
}

// The 6 hydroelectric plants to publish
export const TARGET_PLANT_KEYS = [
  'molino',
  'cocaCodoSinclair',
  'sopladora',
  'mazar',
  'minasSanFrancisco',
  'agoyan'
];

export interface PlantTelemetryData {
  gen: number;
  flow: number;
  flow3hAgo: number;
  cota?: number;
  turbines?: number;
  timestamp: Date;
}

/**
 * Helper to safely extract point value and timestamp from CELEC arrays.
 * If requireTargetHour is true and current hour value is null, throws DataPendingError for retry.
 */
function extractCelecPoint(
  pointsToday: CelecPointValue[],
  targetIdx: number,
  requireTargetHour: boolean = false
): { value: number | null; timestamp?: Date } {
  if (pointsToday[targetIdx] && pointsToday[targetIdx].value !== null && pointsToday[targetIdx].value !== undefined) {
    const pointDate = pointsToday[targetIdx].timestamp ? new Date(pointsToday[targetIdx].timestamp) : undefined;
    return { value: pointsToday[targetIdx].value, timestamp: pointDate };
  }

  if (requireTargetHour) {
    throw new DataPendingError(`CELEC target point at index ${targetIdx} is not yet published (null)`);
  }

  // Fallback mode: find first available non-null point starting from targetIdx onwards
  for (let i = targetIdx; i < pointsToday.length; i++) {
    if (pointsToday[i] && pointsToday[i].value !== null && pointsToday[i].value !== undefined) {
      const pointDate = pointsToday[i].timestamp ? new Date(pointsToday[i].timestamp) : undefined;
      return { value: pointsToday[i].value, timestamp: pointDate };
    }
  }

  return { value: null };
}

/**
 * Fetches real-time telemetry data for a specific plant.
 * Supports retry validation when requireTargetHour is true.
 */
export async function fetchTelemetry(plantKey: string, requireTargetHour: boolean = false): Promise<PlantTelemetryData> {
  const plant = hydroelectricPlants[plantKey];
  if (!plant) throw new Error(`Plant ${plantKey} not found in configuration`);

  const now = new Date();
  const { hora } = celecService.getEcuadorDateParts(now);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const targetIdx = 24 - hora;

  let flow: number = plant.visualData?.defaultFlow ?? 100;
  let flow3hAgo: number = plant.visualData?.defaultFlow ?? 100;
  let cota: number | undefined = plant.visualData?.defaultCota;
  let turbines: number | undefined = plant.visualData?.defaultTurbines;
  let gen: number = plant.visualData?.defaultGen ?? 200;
  let telemetryTimestamp: Date = now;

  // 1. Fetch Flow (Caudal) from CELEC
  try {
    const flowPointsToday = await celecService.fetchFlow(plant, now);
    const flowResult = extractCelecPoint(flowPointsToday, targetIdx, requireTargetHour);
    if (flowResult.value !== null) {
      flow = flowResult.value;
      if (flowResult.timestamp) telemetryTimestamp = flowResult.timestamp;
    }

    // Extract 3h ago flow
    if (hora >= 4) {
      const idx3h = 24 - hora + 3;
      const flow3hResult = extractCelecPoint(flowPointsToday, idx3h, false);
      if (flow3hResult.value !== null) flow3hAgo = flow3hResult.value;
    } else {
      try {
        const flowPointsYesterday = await celecService.fetchFlow(plant, yesterday);
        if (flowPointsYesterday[2] && flowPointsYesterday[2].value !== null) {
          flow3hAgo = flowPointsYesterday[2].value;
        }
      } catch (e) {}
    }
  } catch (err) {
    if (err instanceof DataPendingError) throw err;
    console.warn(`[Index] Failed to fetch flow for ${plant.name}:`, err);
  }

  // 2. Fetch Cota (Reservoir Level) from CELEC (ignored for Sopladora & CCS)
  const minLevel = plant.physicalData?.minLevelMasl;
  if (plantKey !== 'sopladora' && plantKey !== 'cocaCodoSinclair' && minLevel !== undefined) {
    try {
      const levelPointsToday = await celecService.fetchLevel(plant, now);
      const levelResult = extractCelecPoint(levelPointsToday, targetIdx, requireTargetHour);
      if (levelResult.value !== null) {
        cota = levelResult.value;
        if (levelResult.timestamp && telemetryTimestamp === now) telemetryTimestamp = levelResult.timestamp;
      }
    } catch (err) {
      if (err instanceof DataPendingError) throw err;
      console.warn(`[Index] Failed to fetch level for ${plant.name}:`, err);
    }
  } else {
    cota = undefined;
  }

  // 3. Fetch Active Turbines from CELEC (ignored for CCS)
  if (plantKey !== 'cocaCodoSinclair') {
    try {
      const turbinePointsToday = await celecService.fetchActiveTurbines(plant, now);
      const turbineResult = extractCelecPoint(turbinePointsToday, targetIdx, requireTargetHour);
      if (turbineResult.value !== null) {
        turbines = turbineResult.value;
      }
    } catch (err) {
      if (err instanceof DataPendingError) throw err;
      console.warn(`[Index] Failed to fetch turbines for ${plant.name}:`, err);
    }
  } else {
    turbines = undefined;
  }

  // 4. Fetch Generation
  if (plantKey === 'cocaCodoSinclair') {
    try {
      const currentMWh = await cenaceService.fetchPlantProduction('cocaCodoSinclair');
      if (currentMWh !== null && currentMWh > 0) {
        const history = readCenaceHistory();
        const nowMs = now.getTime();
        
        let calculatedMW: number | null = null;
        if (history.length > 0) {
          const prev = history[history.length - 1];
          const diffMs = nowMs - prev.timestamp;
          const diffHours = diffMs / (1000 * 60 * 60);
          const deltaMWh = currentMWh - prev.cocaCodoMWh;

          if (diffHours > 0.1 && deltaMWh >= 0) {
            calculatedMW = deltaMWh / diffHours;
          }
        }

        if (calculatedMW === null || calculatedMW <= 0) {
          const currentLocalHour = Math.max(1, hora === 0 ? 24 : hora);
          calculatedMW = currentMWh / currentLocalHour;
        }

        gen = calculatedMW;
        saveCenaceHistory({ timestamp: nowMs, cocaCodoMWh: currentMWh });
      }
    } catch (err) {
      console.warn(`[Index] Failed to infer CENACE generation for Coca Codo Sinclair:`, err);
    }
  } else {
    try {
      const energyPointsToday = await celecService.fetchDailyEnergy(plant, now);
      const energyResult = extractCelecPoint(energyPointsToday, targetIdx, requireTargetHour);
      if (energyResult.value !== null) {
        gen = energyResult.value;
      }
    } catch (err) {
      if (err instanceof DataPendingError) throw err;
      console.warn(`[Index] Failed to fetch CELEC generation for ${plant.name}:`, err);
    }
  }

  return {
    gen,
    flow,
    flow3hAgo,
    cota,
    turbines,
    timestamp: telemetryTimestamp
  };
}

export { buildMessageText } from './utils/post-formatter.js';

/**
 * Runs the reporting publishing cycle for specified target plants with pending retries.
 */
async function runPublishingCycle(targetPlantKeys: string[] = TARGET_PLANT_KEYS, isForcePublish: boolean = false) {
  console.log(`\n==================================================`);
  console.log(`[Bot] Starting reporting cycle at ${new Date().toLocaleString()}`);
  console.log(`[Bot] Target Plants: ${targetPlantKeys.join(', ')} (Force Publish: ${isForcePublish})`);
  console.log(`==================================================\n`);

  let nationalDemandMW = 4000;
  try {
    const liveProd = await cenaceService.fetchRealTimeProduction();
    if (liveProd.generationCurve && liveProd.generationCurve.length > 0) {
      for (let i = liveProd.generationCurve.length - 1; i >= 0; i--) {
        const pt = liveProd.generationCurve[i];
        if (pt.demandMW !== null && pt.demandMW > 0) {
          nationalDemandMW = pt.demandMW;
          break;
        }
        const calcSum = (pt.totalHydroMW || 0) + (pt.totalThermalMW || 0) + (pt.importsMW || 0) + (pt.renewableMW || 0);
        if (calcSum > 0) {
          nationalDemandMW = calcSum;
          break;
        }
      }
    }
  } catch (err) {
    console.warn('[Index] Could not fetch national demand from CENACE, using fallback.');
  }

  for (let i = 0; i < targetPlantKeys.length; i++) {
    const plantKey = targetPlantKeys[i];
    const plant = hydroelectricPlants[plantKey];
    if (!plant) continue;

    console.log(`[Bot] Processing ${i + 1}/${targetPlantKeys.length}: ${plant.name}...`);
    
    let telemetry: PlantTelemetryData | null = null;
    const maxRetries = isForcePublish ? 1 : 6;
    const retryDelayMs = 5 * 60 * 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        telemetry = await fetchTelemetry(plantKey, !isForcePublish);
        break;
      } catch (error) {
        if (error instanceof DataPendingError && attempt < maxRetries) {
          console.warn(`[Bot] Live telemetry for ${plant.name} for the current hour is pending publication. Retrying in 5 minutes... (Attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        } else {
          console.warn(`[Bot] Could not obtain target hour telemetry for ${plant.name}, falling back to available data:`, error);
          telemetry = await fetchTelemetry(plantKey, false);
          break;
        }
      }
    }

    if (telemetry) {
      try {
        const messageText = buildMessageText(plant, plantKey, telemetry, nationalDemandMW);
        const imageBuffer = await generateReportCard(plantKey, telemetry);

        console.log(`[Bot] Publishing report card for ${plant.name} to X (Data Timestamp: ${telemetry.timestamp.toLocaleTimeString()})...`);
        await xService.postTweet(messageText, imageBuffer);
        console.log(`[Bot] Successfully published ${plant.name}!`);
      } catch (error) {
        console.error(`[Bot] Error publishing ${plant.name}:`, error);
      }
    }

    if (i < targetPlantKeys.length - 1) {
      console.log(`[Bot] Waiting 20 seconds before next post...`);
      await new Promise(resolve => setTimeout(resolve, 20000));
    }
  }

  console.log(`\n[Bot] Publishing cycle completed successfully at ${new Date().toLocaleString()}\n`);
}

// --- STARTUP & SCHEDULING ---

console.log('--------------------------------------------------');
console.log('🤖 Infocaudales Bot Started');
console.log('Schedule: 7:15 AM, 1:15 PM, 7:15 PM (America/Guayaquil)');
console.log('--------------------------------------------------');

const mainCronJob = new CronJob(
  '15 7,13,19 * * *',
  async () => {
    await runPublishingCycle(TARGET_PLANT_KEYS, false);
  },
  null,
  true,
  'America/Guayaquil'
);

mainCronJob.start();

if (process.env.FORCE_PUBLISH === 'true') {
  let forcePlants = TARGET_PLANT_KEYS;
  if (process.env.FORCE_PUBLISH_PLANTS) {
    const requested = process.env.FORCE_PUBLISH_PLANTS.split(',').map(s => s.trim().toLowerCase());
    forcePlants = TARGET_PLANT_KEYS.filter(k => requested.includes(k.toLowerCase()) || requested.includes(hydroelectricPlants[k]?.name.toLowerCase()));
  }

  console.log(`[FORCE PUBLISH] Triggering targeted report publishing cycle for [${forcePlants.join(', ')}] in 5 seconds...`);
  setTimeout(async () => {
    await runPublishingCycle(forcePlants, true);
  }, 5000);
}
