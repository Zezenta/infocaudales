import { db } from '../utils/db.js';
import { CelecService, CelecPointValue } from './celec.service.js';
import { hydroelectricPlants } from '../data/hydroelectric-plants.js';
import { predictionLogger } from '../utils/logger.js';

export interface ForecastLogRecord {
  id?: number;
  plantKey: string;
  issuedAt: number;      // Unix timestamp ms (T0)
  targetTime: number;    // Unix timestamp ms (T0 + h hours)
  horizonHours: number;  // 1 to 6
  modelName: string;
  initialFlow: number;   // Flow at T0
  predictedFlow: number; // p50 estimate
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  maeExpected: number;
  actualFlow?: number | null;
  resolvedAt?: number | null;
}

export interface WeeklyHorizonMetrics {
  count: number;
  observedMae: number;
  directionalAccuracy: number;
}

export interface WeeklyPlantAccuracyMetrics {
  plantKey: string;
  plantName: string;
  totalEvaluations: number;
  observedMae: number;
  expectedMae: number;
  directionalAccuracy: number; // 0.0 to 1.0 (fraction)
  withinP25P75: number;        // 0.0 to 1.0
  withinP10P90: number;        // 0.0 to 1.0
  avgBias: number;             // predicted - actual
  horizons: Record<number, WeeklyHorizonMetrics>;
}

export interface WeeklyAccuracyReportSummary {
  periodStart: number;
  periodEnd: number;
  totalForecastsResolved: number;
  overallMae: number;
  overallDirectionalAccuracy: number;
  overallP25P75Coverage: number;
  overallP10P90Coverage: number;
  plants: Record<string, WeeklyPlantAccuracyMetrics>;
  mostAccuratePlant: string | null;
  leastAccuratePlant: string | null;
}

/**
 * Persists a batch of step predictions (e.g. +1h to +6h) for a given plant into SQLite.
 */
export function recordForecastBatch(records: Omit<ForecastLogRecord, 'id' | 'actualFlow' | 'resolvedAt'>[]): void {
  if (!records || records.length === 0) return;

  const insertStmt = db.prepare(`
    INSERT INTO forecast_logs (
      plant_key, issued_at, target_time, horizon_hours, model_name,
      initial_flow, predicted_flow, p10, p25, p75, p90, mae_expected
    ) VALUES (
      @plantKey, @issuedAt, @targetTime, @horizonHours, @modelName,
      @initialFlow, @predictedFlow, @p10, @p25, @p75, @p90, @maeExpected
    )
  `);

  const insertMany = db.transaction((rows: typeof records) => {
    for (const row of rows) {
      insertStmt.run(row);
    }
  });

  insertMany(records);
  predictionLogger.info(`[ForecastHistory] Recorded ${records.length} forecast steps for ${records[0].plantKey} issued at ${new Date(records[0].issuedAt).toISOString()}`);
}

/**
 * Returns unresolved forecast rows whose target time has already passed.
 */
export function getUnresolvedForecasts(upToTimeMs: number = Date.now()): ForecastLogRecord[] {
  const rows = db.prepare(`
    SELECT 
      id,
      plant_key as plantKey,
      issued_at as issuedAt,
      target_time as targetTime,
      horizon_hours as horizonHours,
      model_name as modelName,
      initial_flow as initialFlow,
      predicted_flow as predictedFlow,
      p10, p25, p75, p90,
      mae_expected as maeExpected,
      actual_flow as actualFlow,
      resolved_at as resolvedAt
    FROM forecast_logs
    WHERE actual_flow IS NULL AND target_time <= ?
    ORDER BY target_time ASC
  `).all(upToTimeMs) as ForecastLogRecord[];

  return rows;
}

/**
 * Updates a single forecast entry with its observed ground truth flow.
 */
export function resolveForecastActual(id: number, actualFlow: number, resolvedAtMs: number = Date.now()): void {
  db.prepare(`
    UPDATE forecast_logs
    SET actual_flow = ?, resolved_at = ?
    WHERE id = ?
  `).run(actualFlow, resolvedAtMs, id);
}

/**
 * Reconciles unresolved forecasts with CELEC telemetry by matching target hours.
 */
