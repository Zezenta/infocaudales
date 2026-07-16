/*
 * There is a special bond between a man and his work
 * Such closeness
 * The calluses on my wrists are the witness of my consistency
 * The bags under my eyes carry the weight of a thousand nights
 * The world and the people i know may forget my name
 * But my work will remember the hands that shaped it
 * With no reward, and no way to explain this passion
 * This is my joy
 * A special kind that only a few will ever understand
 * How lucky am i
 * To live by doing what i love
*/


import fs from 'fs';
import dotenv from 'dotenv';
import { CronJob } from 'cron';
import { hydroelectricPlants } from './data/hydroelectric-plants.js';
import { CelecService, CelecPointValue } from './services/celec.service.js';
import { CenaceService } from './services/cenace.service.js';
import { generateReportCard, generateDailyReport, TelemetryData } from './services/report-generator.service.js';
import { XService } from './services/x.service.js';
import { buildMessageText } from './utils/post-formatter.js';
import { readCenaceHistory, saveCenaceHistory, recordCenaceBaseline, getCcsYesterdayHourlyCurve } from './utils/cenace-history.js';
import { db } from './utils/db.js';
import { systemLogger } from './utils/logger.js';

dotenv.config();

// Globally redirect standard console calls to winston systemLogger to write logs to disk
console.log = (message?: any, ...optionalParams: any[]) => {
  const msg = typeof message === 'string' ? message : (message === undefined ? '' : JSON.stringify(message));
  const extra = optionalParams.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
  systemLogger.info(msg + (extra ? ' ' + extra : ''));
};
console.warn = (message?: any, ...optionalParams: any[]) => {
  const msg = typeof message === 'string' ? message : (message === undefined ? '' : JSON.stringify(message));
  const extra = optionalParams.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
  systemLogger.warn(msg + (extra ? ' ' + extra : ''));
};
console.error = (message?: any, ...optionalParams: any[]) => {
  const msg = typeof message === 'string' ? message : (message === undefined ? '' : JSON.stringify(message));
  const extra = optionalParams.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
  systemLogger.error(msg + (extra ? ' ' + extra : ''));
};

const celecService = new CelecService();
const cenaceService = new CenaceService();
const xService = new XService();

class DataPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataPendingError';
  }
}

