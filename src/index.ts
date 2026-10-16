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
import { CelecService, CelecPointValue } from './services/telemetry/celec.service.js';
import { CenaceService } from './services/telemetry/cenace.service.js';
import { generateReportCard, generateDailyReport, generateForecastCard, generateSocialCover, TelemetryData } from './services/report-generator.service.js';
import { PredictionService } from './services/prediction.service.js';
import { XService } from './services/social/x.service.js';
import { FacebookService } from './services/social/facebook.service.js';
import { InstagramService } from './services/social/instagram.service.js';
import { SatelliteTelemetryService, SatelliteMapService } from './services/telemetry/satellite-telemetry.service.js';
import { VideoCompilerService } from './services/satellite/video-compiler.service.js';
import { RainMonitorService } from './services/satellite/rain-monitor.service.js';
import { SatelliteArchiverService } from './services/satellite/satellite-archiver.service.js';
import { buildMessageText, buildForecastPostText, buildWeeklyAccuracyReportText, buildCompactWeeklyAccuracyReportText, buildSocialRoundupCaption } from './utils/post-formatter.js';
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
const facebookService = new FacebookService();
const instagramService = new InstagramService();
const predictionService = new PredictionService();
const satelliteService = new SatelliteMapService();
const videoCompilerService = new VideoCompilerService(satelliteService);
const satelliteArchiverService = new SatelliteArchiverService(satelliteService);
const rainMonitorService = new RainMonitorService(
  satelliteService,
  videoCompilerService,
  xService,
  satelliteArchiverService,
  facebookService,
  instagramService
);

// Target basins monitored continuously for convective rain
export const MONITORED_RAIN_BASINS = ['cocaCodoSinclair', 'paute'];

// The 6 hydroelectric plants to publish
export const TARGET_PLANT_KEYS = [
  'molino',
  'sopladora',
  'mazar',
  'minasSanFrancisco',
  'agoyan',
  'cocaCodoSinclair'
];

import {
  DataPendingError,
  extractCelecPoint,
  fetchTelemetry
} from './services/telemetry/live-telemetry.service.js';