export async function reconcileForecastsWithCelec(
  celecService: CelecService = new CelecService(),
  upToTimeMs: number = Date.now()
): Promise<{ resolvedCount: number; pendingCount: number }> {
  const unresolved = getUnresolvedForecasts(upToTimeMs);
  if (unresolved.length === 0) {
    return { resolvedCount: 0, pendingCount: 0 };
  }

  predictionLogger.info(`[ForecastHistory] Found ${unresolved.length} unresolved forecast steps to reconcile.`);
  let resolvedCount = 0;

  // Group by plantKey and target Date (YYYY-MM-DD) to minimize CELEC HTTP requests
  const grouped = new Map<string, ForecastLogRecord[]>();
  for (const item of unresolved) {
    const key = `${item.plantKey}_${new Date(item.targetTime).toISOString().slice(0, 10)}`;
    const list = grouped.get(key) || [];
    list.push(item);
    grouped.set(key, list);
  }

  for (const [groupKey, items] of grouped.entries()) {
    const plantKey = items[0].plantKey;
    const plant = hydroelectricPlants[plantKey];
    if (!plant) continue;

    const sampleDate = new Date(items[0].targetTime);
    try {
      const flowPoints = await celecService.fetchFlow(plant, sampleDate);
      if (!flowPoints || flowPoints.length === 0) continue;

      for (const item of items) {
        if (!item.id) continue;
        const targetDate = new Date(item.targetTime);
        let closestPoint: CelecPointValue | undefined = undefined;
        let minDiff = Infinity;
        for (const p of flowPoints) {
          const rawTime = p.timestamp || (p as any).date;
          if (!rawTime) continue;
          const pTime = new Date(rawTime).getTime();
          if (isNaN(pTime)) continue;
          const diff = Math.abs(pTime - item.targetTime);
          if (diff < minDiff && diff <= 90 * 60 * 1000) {
            minDiff = diff;
            closestPoint = p;
          }
        }

        if (closestPoint && closestPoint.value !== null && closestPoint.value !== undefined) {
          resolveForecastActual(item.id, closestPoint.value, Date.now());
          resolvedCount++;
        }
      }
    } catch (err: any) {
      predictionLogger.warn(`[ForecastHistory] Error fetching telemetry to reconcile ${groupKey}: ${err?.message || err}`);
    }
  }

  const remaining = getUnresolvedForecasts(upToTimeMs).length;
  predictionLogger.info(`[ForecastHistory] Reconciled ${resolvedCount} forecasts. ${remaining} still pending.`);
  return { resolvedCount, pendingCount: remaining };
}

/**
 * Calculates accuracy metrics (MAE, directional accuracy, confidence interval coverage)
 * over a specified time window (defaulting to the past 7 days) for the weekly report.
 */
