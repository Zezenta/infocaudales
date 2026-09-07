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
// Production Deployment Verification Marker



import fs from 'fs';
import dotenv from 'dotenv';
import { CronJob } from 'cron';
import { hydroelectricPlants } from './data/hydroelectric-plants.js';
import { CelecService, CelecPointValue } from './services/celec.service.js';
import { CenaceService } from './services/cenace.service.js';
import { generateReportCard, generateDailyReport, generateForecastCard, TelemetryData } from './services/report-generator.service.js';
import { PredictionService } from './services/prediction.service.js';
import { XService } from './services/x.service.js';
import { buildMessageText, buildForecastPostText, buildWeeklyAccuracyReportText } from './utils/post-formatter.js';
import {
  recordForecastBatch,
  reconcileForecastsWithCelec,
  calculateWeeklyAccuracyMetrics,
  ForecastLogRecord
} from './services/forecast-history.service.js';
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
const predictionService = new PredictionService();

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
  if (!pointsToday || pointsToday.length === 0) return { value: null };

  const safeIdx = Math.min(Math.max(0, targetIdx), pointsToday.length - 1);

  if (pointsToday[safeIdx] && pointsToday[safeIdx].value !== null && pointsToday[safeIdx].value !== undefined) {
    const pointDate = pointsToday[safeIdx].timestamp ? new Date(pointsToday[safeIdx].timestamp) : undefined;
    return { value: pointsToday[safeIdx].value, timestamp: pointDate };
  }

  if (requireTargetHour) {
    throw new DataPendingError(`CELEC target point at index ${safeIdx} is not yet published (null)`);
  }

  // Fallback mode: find first available non-null point starting from safeIdx onwards
  for (let i = safeIdx; i < pointsToday.length; i++) {
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
 * Returns null if essential live metrics (gen, flow) cannot be obtained.
 */
export async function fetchTelemetry(plantKey: string, requireTargetHour: boolean = false): Promise<TelemetryData | null> {
  const plant = hydroelectricPlants[plantKey];
  if (!plant) throw new Error(`Plant ${plantKey} not found in configuration`);

  const now = new Date();
  const { hora } = celecService.getEcuadorDateParts(now);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const targetIdx = Math.max(0, 24 - hora);

  let flow: number | null = null;
  let flow3hAgo: number | null = null;
  let cota: number | undefined = undefined;
  let turbines: number | undefined = undefined;
  let gen: number | null = null;
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
        const idxYesterday = Math.max(0, 3 - hora);
        const flow3hResult = extractCelecPoint(flowPointsYesterday, idxYesterday, false);
        if (flow3hResult.value !== null) {
          flow3hAgo = flow3hResult.value;
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

      let ccsGen: number | null = null;

      if (rows.length === 2) {
        const start = rows[0];
        const end = rows[1];
        const diffHours = (end.timestamp - start.timestamp) / (1000 * 60 * 60);
        let deltaMWh = end.accumulated_mwh - start.accumulated_mwh;
        if (deltaMWh < 0) {
          // Midnight counter reset: at 00:00 local time, CENACE resets its accumulated MWh counter to 0.
          deltaMWh = end.accumulated_mwh;
        }
        
        if (diffHours > 0.05 && deltaMWh >= 0) {
          const rawRate = deltaMWh / diffHours;
          ccsGen = Math.min(rawRate, 1500); // Cap at max capacity
          console.log(`[Index] Inferred completed hourly generation for Coca Codo Sinclair from SQLite: ${ccsGen.toFixed(2)} MW`);
        }
      }

      if (ccsGen === null) {
        // Fallback to daily average from CENACE live scrape
        console.log(`[Index] Completed hourly logs for Coca Codo Sinclair not found in SQLite. Falling back to daily average.`);
        const currentMWh = await cenaceService.fetchPlantProduction('cocaCodoSinclair');
        if (currentMWh !== null && currentMWh > 0) {
          const currentLocalHour = Math.max(1, hora === 0 ? 24 : hora);
          ccsGen = currentMWh / currentLocalHour;
        }
      }

      if (ccsGen !== null) {
        gen = ccsGen;
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

  // Strict live validation: do not return mock/fake numbers if vital telemetry is unavailable
  if (gen === null || flow === null) {
    console.warn(`[Index] Aborting telemetry for ${plant.name}: missing live data (gen: ${gen}, flow: ${flow})`);
    return null;
  }

  return {
    gen,
    flow,
    flow3hAgo: flow3hAgo ?? flow,
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
        if (telemetry) break;
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
    } else {
      console.error(`[Bot] Skipped publishing ${plant.name} due to unavailable live telemetry.`);
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
console.log('Hourly Recording & Reconciliation: Every hour at xx:15 (America/Guayaquil)');
console.log('Telemetry Reports Schedule: 7:15 AM, 1:15 PM, 7:15 PM (America/Guayaquil)');
console.log('Daily Consolidated Report: 8:30 AM (America/Guayaquil)');
console.log('Hydrological Forecasts: 6:30 AM, 16:30 PM (America/Guayaquil)');
console.log('Sunday Accuracy Report: Sundays at 20:30 PM (America/Guayaquil)');
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

// --- HYDROLOGICAL FORECASTS & ACCURACY EVALUATION ---

export const FORECAST_SCHEDULE_ROTATION: Record<number, { morning: string; afternoon: string }> = {
  1: { morning: 'cocaCodoSinclair', afternoon: 'mazar' },              // Lunes
  2: { morning: 'molino', afternoon: 'agoyan' },                       // Martes
  3: { morning: 'sopladora', afternoon: 'minasSanFrancisco' },         // Miércoles
  4: { morning: 'cocaCodoSinclair', afternoon: 'mazar' },              // Jueves
  5: { morning: 'molino', afternoon: 'agoyan' },                       // Viernes
  6: { morning: 'sopladora', afternoon: 'minasSanFrancisco' },         // Sábado
  0: { morning: 'cocaCodoSinclair', afternoon: '' }                    // Domingo
};

export async function publishForecastForPlant(plantKey: string): Promise<void> {
  const plant = hydroelectricPlants[plantKey];
  if (!plant) {
    throw new Error(`[Forecast] Hydroelectric plant ${plantKey} not found in configuration.`);
  }

  console.log(`\n[Forecast] Starting forecast publication pipeline for: ${plant.name} (${plantKey})...`);
  const now = new Date();

  // 1. Fetch current live flow directly from CELEC
  const flowPoints = await celecService.fetchFlow(plant, now);
  const { hora } = celecService.getEcuadorDateParts(now);
  const targetIdx = Math.max(0, 24 - hora);
  const flowResult = extractCelecPoint(flowPoints, targetIdx, false);
  
  let currentFlow = flowResult.value;

  // Contingency for Coca Codo Sinclair: if read flow is 0 m³/s, find latest non-zero flow of the day
  if (plantKey === 'cocaCodoSinclair' && currentFlow === 0 && flowPoints) {
    for (let i = targetIdx; i < flowPoints.length; i++) {
      const pVal = flowPoints[i]?.value;
      if (pVal !== null && pVal !== undefined && pVal > 0) {
        currentFlow = pVal;
        console.log(`[Forecast] Contingency applied: using non-zero flow (${currentFlow} m³/s) for Coca Codo Sinclair.`);
        break;
      }
    }
  }

  if (currentFlow === null || currentFlow === undefined || isNaN(currentFlow)) {
    throw new Error(`[Forecast] Unable to retrieve valid flow for ${plant.name}. Forecast publication aborted.`);
  }

  console.log(`[Forecast] Current flow for ${plant.name}: ${currentFlow} m³/s. Generating 6h multi-COMID forecast...`);

  // 2. Generate 6h multi-COMID predictions
  const prediction = await predictionService.predictPlantFlow(plantKey, {
    horizon: '6h',
    currentFlow,
    targetDate: now
  });

  // 3. Save forecast trajectory steps to SQLite for weekly evaluation
  const batch: Omit<ForecastLogRecord, 'id' | 'actualFlow' | 'resolvedAt'>[] = [];
  const trajectory = prediction.trajectory || [];
  for (let h = 1; h <= 6; h++) {
    const stepPoint = trajectory.find(t => t.step === h);
    const p50 = stepPoint?.percentiles?.p50 ?? prediction.forecastFlow;
    const p10 = stepPoint?.percentiles?.p10 ?? (prediction.percentiles?.p10 ?? p50);
    const p25 = stepPoint?.percentiles?.p25 ?? (prediction.percentiles?.p25 ?? p50);
    const p75 = stepPoint?.percentiles?.p75 ?? (prediction.percentiles?.p75 ?? p50);
    const p90 = stepPoint?.percentiles?.p90 ?? (prediction.percentiles?.p90 ?? p50);
    const modelSpec = stepPoint?.modelSpec ?? prediction.modelSpec;

    batch.push({
      plantKey,
      issuedAt: now.getTime(),
      targetTime: now.getTime() + h * 3600 * 1000,
      horizonHours: h,
      modelName: modelSpec?.modelName || 'multi_guarded',
      initialFlow: currentFlow,
      predictedFlow: p50,
      p10,
      p25,
      p75,
      p90,
      maeExpected: modelSpec?.mae ?? prediction.mae ?? 0
    });
  }
  recordForecastBatch(batch);

  // 4. Generate high-resolution Forecast PNG card
  console.log(`[Forecast] Generating 600x600 PNG forecast card for ${plant.name}...`);
  const imageBuffer = await generateForecastCard(plantKey, {
    currentFlow,
    date: now,
    stepPredictions: trajectory.filter(t => !t.isHistorical && t.step > 0).map(t => ({
      step: t.step,
      flow: t.percentiles?.p50 ?? prediction.forecastFlow,
      mae: t.modelSpec?.mae ?? prediction.mae ?? 0
    }))
  });

  // 5. Format social media post text
  const messageText = buildForecastPostText(plant, plantKey, {
    currentFlow,
    targetFlow: prediction.forecastFlow,
    p25: prediction.percentiles?.p25 ?? prediction.forecastFlow,
    p75: prediction.percentiles?.p75 ?? prediction.forecastFlow,
    horizonHours: 6,
    modelName: prediction.modelSpec?.modelName || 'multi_guarded',
    mae: prediction.mae ?? 0
  });

  console.log(`\n📱 [Forecast Post Text]\n${messageText}\n`);

  // 6. Post to X
  console.log(`[Forecast] Publishing forecast card for ${plant.name} to X...`);
  await xService.postTweet(messageText, imageBuffer);
  console.log(`[Forecast] Successfully published forecast for ${plant.name}!`);
}

export async function publishForecastTurn(slot: 'morning' | 'afternoon'): Promise<void> {
  const ecTime = new Date(Date.now() - 5 * 3600 * 1000);
  const dayOfWeek = ecTime.getUTCDay(); // 0: Sun, 1: Mon, ... 6: Sat
  const plantKey = FORECAST_SCHEDULE_ROTATION[dayOfWeek]?.[slot];

  if (!plantKey) {
    console.log(`[Forecast] No scheduled plant for day ${dayOfWeek} slot ${slot}. Skipping.`);
    return;
  }

  try {
    await publishForecastForPlant(plantKey);
  } catch (err: any) {
    console.error(`[Forecast] Failed forecast publication turn for ${plantKey}:`, err?.message || err);
  }
}

export async function publishWeeklyAccuracyReport(): Promise<void> {
  console.log('\n[CronJob] [Weekly Accuracy Report] Starting Sunday accuracy evaluation...');

  // 1. Reconcile any pending forecasts first
  try {
    await reconcileForecastsWithCelec(celecService);
  } catch (err: any) {
    console.warn('[Weekly Accuracy Report] Non-fatal error during telemetry reconciliation:', err?.message || err);
  }

  // 2. Calculate accuracy metrics for the past 7 days
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
  const summary = calculateWeeklyAccuracyMetrics(sevenDaysAgo, now);

  // 3. Format text-only report
  const reportText = buildWeeklyAccuracyReportText(summary);
  console.log('\n📱 [Weekly Accuracy Report Text]\n' + reportText + '\n');

  // 4. Post text report to X
  try {
    await xService.postText(reportText);
    console.log('[CronJob] [Weekly Accuracy Report] Published successfully to X!');
  } catch (err: any) {
    console.error('[CronJob] [Weekly Accuracy Report] Error posting to X:', err?.message || err);
  }
}

// --- CRON JOBS SETUP ---

const hourlyCenaceLogJob = new CronJob(
  '15 * * * *',
  async () => {
    console.log('\n[CronJob] Running hourly Coca Codo Sinclair baseline recording and forecast reconciliation (xx:15)...');
    await recordCenaceBaseline(cenaceService);
    try {
      await reconcileForecastsWithCelec(celecService);
    } catch (err: any) {
      console.warn('[CronJob] Hourly forecast reconciliation failed:', err?.message || err);
    }
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

// 06:30 AM (Morning Forecast - 1 plant per weekly rotation)
const morningForecastCronJob = new CronJob(
  '30 6 * * *',
  async () => {
    console.log('[CronJob] Running Morning Forecast Publishing Cycle (06:30 AM)...');
    await publishForecastTurn('morning');
  },
  null,
  true,
  'America/Guayaquil'
);

// 16:30 PM (Afternoon Forecast - 1 plant per weekly rotation)
const afternoonForecastCronJob = new CronJob(
  '30 16 * * *',
  async () => {
    console.log('[CronJob] Running Afternoon Forecast Publishing Cycle (16:30 PM)...');
    await publishForecastTurn('afternoon');
  },
  null,
  true,
  'America/Guayaquil'
);

// Sunday 20:30 PM (Weekly Accuracy Report - Text Only)
const sundayAccuracyCronJob = new CronJob(
  '30 20 * * 0',
  async () => {
    console.log('[CronJob] Running Sunday Weekly Accuracy Report (20:30 PM)...');
    await publishWeeklyAccuracyReport();
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
morningForecastCronJob.start();
afternoonForecastCronJob.start();
sundayAccuracyCronJob.start();

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

if (process.env.FORCE_FORECAST === 'true') {
  const target = process.env.FORCE_FORECAST_PLANT || 'cocaCodoSinclair';
  console.log(`[FORCE FORECAST] Triggering forecast publication for ${target} in 5 seconds...`);
  setTimeout(async () => {
    try {
      await publishForecastForPlant(target);
    } catch (err: any) {
      console.error(`[FORCE FORECAST] Forced forecast publication failed for ${target}:`, err?.message || err);
    }
  }, 5000);
}

if (process.env.FORCE_ACCURACY_REPORT === 'true') {
  console.log('[FORCE ACCURACY REPORT] Triggering weekly accuracy report in 8 seconds...');
  setTimeout(async () => {
    try {
      await publishWeeklyAccuracyReport();
    } catch (err: any) {
      console.error('[FORCE ACCURACY REPORT] Forced weekly accuracy report failed:', err?.message || err);
    }
  }, 8000);
}