// The 6 hydroelectric plants to publish
export const TARGET_PLANT_KEYS = [
  'molino',
  'sopladora',
  'mazar',
  'minasSanFrancisco',
  'agoyan',
  'cocaCodoSinclair'
];

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
export async function fetchTelemetry(plantKey: string, requireTargetHour: boolean = false): Promise<TelemetryData> {
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

    // Contingency for Coca Codo Sinclair: if read flow is 0 m³/s, fallback to current day's latest non-zero flow
    if (plantKey === 'cocaCodoSinclair' && flow === 0) {
      console.warn(`[Index] Coca Codo Sinclair flow is 0 m³/s. Searching current day for latest non-zero flow...`);
      for (let i = targetIdx; i < flowPointsToday.length; i++) {
        const pVal = flowPointsToday[i]?.value;
        if (pVal !== null && pVal !== undefined && pVal > 0) {
          flow = pVal;
          console.log(`[Index] Contingency applied: using current day's non-zero flow (${flow} m³/s) for Coca Codo Sinclair.`);
          break;
        }
      }
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
      // Find today's date parts in Ecuador timezone
      const ecTime = new Date(now.getTime() - 5 * 60 * 60 * 1000);
      const year = ecTime.getUTCFullYear();
      const month = ecTime.getUTCMonth();
      const date = ecTime.getUTCDate();
      
      // Target UTC timestamp of the completed hour (e.g. 7:00 AM local = 12:00:00 UTC)
      const targetUtcMs = Date.UTC(year, month, date, hora + 5);
      const prevUtcMs = targetUtcMs - 60 * 60 * 1000;

      const rows = db.prepare(`
        SELECT timestamp, accumulated_mwh 
        FROM coca_codo_hourly_log 
        WHERE timestamp = ? OR timestamp = ?
        ORDER BY timestamp ASC
      `).all(prevUtcMs, targetUtcMs) as any[];

      if (rows.length === 2) {
        const start = rows[0];
        const end = rows[1];
        const diffHours = (end.timestamp - start.timestamp) / (1000 * 60 * 60);
        const deltaMWh = end.accumulated_mwh - start.accumulated_mwh;
        
        if (diffHours > 0.05 && deltaMWh >= 0) {
          const rawRate = deltaMWh / diffHours;
          gen = Math.min(rawRate, 1500); // Cap at max capacity
          console.log(`[Index] Inferred completed hourly generation for Coca Codo Sinclair from SQLite: ${gen.toFixed(2)} MW`);
        }
      }

      if (gen === null) {
        // Fallback to daily average from CENACE live scrape
        console.log(`[Index] Completed hourly logs for Coca Codo Sinclair not found in SQLite. Falling back to daily average.`);
        const currentMWh = await cenaceService.fetchPlantProduction('cocaCodoSinclair');
        if (currentMWh !== null && currentMWh > 0) {
          const currentLocalHour = Math.max(1, hora === 0 ? 24 : hora);
          gen = currentMWh / currentLocalHour;
        }
      }
    } catch (err) {
      console.warn(`[Index] Failed to fetch SQLite/CENACE generation for Coca Codo Sinclair:`, err);
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
    
    let telemetry: TelemetryData | null = null;
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

        const timeStr = (telemetry.timestamp ?? new Date()).toLocaleTimeString();
        console.log(`[Bot] Publishing report card for ${plant.name} to X (Data Timestamp: ${timeStr})...`);
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
console.log('CENACE Hourly Logging: Every hour on the hour');
console.log('Publishing Schedule: 7:15 AM, 1:15 PM, 7:15 PM (America/Guayaquil)');
console.log('Daily Report Schedule: 8:30 AM (America/Guayaquil)');
console.log('--------------------------------------------------');

// 7:15 AM (Morning Run - 4 plants)
const morningCronJob = new CronJob(
  '15 7 * * *',
  async () => {
    const morningPlants = ['mazar', 'minasSanFrancisco', 'agoyan', 'cocaCodoSinclair'];
    console.log('[CronJob] Running Morning Publishing Cycle...');
    await runPublishingCycle(morningPlants, false);
  },
  null,
  true,
  'America/Guayaquil'
);

// 1:15 PM (Afternoon Run - 4 plants including Molino)
const afternoonCronJob = new CronJob(
  '15 13 * * *',
  async () => {
    const afternoonPlants = ['molino', 'mazar', 'minasSanFrancisco', 'agoyan'];
    console.log('[CronJob] Running Afternoon Publishing Cycle...');
    await runPublishingCycle(afternoonPlants, false);
  },
  null,
  true,
  'America/Guayaquil'
);

// 7:15 PM (Evening Run - 4 plants including Sopladora)
const eveningCronJob = new CronJob(
  '15 19 * * *',
  async () => {
    const eveningPlants = ['sopladora', 'minasSanFrancisco', 'agoyan', 'cocaCodoSinclair'];
    console.log('[CronJob] Running Evening Publishing Cycle...');
    await runPublishingCycle(eveningPlants, false);
  },
  null,
  true,
  'America/Guayaquil'
);

function getFormattedEcuadorDate(date: Date): string {
  const daysOfWeek = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
  ];
  const ecTime = new Date(date.getTime() - 5 * 60 * 60 * 1000);
  const dayName = daysOfWeek[ecTime.getUTCDay()];
  const day = ecTime.getUTCDate();
  const monthName = months[ecTime.getUTCMonth()];
  const year = ecTime.getUTCFullYear();
  return `${dayName}, ${day} de ${monthName} del ${year}`;
}

async function publishDailyConsolidatedReport() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dateStr = getFormattedEcuadorDate(yesterday);

  console.log(`\n[CronJob] [Daily Report] Starting daily publication cycle for target date: ${dateStr}...`);

  // Local helper to fetch, slice last 24 values, and assert non-null numbers
  const fetchAndVerifyTelemetry = async (
    fetchFn: () => Promise<CelecPointValue[] | null>,
    fieldName: string
  ): Promise<number[]> => {
    const points = await fetchFn();
    if (!points || points.length < 24) {
      throw new Error(`${fieldName} telemetry is incomplete or offline in CELEC.`);
    }
    const sliced = [...points].reverse().slice(0, 24);
    if (sliced.some(p => !p || p.value === null || p.value === undefined)) {
      throw new Error(`${fieldName} telemetry contains invalid or null values.`);
    }
    return sliced.map(p => p.value!);
  };

  try {
    // 1. Fetch CENACE yesterday operational data
    let cenaceData: any;
    let ccsYesterdayMWh = 0;
    let totalNationalMWh = 0;
    try {
      cenaceData = await cenaceService.fetchYesterdayOperationalData();
      ccsYesterdayMWh = cenaceData.plantsDailyTotalMWh.cocaCodoSinclair;
      if (!ccsYesterdayMWh || ccsYesterdayMWh <= 0) {
        throw new Error("Coca Codo Sinclair yesterday MWh is missing or invalid in CENACE data.");
      }
      if (!cenaceData.compositionMWh || Object.keys(cenaceData.compositionMWh).length === 0) {
        throw new Error("Yesterday matrix composition is missing in CENACE data.");
      }
      totalNationalMWh = (Object.values(cenaceData.compositionMWh) as number[]).reduce((a: number, b: number) => a + b, 0);
      if (totalNationalMWh <= 0) {
        throw new Error("Total national MWh is zero or invalid in CENACE composition data.");
      }
    } catch (err: any) {
      if (process.env.FORCE_DAILY_REPORT === 'true') {
        console.warn(`[Bot] [Daily Report] CENACE validation failed: "${err.message}". Forcing fallback composition values...`);
        ccsYesterdayMWh = ccsYesterdayMWh || 12000;
        totalNationalMWh = totalNationalMWh || 80000;
        cenaceData = cenaceData || {
          plantsDailyTotalMWh: { cocaCodoSinclair: ccsYesterdayMWh },
          compositionMWh: { Hidroeléctrica: 60000, Térmica: 15000, Importación: 5000 }
        };
      } else {
        throw err;
      }
    }

    // 2. Validate and retrieve Coca Codo Sinclair actual hourly curve
    const ccsGenHistory = getCcsYesterdayHourlyCurve(yesterday);
    if (!ccsGenHistory || ccsGenHistory.length < 24 || ccsGenHistory.some(val => val === null || val === undefined || isNaN(val))) {
      throw new Error("Coca Codo Sinclair hourly telemetry is incomplete (less than 20 records in SQLite database). Daily report aborted.");
    }

    // 3. Fetch CCS Flow history (Caudal) from CELEC
    let ccsFlowHistory: number[];
    try {
      ccsFlowHistory = await fetchAndVerifyTelemetry(
        () => celecService.fetchFlow(hydroelectricPlants.cocaCodoSinclair, yesterday),
        "Coca Codo Sinclair flow (caudal)"
      );
    } catch (err: any) {
      if (process.env.FORCE_DAILY_REPORT === 'true') {
        console.warn(`[Bot] [Daily Report] CCS flow telemetry failed: "${err.message}". Forcing fallback flow curve...`);
        ccsFlowHistory = Array(24).fill(600);
      } else {
        throw err;
      }
    }

    const ccsMaxMW = hydroelectricPlants.cocaCodoSinclair.physicalData?.maxEnergyMW || 1500;
    const ccsFactor = (ccsYesterdayMWh / (ccsMaxMW * 24)) * 100;

    const plantPayloads: any[] = [{
      key: 'cocaCodoSinclair',
      todayMWh: ccsYesterdayMWh,
      factor: ccsFactor,
      genHistory: ccsGenHistory,
      caudalHistory: ccsFlowHistory
    }];

    // 4. Fetch and strictly validate the other 5 CELEC plants
    const celecPlantsList = [
      { key: 'molino', hasCota: true },
      { key: 'sopladora', hasCota: false },
      { key: 'mazar', hasCota: true },
      { key: 'minasSanFrancisco', hasCota: true },
      { key: 'agoyan', hasCota: true }
    ];

    for (const item of celecPlantsList) {
      const plant = hydroelectricPlants[item.key];
      const maxMW = plant.physicalData?.maxEnergyMW || 100;
      const name = plant.name;

      let genHistory: number[] | undefined = undefined;
      let caudalHistory: number[] | undefined = undefined;
      let cotaHistory: number[] | undefined = undefined;

      try {
        genHistory = await fetchAndVerifyTelemetry(
          () => celecService.fetchDailyEnergy(plant, yesterday),
          `Plant ${item.key} daily energy`
        );
        caudalHistory = await fetchAndVerifyTelemetry(
          () => celecService.fetchFlow(plant, yesterday),
          `Plant ${item.key} flow (caudal)`
        );
        if (item.hasCota) {
          cotaHistory = await fetchAndVerifyTelemetry(
            () => celecService.fetchLevel(plant, yesterday),
            `Plant ${item.key} level (cota)`
          );
        }
      } catch (err: any) {
        if (process.env.FORCE_DAILY_REPORT === 'true') {
          console.warn(`[Bot] [Daily Report] Telemetry query for ${name} failed: "${err.message}". Forcing fallback curves...`);
          genHistory = genHistory || Array(24).fill(maxMW * 0.5);
          caudalHistory = caudalHistory || Array(24).fill(100);
          if (item.hasCota) {
            const minC = plant.physicalData?.minLevelMasl || 0;
            const maxC = plant.physicalData?.maxLevelMasl || 100;
            cotaHistory = cotaHistory || Array(24).fill((minC + maxC) / 2);
          }
        } else {
          throw err;
        }
      }

      const finalGenHistory = genHistory || Array(24).fill(maxMW * 0.5);
      const finalCaudalHistory = caudalHistory || Array(24).fill(100);

      const todayMWh = finalGenHistory.reduce((a, b) => a + b, 0);
      const factor = (todayMWh / (maxMW * 24)) * 100;

      plantPayloads.push({
        key: item.key,
        todayMWh,
        factor,
        genHistory: finalGenHistory,
        caudalHistory: finalCaudalHistory,
        cotaHistory
      });
    }

    const sum6PlantsMWh = plantPayloads.reduce((sum, p) => sum + p.todayMWh, 0);
    const nationalShare = (sum6PlantsMWh / totalNationalMWh) * 100;

    const liveData = {
      plants: plantPayloads,
      dateStr,
      nationalShare
    };

    // 5. Generate Daily Consolidated Report image
    const tempPath = `/tmp/daily-report-capture-${Date.now()}.png`;
    console.log('[CronJob] [Daily Report] Generating Daily Consolidated Report image card...');
    await generateDailyReport(tempPath, liveData);

    if (!fs.existsSync(tempPath)) {
      throw new Error("Failed to generate daily report screenshot.");
    }
    const imageBuffer = fs.readFileSync(tempPath);

    // 6. Tweet the report to X
    const postMessage = `💧 Reporte diario de generación de las 6 principales centrales hidroeléctricas del país para el ${dateStr}.\n\n` +
      `Estas 6 centrales produjeron el ${nationalShare.toFixed(2)}% de la energía generada a nivel nacional.\n\n` +
      `#Ecuador #Energía #EnergíaEc`;

    console.log(`[CronJob] [Daily Report] Posting daily report to X...`);
    await xService.postTweet(postMessage, imageBuffer);
    console.log('[CronJob] [Daily Report] Daily Consolidated Report published successfully!');

    // Cleanup temp file
    try { fs.unlinkSync(tempPath); } catch {}
  } catch (err: any) {
    console.error(`[CronJob] [Daily Report] ABORTED: Failed daily report publication cycle:`, err?.message || err);
  }
}

const hourlyCenaceLogJob = new CronJob(
  '0 * * * *',
  async () => {
    console.log('\n[CronJob] Running hourly Coca Codo Sinclair baseline recording...');
    await recordCenaceBaseline(cenaceService);
  },
  null,
  true,
  'America/Guayaquil'
);

const dailyReportCronJob = new CronJob(
  '30 8 * * *',
  async () => {
    await publishDailyConsolidatedReport();
  },
  null,
  true,
  'America/Guayaquil'
);

morningCronJob.start();
afternoonCronJob.start();
eveningCronJob.start();
hourlyCenaceLogJob.start();
dailyReportCronJob.start();

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

if (process.env.FORCE_DAILY_REPORT === 'true') {
  console.log('[FORCE DAILY REPORT] Triggering daily report publishing cycle in 10 seconds...');
  setTimeout(async () => {
    try {
      await publishDailyConsolidatedReport();
    } catch (err: any) {
      console.error('[FORCE DAILY REPORT] Forced daily report publication failed:', err?.message || err);
    }
  }, 10000);
}