export function calculateWeeklyAccuracyMetrics(
  sinceMs: number = Date.now() - 7 * 24 * 3600 * 1000,
  untilMs: number = Date.now()
): WeeklyAccuracyReportSummary {
  const rows = db.prepare(`
    SELECT 
      id,
      plant_key as plantKey,
      issued_at as issuedAt,
      target_time as targetTime,
      horizon_hours as horizonHours,
      model_name as modelName,
      initial_flow as initialFlow,
      predicted_flow as predictedFlow,
      p10, p25, p75, p90,
      mae_expected as maeExpected,
      actual_flow as actualFlow,
      resolved_at as resolvedAt
    FROM forecast_logs
    WHERE actual_flow IS NOT NULL 
      AND issued_at >= ? 
      AND issued_at <= ?
    ORDER BY plant_key ASC, target_time ASC
  `).all(sinceMs, untilMs) as (ForecastLogRecord & { actualFlow: number })[];

  if (rows.length === 0) {
    return {
      periodStart: sinceMs,
      periodEnd: untilMs,
      totalForecastsResolved: 0,
      overallMae: 0,
      overallDirectionalAccuracy: 0,
      overallP25P75Coverage: 0,
      overallP10P90Coverage: 0,
      plants: {},
      mostAccuratePlant: null,
      leastAccuratePlant: null
    };
  }

  let totalAbsError = 0;
  let totalDirCorrect = 0;
  let totalP25P75Covered = 0;
  let totalP10P90Covered = 0;

  const plantStats: Record<string, {
    plantKey: string;
    records: typeof rows;
  }> = {};

  for (const row of rows) {
    if (!plantStats[row.plantKey]) {
      plantStats[row.plantKey] = { plantKey: row.plantKey, records: [] };
    }
    plantStats[row.plantKey].records.push(row);

    const absError = Math.abs(row.actualFlow - row.predictedFlow);
    totalAbsError += absError;

    // Directional Accuracy: Did flow go up/down as predicted relative to T0?
    const predictedDelta = row.predictedFlow - row.initialFlow;
    const actualDelta = row.actualFlow - row.initialFlow;
    const isDirCorrect = (predictedDelta >= 0 && actualDelta >= 0) || (predictedDelta <= 0 && actualDelta <= 0);
    if (isDirCorrect) totalDirCorrect++;

    // Percentile Coverage
    if (row.actualFlow >= row.p25 && row.actualFlow <= row.p75) totalP25P75Covered++;
    if (row.actualFlow >= row.p10 && row.actualFlow <= row.p90) totalP10P90Covered++;
  }

  const plantMetrics: Record<string, WeeklyPlantAccuracyMetrics> = {};
  let bestScore = Infinity;
  let worstScore = -Infinity;
  let mostAccuratePlant: string | null = null;
  let leastAccuratePlant: string | null = null;

  for (const [key, group] of Object.entries(plantStats)) {
    const count = group.records.length;
    let plantAbsErr = 0;
    let plantExpMaeSum = 0;
    let plantDirCorr = 0;
    let plantP25P75 = 0;
    let plantP10P90 = 0;
    let plantBiasSum = 0;

    const horizonMap: Record<number, { count: number; absErr: number; dirCorr: number }> = {};

    for (const r of group.records) {
      const err = Math.abs(r.actualFlow - r.predictedFlow);
      plantAbsErr += err;
      plantExpMaeSum += r.maeExpected;
      plantBiasSum += (r.predictedFlow - r.actualFlow);

      const predD = r.predictedFlow - r.initialFlow;
      const actD = r.actualFlow - r.initialFlow;
      const dirOk = (predD >= 0 && actD >= 0) || (predD <= 0 && actD <= 0);
      if (dirOk) plantDirCorr++;

      if (r.actualFlow >= r.p25 && r.actualFlow <= r.p75) plantP25P75++;
      if (r.actualFlow >= r.p10 && r.actualFlow <= r.p90) plantP10P90++;

      const h = r.horizonHours;
      if (!horizonMap[h]) horizonMap[h] = { count: 0, absErr: 0, dirCorr: 0 };
      horizonMap[h].count++;
      horizonMap[h].absErr += err;
      if (dirOk) horizonMap[h].dirCorr++;
    }

    const obsMae = plantAbsErr / count;
    const expMae = plantExpMaeSum / count;
    const dirAcc = plantDirCorr / count;

    const horizonsResult: Record<number, WeeklyHorizonMetrics> = {};
    for (const [hStr, hData] of Object.entries(horizonMap)) {
      const h = parseInt(hStr, 10);
      horizonsResult[h] = {
        count: hData.count,
        observedMae: parseFloat((hData.absErr / hData.count).toFixed(2)),
        directionalAccuracy: parseFloat((hData.dirCorr / hData.count).toFixed(2))
      };
    }

    const plantName = hydroelectricPlants[key]?.name || key;
    plantMetrics[key] = {
      plantKey: key,
      plantName,
      totalEvaluations: count,
      observedMae: parseFloat(obsMae.toFixed(2)),
      expectedMae: parseFloat(expMae.toFixed(2)),
      directionalAccuracy: parseFloat(dirAcc.toFixed(3)),
      withinP25P75: parseFloat((plantP25P75 / count).toFixed(3)),
      withinP10P90: parseFloat((plantP10P90 / count).toFixed(3)),
      avgBias: parseFloat((plantBiasSum / count).toFixed(2)),
      horizons: horizonsResult
    };

    // Rank most and least accurate by ratio of observed MAE relative to baseline MAE expected
    const score = obsMae / Math.max(1, expMae);
    if (score < bestScore) {
      bestScore = score;
      mostAccuratePlant = key;
    }
    if (score > worstScore) {
      worstScore = score;
      leastAccuratePlant = key;
    }
  }

  return {
    periodStart: sinceMs,
    periodEnd: untilMs,
    totalForecastsResolved: rows.length,
    overallMae: parseFloat((totalAbsError / rows.length).toFixed(2)),
    overallDirectionalAccuracy: parseFloat((totalDirCorrect / rows.length).toFixed(3)),
    overallP25P75Coverage: parseFloat((totalP25P75Covered / rows.length).toFixed(3)),
    overallP10P90Coverage: parseFloat((totalP10P90Covered / rows.length).toFixed(3)),
    plants: plantMetrics,
    mostAccuratePlant,
    leastAccuratePlant
  };
}
