import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../utils/db.js';
import {
  recordForecastBatch,
  getUnresolvedForecasts,
  resolveForecastActual,
  calculateWeeklyAccuracyMetrics,
  reconcileForecastsWithCelec,
  ForecastLogRecord
} from './forecast-history.service.js';
import { CelecService } from './celec.service.js';

describe('ForecastHistoryService (SQLite Persistence & Metrics)', () => {
  const baseTime = 1788580800000; // Fixed epoch time (e.g. 2026-09-04 12:00 UTC)

  beforeEach(() => {
    // Clear test table entries for clean isolation
    db.exec('DELETE FROM forecast_logs;');
  });

  it('should record forecast batches and retrieve unresolved entries', () => {
    const records: Omit<ForecastLogRecord, 'id' | 'actualFlow' | 'resolvedAt'>[] = [
      {
        plantKey: 'cocaCodoSinclair',
        issuedAt: baseTime,
        targetTime: baseTime + 1 * 3600 * 1000,
        horizonHours: 1,
        modelName: 'multi_guarded',
        initialFlow: 350.0,
        predictedFlow: 370.0,
        p10: 340.0,
        p25: 355.0,
        p75: 385.0,
        p90: 400.0,
        maeExpected: 10.82
      },
      {
        plantKey: 'cocaCodoSinclair',
        issuedAt: baseTime,
        targetTime: baseTime + 2 * 3600 * 1000,
        horizonHours: 2,
        modelName: 'multi_guarded',
        initialFlow: 350.0,
        predictedFlow: 390.0,
        p10: 330.0,
        p25: 360.0,
        p75: 420.0,
        p90: 450.0,
        maeExpected: 26.79
      }
    ];

    recordForecastBatch(records);

    // Query unresolved when time is before targetTime -> should be empty
    const unresolvedEarly = getUnresolvedForecasts(baseTime);
    expect(unresolvedEarly.length).toBe(0);

    // Query unresolved when targetTime 1h has passed
    const unresolved1h = getUnresolvedForecasts(baseTime + 1 * 3600 * 1000);
    expect(unresolved1h.length).toBe(1);
    expect(unresolved1h[0].plantKey).toBe('cocaCodoSinclair');
    expect(unresolved1h[0].predictedFlow).toBe(370.0);
    expect(unresolved1h[0].actualFlow).toBeNull();

    // Query unresolved when targetTime 2h has passed
    const unresolved2h = getUnresolvedForecasts(baseTime + 2 * 3600 * 1000);
    expect(unresolved2h.length).toBe(2);
  });

  it('should resolve forecast actual observations and calculate accurate weekly metrics', () => {
    // 1. Insert 3 historical forecasts for Coca Codo Sinclair and 3 for Mazar
    const ccsBatch: Omit<ForecastLogRecord, 'id' | 'actualFlow' | 'resolvedAt'>[] = [
      {
        plantKey: 'cocaCodoSinclair',
        issuedAt: baseTime,
        targetTime: baseTime + 1 * 3600 * 1000,
        horizonHours: 1,
        modelName: 'multi_guarded',
        initialFlow: 300,
        predictedFlow: 320,
        p10: 300,
        p25: 310,
        p75: 330,
        p90: 340,
        maeExpected: 15.0
      },
      {
        plantKey: 'cocaCodoSinclair',
        issuedAt: baseTime,
        targetTime: baseTime + 2 * 3600 * 1000,
        horizonHours: 2,
        modelName: 'multi_guarded',
        initialFlow: 300,
        predictedFlow: 340,
        p10: 300,
        p25: 320,
        p75: 360,
        p90: 380,
        maeExpected: 25.0
      }
    ];

    const mazarBatch: Omit<ForecastLogRecord, 'id' | 'actualFlow' | 'resolvedAt'>[] = [
      {
        plantKey: 'mazar',
        issuedAt: baseTime,
        targetTime: baseTime + 1 * 3600 * 1000,
        horizonHours: 1,
        modelName: 'outlet_hybrid',
        initialFlow: 80,
        predictedFlow: 85,
        p10: 75,
        p25: 80,
        p75: 90,
        p90: 95,
        maeExpected: 5.0
      }
    ];

    recordForecastBatch(ccsBatch);
    recordForecastBatch(mazarBatch);

    const pending = getUnresolvedForecasts(baseTime + 10 * 3600 * 1000);
    expect(pending.length).toBe(3);

    const ccs1h = pending.find(p => p.plantKey === 'cocaCodoSinclair' && p.horizonHours === 1)!;
    const ccs2h = pending.find(p => p.plantKey === 'cocaCodoSinclair' && p.horizonHours === 2)!;
    const mazar1h = pending.find(p => p.plantKey === 'mazar' && p.horizonHours === 1)!;

    // CCS 1h: Actual was 325 (Predicted 320 -> error 5, within p25-p75 [310-330], dir +)
    resolveForecastActual(ccs1h.id!, 325, baseTime + 1 * 3600 * 1000 + 100);
    // CCS 2h: Actual was 350 (Predicted 340 -> error 10, within p25-p75 [320-360], dir +)
    resolveForecastActual(ccs2h.id!, 350, baseTime + 2 * 3600 * 1000 + 100);
    // Mazar 1h: Actual was 82 (Predicted 85 -> error 3, within p25-p75 [80-90], dir +)
    resolveForecastActual(mazar1h.id!, 82, baseTime + 1 * 3600 * 1000 + 100);

    // 3. Compute metrics for the window
    const metrics = calculateWeeklyAccuracyMetrics(baseTime - 1000, baseTime + 10 * 3600 * 1000);

    expect(metrics.totalForecastsResolved).toBe(3);
    // Overall MAE = (5 + 10 + 3) / 3 = 6.0
    expect(metrics.overallMae).toBe(6.0);
    // All 3 went up correctly from initialFlow
    expect(metrics.overallDirectionalAccuracy).toBe(1.0);
    // All 3 fell inside p25-p75
    expect(metrics.overallP25P75Coverage).toBe(1.0);
    expect(metrics.overallP10P90Coverage).toBe(1.0);

    // Plant-specific breakdown
    expect(metrics.plants.cocaCodoSinclair).toBeDefined();
    expect(metrics.plants.cocaCodoSinclair.totalEvaluations).toBe(2);
    expect(metrics.plants.cocaCodoSinclair.observedMae).toBe(7.5); // (5 + 10)/2
    expect(metrics.plants.cocaCodoSinclair.expectedMae).toBe(20.0); // (15 + 25)/2

    expect(metrics.plants.mazar).toBeDefined();
    expect(metrics.plants.mazar.totalEvaluations).toBe(1);
    expect(metrics.plants.mazar.observedMae).toBe(3.0);
    expect(metrics.plants.mazar.expectedMae).toBe(5.0);

    // Best performer relative to expected error
    expect(metrics.mostAccuratePlant).toBeDefined();
  });

  it('should reconcile unresolved forecasts using mocked CelecService', async () => {
    const now = new Date();
    const currentHour = now.getHours();
    const issuedAt = now.getTime() - 2 * 3600 * 1000;
    const targetTime = now.getTime() - 1 * 3600 * 1000; // 1 hour ago

    recordForecastBatch([
      {
        plantKey: 'sopladora',
        issuedAt,
        targetTime,
        horizonHours: 1,
        modelName: 'outlet_hybrid',
        initialFlow: 90,
        predictedFlow: 95,
        p10: 80,
        p25: 88,
        p75: 102,
        p90: 110,
        maeExpected: 7.17
      }
    ]);

    const targetHour = new Date(targetTime).getHours();

    const mockCelec = {
      fetchFlow: async () => [
        {
          date: new Date(targetTime).toISOString(),
          hour: targetHour,
          value: 94.5
        }
      ]
    } as unknown as CelecService;

    const result = await reconcileForecastsWithCelec(mockCelec, now.getTime());
    expect(result.resolvedCount).toBe(1);
    expect(result.pendingCount).toBe(0);

    const unresolved = getUnresolvedForecasts(now.getTime());
    expect(unresolved.length).toBe(0);

    const metrics = calculateWeeklyAccuracyMetrics(issuedAt - 1000, now.getTime());
    expect(metrics.totalForecastsResolved).toBe(1);
    expect(metrics.plants.sopladora.observedMae).toBe(0.5); // |95 - 94.5| = 0.5
  });
});
