import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PredictionService } from './prediction.service.js';
import { InamhiService } from './inamhi.service.js';
import { GeoglowsService } from './geoglows.service.js';
import { CelecService } from './celec.service.js';

describe('PredictionService Mathematical Models & Pipielines', () => {
  let inamhiMock: InamhiService;
  let geoglowsMock: GeoglowsService;
  let celecMock: CelecService;
  let service: PredictionService;

  beforeEach(() => {
    inamhiMock = new InamhiService();
    geoglowsMock = new GeoglowsService();
    celecMock = new CelecService();
    service = new PredictionService(inamhiMock, geoglowsMock, celecMock);
  });

  describe('Coca Codo Sinclair (3h Short-Term Model)', () => {
    it('calculates exact flow using 3h multivariate regression formula', async () => {
      // Inputs:
      // Quijos (62023) = 1.5 m
      // Salado (65012) = 1.0 m
      // Sierrazul (63781, t-9) = 5.0 mm
      // Papallacta (66270, t-6) = 2.0 mm
      // Campo Alegre (63821, t-6) = 1.0 mm
      // Eq: 219.53*1.5 + 115.85*1.0 - 7.86*5.0 + 42.80*2.0 + 0.50*1.0 - 47.79
      // = 329.295 + 115.85 - 39.30 + 85.60 + 0.50 - 47.79 = 444.155

      vi.spyOn(inamhiMock, 'fetchStationLevel')
        .mockResolvedValueOnce({ value: 1.5, isFallback: false, ageHours: 0.5 })
        .mockResolvedValueOnce({ value: 1.0, isFallback: false, ageHours: 0.5 });

      vi.spyOn(inamhiMock, 'fetchStationPrecipitation')
        .mockResolvedValueOnce({ value: 5.0, isMatched: true })
        .mockResolvedValueOnce({ value: 2.0, isMatched: true })
        .mockResolvedValueOnce({ value: 1.0, isMatched: true });

      const result = await service.predictCocaCodoSinclair();

      expect(result.plantKey).toBe('cocaCodoSinclair');
      expect(result.horizon).toBe('3h');
      expect(result.horizonHours).toBe(3);
      expect(result.forecastFlow).toBeCloseTo(444.15, 1);
      expect(result.pearsonR).toBe(0.939);
      expect(result.mae).toBe(27.2);
      expect(result.isFallback).toBe(false);
      expect(result.components.quijosLevelM).toBe(1.5);
      expect(result.components.saladoLevelM).toBe(1.0);
      expect(result.components.rainSierrazulMm).toBe(5.0);
    });

    it('flags fallback if river level sensor is stale/degraded', async () => {
      vi.spyOn(inamhiMock, 'fetchStationLevel')
        .mockResolvedValueOnce({ value: 1.0, isFallback: true, ageHours: 5.2 }) // Quijos fallback baseline
        .mockResolvedValueOnce({ value: 0.8, isFallback: false, ageHours: 1.0 });

      vi.spyOn(inamhiMock, 'fetchStationPrecipitation')
        .mockResolvedValue({ value: 0.0, isMatched: false });

      const result = await service.predictCocaCodoSinclair();

      expect(result.isFallback).toBe(true);
      expect(result.forecastFlow).toBeGreaterThan(0);
    });

    it('calculates simple linear backup model correctly', () => {
      // Q_CCS = 500.06 * 1.5 - 244.52 = 505.57
      const flow = service.calculateCcsSimpleLinear(1.5);
      expect(flow).toBe(505.57);
    });
  });

  describe('Mazar Forecast Models', () => {
    it('calculates 3h multivariable model for Mazar', async () => {
      // H_Paute = 1.2 m, R_Cañar = 1.0 mm
      // Eq: 118.086 * 1.2 + 65.895 * 1.0 + 8.505
      // = 141.7032 + 65.895 + 8.505 = 216.1032 -> 216.10

      vi.spyOn(inamhiMock, 'fetchStationLevel')
        .mockResolvedValueOnce({ value: 1.2, isFallback: false, ageHours: 0.5 });

      vi.spyOn(inamhiMock, 'fetchStationPrecipitation')
        .mockResolvedValueOnce({ value: 1.0, isMatched: true });

      const result = await service.predictMazar3h();

      expect(result.plantKey).toBe('mazar');
      expect(result.horizon).toBe('3h');
      expect(result.forecastFlow).toBe(216.1);
      expect(result.pearsonR).toBe(0.8785);
      expect(result.mae).toBe(21.1);
    });

    it('calculates 24h autoregressive hybrid model for Mazar', async () => {
      // Q_CELEC(t-1) = 80.0 m3/s
      // COMID_t = 95.0 m3/s
      // WRF_Rain(t-1) = 10.0 mm
      // WRF_Rain(t-2) = 5.0 mm
      // Eq: 0.6881*80 + 0.0151*95 + 1.3737*10 + 0.0369*5 + 4.0182
      // = 55.048 + 1.4345 + 13.737 + 0.1845 + 4.0182 = 74.4222 -> 74.42

      vi.spyOn(celecMock, 'fetchFlow').mockResolvedValueOnce([
        { timestamp: '2026-06-07 01:00:00', value: 80.0 }
      ]);

      vi.spyOn(geoglowsMock, 'fetchGeoglowsForecast').mockResolvedValueOnce(95.0);
      vi.spyOn(geoglowsMock, 'fetchWrfPrecipitation')
        .mockResolvedValueOnce(10.0)
        .mockResolvedValueOnce(5.0);

      const result = await service.predictMazar24h();

      expect(result.plantKey).toBe('mazar');
      expect(result.horizon).toBe('24h');
      expect(result.forecastFlow).toBe(74.42);
      expect(result.pearsonR).toBe(0.845);
      expect(result.mae).toBe(14.12);
      expect(result.isFallback).toBe(false);
    });
  });

  describe('Hydraulic Cascade Models (Molino & Sopladora)', () => {
    it('calculates Molino cascade inflow from Mazar discharge', () => {
      // 0.95 * 100 + 5.0 = 100.0 m3/s
      const result = service.predictMolinoCascade({
        mazarDischargeFlowM3s: 100.0,
        intermediateFlowM3s: 5.0
      });

      expect(result.plantKey).toBe('molino');
      expect(result.forecastFlow).toBe(100.0);
      expect(result.horizonHours).toBe(1);
    });

    it('calculates Sopladora cascade inflow from Molino turbined flow', () => {
      // 1.0 * 85.0 = 85.0 m3/s
      const result = service.predictSopladoraCascade({
        molinoTurbinedFlowM3s: 85.0
      });

      expect(result.plantKey).toBe('sopladora');
      expect(result.forecastFlow).toBe(85.0);
      expect(result.horizonHours).toBe(1);
    });
  });

  describe('InamhiService Utility Methods', () => {
    it('parses various INAMHI Visor datetime formats correctly', () => {
      const dt1 = inamhiMock.parseVisorDatetime('2026-06-07T12:00:00.000Z');
      expect(dt1?.toISOString()).toBe('2026-06-07T12:00:00.000Z');

      const dt2 = inamhiMock.parseVisorDatetime('2026-06-07 15:30:00');
      expect(dt2?.getUTCHours()).toBe(15);
      expect(dt2?.getUTCMinutes()).toBe(30);

      const dt3 = inamhiMock.parseVisorDatetime('2026-06-07T10:00:00-05:00');
      expect(dt3?.getUTCHours()).toBe(15);
    });
  });

  describe('Statistical Percentiles & Fan Chart Trajectory', () => {
    it('computes correct p10, p25, p50, p75, p90 percentiles given point forecast and MAE', () => {
      // Mean = 500, MAE = 20 -> sigma = 1.2533 * 20 = 25.066
      // p50 = 500
      // p25 = 500 - 0.674 * 25.066 = 500 - 16.894 = 483.11
      // p75 = 500 + 16.894 = 516.89
      // p10 = 500 - 1.282 * 25.066 = 500 - 32.134 = 467.87
      // p90 = 500 + 32.134 = 532.13
      const p = service.calculatePredictionPercentiles(500, 20);

      expect(p.p50).toBe(500);
      expect(p.p25).toBeCloseTo(483.11, 1);
      expect(p.p75).toBeCloseTo(516.89, 1);
      expect(p.p10).toBeCloseTo(467.87, 1);
      expect(p.p90).toBeCloseTo(532.13, 1);
    });

    it('builds fan chart trajectory with historical points and future expanding uncertainty cone', () => {
      const fixedDate = new Date('2026-09-04T14:00:00');
      const trajectory = service.buildForecastTrajectory({
        currentFlow: 450,
        forecastFlow: 600,
        horizonHours: 3,
        mae: 27.2,
        baseDate: fixedDate
      });

      expect(trajectory.length).toBe(7); // 3 past (-6h, -4h, -2h) + 1 current (0 / 14:00) + 3 future (15:00, 16:00, 17:00)
      
      const pastPoint = trajectory.find(t => t.step === -6);
      expect(pastPoint?.label).toBe('08:00');

      const nowPoint = trajectory.find(t => t.step === 0);
      expect(nowPoint?.label).toBe('14:00');
      expect(nowPoint?.observedFlow).toBe(450);

      const finalPoint = trajectory.find(t => t.step === 3);
      expect(finalPoint?.label).toBe('17:00');
      expect(finalPoint?.percentiles?.p50).toBe(600);
      expect(finalPoint?.percentiles?.p75).toBeGreaterThan(600);
      expect(finalPoint?.percentiles?.p25).toBeLessThan(600);
    });

    it('evaluates multi-COMID hourly models across 1h to 6h horizons for all plants', async () => {
      // Test CCS at 1h (multi_guarded, MAE=10.82, r=0.997)
      const resCcs1h = await service.predictPlantHourlyMultiComid('cocaCodoSinclair', {
        horizonHours: 1,
        currentFlow: 400
      });
      expect(resCcs1h.plantKey).toBe('cocaCodoSinclair');
      expect(resCcs1h.horizonHours).toBe(1);
      expect(resCcs1h.mae).toBe(10.82);
      expect(resCcs1h.pearsonR).toBe(0.997);
      expect(resCcs1h.modelSpec?.modelName).toBe('multi_guarded');
      expect(resCcs1h.trajectory?.length).toBe(5); // 3 past + now + 1 future

      // Test Mazar at 6h (outlet_hybrid, MAE=9.09, r=0.518)
      const resMazar6h = await service.predictPlantHourlyMultiComid('mazar', {
        horizonHours: 6,
        currentFlow: 85
      });
      expect(resMazar6h.plantKey).toBe('mazar');
      expect(resMazar6h.horizonHours).toBe(6);
      expect(resMazar6h.mae).toBe(9.09);
      expect(resMazar6h.pearsonR).toBe(0.518);
      expect(resMazar6h.modelSpec?.modelName).toBe('outlet_hybrid');
      expect(resMazar6h.trajectory?.length).toBe(10); // 3 past + now + 6 future

      // Test Sopladora at 6h (autoregressive, MAE=12.58, r=0.830)
      const resSopladora6h = await service.predictPlantHourlyMultiComid('sopladora', {
        horizonHours: 6,
        currentFlow: 95
      });
      expect(resSopladora6h.plantKey).toBe('sopladora');
      expect(resSopladora6h.modelSpec?.modelName).toBe('autoregressive');
      expect(resSopladora6h.mae).toBe(12.58);
      expect(resSopladora6h.pearsonR).toBe(0.830);
    });
  });
});