export { DataPendingError, extractCelecPoint, fetchTelemetry };

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

  const igPlantCards: Buffer[] = [];

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
        const imageBuffer = await generateReportCard(plantKey, telemetry, { brand: 'x' });

        const timeStr = (telemetry.timestamp ?? new Date()).toLocaleTimeString();
        console.log(`[Bot] Publishing report card for ${plant.name} to X (Data Timestamp: ${timeStr})...`);
        await xService.postTweet(messageText, imageBuffer);
        console.log(`[Bot] Successfully published ${plant.name} to X!`);

        // Also generate card with Instagram brand for carousel/album
        try {
          const igCardBuffer = await generateReportCard(plantKey, telemetry, { brand: 'instagram' });
          igPlantCards.push(igCardBuffer);
        } catch (igGenErr) {
          console.warn(`[Bot] Could not generate Instagram card for ${plant.name}:`, igGenErr);
        }
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

  // Publish consolidated Carousel to Instagram and Multi-Photo Album to Facebook
  if (igPlantCards.length > 0) {
    try {
      console.log(`\n[Bot] [Social Roundup] Preparing Carousel for Instagram & Album for Facebook...`);
      const coverBuffer = await generateSocialCover();
      const allSocialItems = [coverBuffer, ...igPlantCards];

      const now = new Date();
      const dateFormatted = getFormattedEcuadorDate(now);
      const ecParts = new Date(now.getTime() - 5 * 3600 * 1000);
      const hourStr = `${String(ecParts.getUTCHours()).padStart(2, '0')}:${String(ecParts.getUTCMinutes()).padStart(2, '0')} ECT`;

      const caption = buildSocialRoundupCaption({
        dateStr: dateFormatted,
        hourStr,
        plantCount: igPlantCards.length
      });

      // 1. Post to Instagram Carousel
      try {
        console.log(`[Bot] [Instagram] Publishing ${allSocialItems.length}-slide carousel...`);
        const igRes = await instagramService.postCarousel(allSocialItems, caption);
        console.log(`[Bot] [Instagram] Carousel published successfully! (Media ID: ${igRes.mediaId}, URL: ${igRes.permalink || 'N/A'})`);
      } catch (igErr: any) {
        console.error(`[Bot] [Instagram] Error publishing carousel:`, igErr?.message || igErr);
      }

      // 2. Post to Facebook Multi-Photo Album
      try {
        console.log(`[Bot] [Facebook] Publishing ${allSocialItems.length}-photo album...`);
        const fbRes = await facebookService.postPhotos(allSocialItems, caption);
        console.log(`[Bot] [Facebook] Album published successfully! (Post ID: ${fbRes.postId}, URL: ${fbRes.permalink || 'N/A'})`);
      } catch (fbErr: any) {
        console.error(`[Bot] [Facebook] Error publishing album:`, fbErr?.message || fbErr);
      }
    } catch (socialErr: any) {
      console.error(`[Bot] [Social Roundup] Error creating social media package:`, socialErr?.message || socialErr);
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

// 7:15 PM (Evening Run - 5 plants including Mazar and Sopladora)
const eveningCronJob = new CronJob(
  '15 19 * * *',
  async () => {
    const eveningPlants = ['mazar', 'sopladora', 'minasSanFrancisco', 'agoyan', 'cocaCodoSinclair'];
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
    console.log('[CronJob] [Daily Report] Daily Consolidated Report published successfully to X!');

    // 7. Post to Facebook Page
    console.log(`[CronJob] [Daily Report] Posting daily report to Facebook...`);
    try {
      const fbRes = await facebookService.postPhoto(imageBuffer, postMessage);
      console.log(`[CronJob] [Daily Report] Daily Consolidated Report published successfully to Facebook (Post ID: ${fbRes.postId})!`);
    } catch (fbErr: any) {
      console.error(`[CronJob] [Daily Report] Error posting to Facebook:`, fbErr?.message || fbErr);
    }

    // 8. Post to Instagram Feed
    console.log(`[CronJob] [Daily Report] Posting daily report to Instagram...`);
    try {
      const igRes = await instagramService.postPhoto(imageBuffer, postMessage);
      console.log(`[CronJob] [Daily Report] Daily Consolidated Report published successfully to Instagram (Media ID: ${igRes.mediaId})!`);
    } catch (igErr: any) {
      console.error(`[CronJob] [Daily Report] Error posting to Instagram:`, igErr?.message || igErr);
    }

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

  // 4. Post text report to X with fallback to compact version
  try {
    await xService.postText(reportText);
    console.log('[CronJob] [Weekly Accuracy Report] Published successfully to X!');
  } catch (err: any) {
    console.warn('[CronJob] [Weekly Accuracy Report] Error posting full report to X:', err?.message || err);
    console.log('[CronJob] [Weekly Accuracy Report] Attempting fallback to compact version (<280 chars)...');
    try {
      const compactText = buildCompactWeeklyAccuracyReportText(summary);
      console.log('\n📱 [Weekly Accuracy Report Fallback Text]\n' + compactText + '\n');
      await xService.postText(compactText);
      console.log('[CronJob] [Weekly Accuracy Report] Compact fallback report published successfully to X!');
    } catch (fallbackErr: any) {
      console.error('[CronJob] [Weekly Accuracy Report] Error posting compact fallback report to X:', fallbackErr?.message || fallbackErr);
    }
  }

  // 5. Post text report to Facebook Page
  try {
    console.log('[CronJob] [Weekly Accuracy Report] Posting report to Facebook...');
    const fbRes = await facebookService.postMessage(reportText);
    console.log(`[CronJob] [Weekly Accuracy Report] Published successfully to Facebook (Post ID: ${fbRes.postId})!`);
  } catch (fbErr: any) {
    console.error('[CronJob] [Weekly Accuracy Report] Error posting report to Facebook:', fbErr?.message || fbErr);
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

/**
 * Continuous Satellite Rain & Convective Activity Monitoring Cycle.
 * Evaluates target basins every 10 minutes in sync with GOES-16 Full Disk scans.
 */
async function runRainMonitoringCycle() {
  const isRainMonitorEnabled = process.env.ENABLE_RAIN_MONITOR !== 'false';
  if (!isRainMonitorEnabled) {
    return;
  }

  const autoPublish = process.env.AUTO_PUBLISH_RAIN_ALERTS !== 'false';

  // 1. Sync latest satellite frames to SQLite archive (GeoServer and NASA GIBS)
  try {
    await satelliteArchiverService.archiveLatestFrames({ limit: 18, plantKey: 'ecuador', source: 'geoserver' });
  } catch (archErr: any) {
    systemLogger.warn(`[RainMonitor Cron] GeoServer satellite archival warning: ${archErr?.message || archErr}`);
  }

  try {
    await satelliteArchiverService.archiveLatestFrames({ plantKey: 'ecuador', source: 'nasa_gibs' });
  } catch (archErr: any) {
    systemLogger.warn(`[RainMonitor Cron] NASA GIBS satellite archival warning: ${archErr?.message || archErr}`);
  }

  // 2. Evaluate target basins
  for (const basinKey of MONITORED_RAIN_BASINS) {
    try {
      const result = await rainMonitorService.checkBasin(basinKey, {
        autoPublishToX: autoPublish
      });

      if (result.action === 'STORM_STARTED') {
        console.log(`[RainMonitor] 🚨 Inicio de actividad lluviosa detectada en ${basinKey} (${result.coveragePct}% cobertura)`);
      } else if (result.action === 'VIDEO_COMPILED') {
        console.log(`[RainMonitor] 🎬 Alerta de lluvia compilada para ${basinKey}. Pico: ${result.peakCoveragePct}%. Tweet ID: ${result.publishedTweetId || 'N/A'}`);
      } else if (result.action === 'STORM_MONITORING') {
        console.log(`[RainMonitor] ⚡ Actividad lluviosa en curso en ${basinKey} (${result.elapsedMinutes} min). Pico: ${result.peakCoveragePct}%, Actual: ${result.coveragePct}%`);
      }
    } catch (basinErr: any) {
      console.error(`[RainMonitor] Error evaluando cuenca ${basinKey}:`, basinErr?.message || basinErr);
    }
  }
}

// GOES-16 Rain Monitoring Job: Every 10 minutes
const rainMonitoringCronJob = new CronJob(
  '*/10 * * * *',
  async () => {
    await runRainMonitoringCycle();
  },
  null,
  true,
  'America/Guayaquil'
);

// Daily Cleanup of Expired Videos (> 30 days old): Every day at 03:00 AM ECT
const dailyVideoCleanupCronJob = new CronJob(
  '00 3 * * *',
  () => {
    try {
      const deleted = rainMonitorService.cleanupOldPublishedVideos(30);
      if (deleted > 0) {
        console.log(`[CronJob] [Cleanup] Se eliminaron ${deleted} video(s) con más de 30 días de antigüedad.`);
      }
    } catch (err: any) {
      console.warn('[CronJob] [Cleanup] Error durante la limpieza diaria de videos:', err?.message || err);
    }
  },
  null,
  true,
  'America/Guayaquil'
);

// Daily 24h Satellite Timelapse Video: Every midnight at 00:00 AM ECT
const dailySatelliteTimelapseCronJob = new CronJob(
  '00 0 * * *',
  async () => {
    const isEnabled = process.env.ENABLE_RAIN_MONITOR !== 'false';
    if (!isEnabled) return;
    const autoPublish = process.env.AUTO_PUBLISH_RAIN_ALERTS !== 'false';

    try {
      console.log('[CronJob] Running 24h Daily Satellite Summary Video Generation (00:00 AM)...');
      await rainMonitorService.generateDailySummaryVideo({
        autoPublishToX: autoPublish
      });
    } catch (err: any) {
      console.error('[CronJob] Error generating 24h daily satellite summary video:', err?.message || err);
    }
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
rainMonitoringCronJob.start();
dailyVideoCleanupCronJob.start();
dailySatelliteTimelapseCronJob.start();

// Self-healing backfill on boot: retrieve all available frames in GeoServer's rolling window (~3h)
// and NASA GIBS (up to 24-hour backfill if no frames exist locally)
if (process.env.ENABLE_RAIN_MONITOR !== 'false') {
  console.log('[Startup] Executing initial satellite backfill sync (GeoServer & NASA GIBS)...');
  satelliteArchiverService
    .archiveLatestFrames({ limit: 18, plantKey: 'ecuador', source: 'geoserver' })
    .then((synced) => {
      console.log(`[Startup] GeoServer archival sync completed: ${synced.downloaded} new frame(s) downloaded (${synced.scanned} scanned, ${synced.skipped} skipped).`);
    })
    .catch((err) => {
      console.warn('[Startup] GeoServer archival sync warning:', err?.message || err);
    });

  satelliteArchiverService
    .archiveLatestFrames({ plantKey: 'ecuador', source: 'nasa_gibs' })
    .then((synced) => {
      console.log(`[Startup] NASA GIBS archival sync completed: ${synced.downloaded} new frame(s) downloaded (${synced.scanned} scanned, ${synced.skipped} skipped).`);
    })
    .catch((err) => {
      console.warn('[Startup] NASA GIBS archival sync warning:', err?.message || err);
    });
}

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

if (process.env.FORCE_RAIN_CHECK === 'true') {
  console.log('[FORCE RAIN CHECK] Triggering immediate satellite rain monitoring check in 5 seconds...');
  setTimeout(async () => {
    try {
      await runRainMonitoringCycle();
    } catch (err: any) {
      console.error('[FORCE RAIN CHECK] Forced rain monitoring check failed:', err?.message || err);
    }
  }, 5000);
}

if (process.env.FORCE_DAILY_TIMELAPSE === 'true') {
  console.log('[FORCE DAILY TIMELAPSE] Triggering 24h daily satellite summary generation in 5 seconds...');
  setTimeout(async () => {
    try {
      await rainMonitorService.generateDailySummaryVideo({
        autoPublishToX: false
      });
    } catch (err: any) {
      console.error('[FORCE DAILY TIMELAPSE] Forced daily timelapse failed:', err?.message || err);
    }
  }, 5000);
}

// ============================================================================
// TEMPORARY: Forzar publicación de prueba en Facebook e Instagram
// (Eliminar este bloque cuando se hayan verificado las publicaciones)
// ============================================================================
const FORCE_TEST_FB_IG = true;

if (FORCE_TEST_FB_IG) {
  console.log('\n[FORCE FB/IG TEST] 🚀 Activada condicional de prueba para Facebook e Instagram...');
  setTimeout(async () => {
    try {
      // 1. Reporte de Telemetría (Portada + Tarjetas de las 6 centrales)
      console.log('\n[FORCE FB/IG TEST] [1/2] 📊 Generando reporte de telemetría para Instagram (Carrusel) y Facebook (Álbum)...');
      const plantCards: Buffer[] = [];
      for (const plantKey of TARGET_PLANT_KEYS) {
        try {
          const telemetry = await fetchTelemetry(plantKey, false);
          if (telemetry) {
            const cardBuffer = await generateReportCard(plantKey, telemetry, { brand: 'instagram' });
            plantCards.push(cardBuffer);
            console.log(`[FORCE FB/IG TEST] ↳ Tarjeta generada para ${hydroelectricPlants[plantKey]?.name}`);
          }
        } catch (plantErr: any) {
          console.warn(`[FORCE FB/IG TEST] No se pudo generar tarjeta para ${plantKey}:`, plantErr?.message || plantErr);
        }
      }

      if (plantCards.length > 0) {
        console.log('[FORCE FB/IG TEST] ↳ Generando portada social en alta resolución (1200x1200px)...');
        const coverBuffer = await generateSocialCover();
        const carouselItems = [coverBuffer, ...plantCards];

        const now = new Date();
        const dateFormatted = getFormattedEcuadorDate(now);
        const ecParts = new Date(now.getTime() - 5 * 3600 * 1000);
        const hourStr = `${String(ecParts.getUTCHours()).padStart(2, '0')}:${String(ecParts.getUTCMinutes()).padStart(2, '0')} ECT`;

        const caption = buildSocialRoundupCaption({
          dateStr: dateFormatted,
          hourStr,
          plantCount: plantCards.length
        });

        // Instagram Carousel
        console.log(`[FORCE FB/IG TEST] 📸 Publicando Carrusel en Instagram (${carouselItems.length} diapositivas)...`);
        try {
          const igRes = await instagramService.postCarousel(carouselItems, caption);
          console.log(`[FORCE FB/IG TEST] ✅ Instagram Carousel publicado exitosamente! (ID: ${igRes.mediaId}, URL: ${igRes.permalink || 'N/A'})`);
        } catch (igErr: any) {
          console.error('[FORCE FB/IG TEST] ❌ Error publicando carrusel en Instagram:', igErr?.message || igErr);
        }

        // Facebook Multi-Photo Album
        console.log(`[FORCE FB/IG TEST] 📘 Publicando Álbum en Facebook (${carouselItems.length} fotos)...`);
        try {
          const fbRes = await facebookService.postPhotos(carouselItems, caption);
          console.log(`[FORCE FB/IG TEST] ✅ Facebook Álbum publicado exitosamente! (Post ID: ${fbRes.postId}, URL: ${fbRes.permalink || 'N/A'})`);
        } catch (fbErr: any) {
          console.error('[FORCE FB/IG TEST] ❌ Error publicando álbum en Facebook:', fbErr?.message || fbErr);
        }
      }

      // 2. Video Satelital 24h (Reel en Instagram y Video en Facebook)
      console.log('\n[FORCE FB/IG TEST] [2/2] 🛰️ Generando video resumen satelital de 24 horas (GeoServer por defecto, fallback a NASA GIBS si faltan fotogramas)...');
      try {
        await rainMonitorService.generateDailySummaryVideo({
          autoPublishToX: false,
          autoPublishToSocial: true
        });
        console.log('[FORCE FB/IG TEST] ✅ Video satelital 24h procesado para Facebook e Instagram.');
      } catch (satErr: any) {
        console.error('[FORCE FB/IG TEST] ❌ Error en generación/publicación satelital:', satErr?.message || satErr);
      }
    } catch (err: any) {
      console.error('[FORCE FB/IG TEST] ❌ Error general en prueba de Facebook/Instagram:', err?.message || err);
    }
  }, 3000);
}

