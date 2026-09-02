import { InamhiService } from './inamhi.service.js';
import { GeoglowsService } from './geoglows.service.js';
import { CelecService } from './celec.service.js';
import { hydroelectricPlants } from '../data/hydroelectric-plants.js';
import { PredictionResult, PredictionHorizon } from '../types/hydroelectric.js';
import { predictionLogger } from '../utils/logger.js';

export class PredictionService {
  constructor(
    private readonly inamhiService: InamhiService = new InamhiService(),
    private readonly geoglowsService: GeoglowsService = new GeoglowsService(),
    private readonly celecService: CelecService = new CelecService()
  ) {}

  /**
   * Evaluates Coca Codo Sinclair (CCS) flow forecast for a 3-hour future horizon.
   * Model: Multivariate Linear Regression on Quijos/Salado levels & lagged precipitation.
   * Eq: Q_CCS(t+3) = 219.53*H_Quijos + 115.85*H_Salado - 7.86*R_Sierrazul(t-9) + 42.80*R_Papallacta(t-6) + 0.50*R_CampoAlegre(t-6) - 47.79
   */
  public async predictCocaCodoSinclair(options: { targetDate?: Date } = {}): Promise<PredictionResult> {
    const targetDate = options.targetDate ?? new Date();
    const tMinus9 = new Date(targetDate.getTime() - 9 * 3600 * 1000);
    const tMinus6 = new Date(targetDate.getTime() - 6 * 3600 * 1000);

    predictionLogger.info('Calculating Coca Codo Sinclair 3h forecast...');

    // 1. Fetch river levels (with age verification and fallback baselines)
    const quijosLevel = await this.inamhiService.fetchStationLevel(62023, 'H0719 - Río Quijos', {
      fallback: 1.0,
      targetDate
    });
    const saladoLevel = await this.inamhiService.fetchStationLevel(65012, 'H0728 - Río Salado', {
      fallback: 0.8,
      targetDate
    });

    // 2. Fetch lagged precipitation
    const rainSierrazul = await this.inamhiService.fetchStationPrecipitation(63781, 'M1124 - Sierrazul (t-9)', tMinus9);
    const rainPapallacta = await this.inamhiService.fetchStationPrecipitation(66270, 'M5247 - Papallacta (t-6)', tMinus6);
    const rainCampoAlegre = await this.inamhiService.fetchStationPrecipitation(63821, 'M5124 - Campo Alegre (t-6)', tMinus6);

    const isDegraded = quijosLevel.isFallback || saladoLevel.isFallback;

    // 3. Compute Multivariate Equation
    const calculatedFlow =
      219.53 * quijosLevel.value +
      115.85 * saladoLevel.value -
      7.86 * rainSierrazul.value +
      42.80 * rainPapallacta.value +
      0.50 * rainCampoAlegre.value -
      47.79;

    const forecastFlow = Math.max(0, parseFloat(calculatedFlow.toFixed(2)));

    predictionLogger.info(`Predicted CCS 3h Flow: ${forecastFlow} m³/s (Degraded: ${isDegraded})`);

    return {
      plantKey: 'cocaCodoSinclair',
      plantName: 'Coca Codo Sinclair',
      forecastFlow,
      horizon: '3h',
      horizonHours: 3,
      method: 'Multivariate Linear Regression (Quijos/Salado + Lagged Rain)',
      pearsonR: 0.939,
      mae: 27.2,
      isFallback: isDegraded,
      components: {
        quijosLevelM: quijosLevel.value,
        saladoLevelM: saladoLevel.value,
        rainSierrazulMm: rainSierrazul.value,
        rainPapallactaMm: rainPapallacta.value,
        rainCampoAlegreMm: rainCampoAlegre.value
      },
      calculatedAt: targetDate
    };
  }

  /**
   * Backup simple linear model for Coca Codo Sinclair based exclusively on Río Quijos (H0719).
   * Eq: Q_CCS(t+3) = 500.06 * H_Quijos - 244.52
   */
  public calculateCcsSimpleLinear(quijosLevelM: number): number {
    const q = 500.06 * quijosLevelM - 244.52;
    return Math.max(0, parseFloat(q.toFixed(2)));
  }

  /**
   * Evaluates Mazar short-term 3-hour future flow forecast.
   * Eq: Q_Mazar(t+3) = 118.086 * H_Paute + 65.895 * R_Cañar + 8.505
   */
  public async predictMazar3h(options: { targetDate?: Date } = {}): Promise<PredictionResult> {
    const targetDate = options.targetDate ?? new Date();

    predictionLogger.info('Calculating Mazar 3h forecast...');

    const pauteLevel = await this.inamhiService.fetchStationLevel(62179, 'H0894 - Río Paute', {
      fallback: 1.2,
      targetDate
    });
    const canarRain = await this.inamhiService.fetchStationPrecipitation(23, 'M0031 - Cañar', targetDate);

    const calculatedFlow = 118.086 * pauteLevel.value + 65.895 * canarRain.value + 8.505;
    const forecastFlow = Math.max(0, parseFloat(calculatedFlow.toFixed(2)));

    return {
      plantKey: 'mazar',
      plantName: 'Mazar',
      forecastFlow,
      horizon: '3h',
      horizonHours: 3,
      method: 'Multivariable 3h (Paute Level + Cañar Rain)',
      pearsonR: 0.8785,
      mae: 21.1,
      isFallback: pauteLevel.isFallback,
      components: {
        pauteLevelM: pauteLevel.value,
        canarRainMm: canarRain.value
      },
      calculatedAt: targetDate
    };
  }

  /**
   * Evaluates Mazar 24-hour daily hybrid autoregressive forecast.
   * Eq: Q_Mazar(t) = 0.6881 * Q_CELEC(t-1) + 0.0151 * COMID_t + 1.3737 * Rain_WRF(t-1) + 0.0369 * Rain_WRF(t-2) + 4.0182
   */
  public async predictMazar24h(options: { targetDate?: Date } = {}): Promise<PredictionResult> {
    const targetDate = options.targetDate ?? new Date();
    const yesterday = new Date(targetDate.getTime() - 24 * 3600 * 1000);
    const dayBefore = new Date(targetDate.getTime() - 48 * 3600 * 1000);

    predictionLogger.info('Calculating Mazar 24h hybrid autoregressive forecast...');

    // 1. Q(t-1) from CELEC
    const mazarPlant = hydroelectricPlants.mazar;
    let celecYesterdayFlow = 85.0; // historical baseline fallback
    let celecFallback = true;

    if (mazarPlant?.celec?.flowId) {
      try {
        const flowPoints = await this.celecService.fetchFlow(mazarPlant, yesterday);
        const validValues = flowPoints
          .map(p => p.value)
          .filter((v): v is number => v !== null && !isNaN(v));

        if (validValues.length > 0) {
          celecYesterdayFlow = validValues.reduce((a, b) => a + b, 0) / validValues.length;
          celecFallback = false;
        }
      } catch (err: any) {
        predictionLogger.warn(`Could not fetch CELEC yesterday flow for Mazar: ${err?.message}`);
      }
    }

    // 2. COMID(t) from GEOGLOWS (COMID 620967750)
    const comid = mazarPlant?.geoglows?.comid ?? 620967750;
    const geoglowsFlow = (await this.geoglowsService.fetchGeoglowsForecast(comid, targetDate)) ?? celecYesterdayFlow;

    // 3. WRF Precipitation (Grid: X=389, Y=660)
    const rainWrfT1 = await this.geoglowsService.fetchWrfPrecipitation(389, 660, yesterday);
    const rainWrfT2 = await this.geoglowsService.fetchWrfPrecipitation(389, 660, dayBefore);

    const calculatedFlow =
      0.6881 * celecYesterdayFlow +
      0.0151 * geoglowsFlow +
      1.3737 * rainWrfT1 +
      0.0369 * rainWrfT2 +
      4.0182;

    const forecastFlow = Math.max(0, parseFloat(calculatedFlow.toFixed(2)));

    return {
      plantKey: 'mazar',
      plantName: 'Mazar',
      forecastFlow,
      horizon: '24h',
      horizonHours: 24,
      method: 'Autoregressive Hybrid Model (CELEC Q(t-1) + GEOGLOWS + WRF Rain)',
      pearsonR: 0.845,
      mae: 14.12,
      isFallback: celecFallback,
      components: {
        celecYesterdayFlowM3s: celecYesterdayFlow,
        geoglowsFlowM3s: geoglowsFlow,
        rainWrfT1Mm: rainWrfT1,
        rainWrfT2Mm: rainWrfT2
      },
      calculatedAt: targetDate
    };
  }

  /**
   * Hydraulic cascade model for Molino (Amaluza) for 1h-2h horizon.
   * Eq: Q_Molino(t+1h) = 0.95 * Q_descarga,Mazar(t) + Q_intermedia
   */
  public predictMolinoCascade(options: { mazarDischargeFlowM3s: number; intermediateFlowM3s?: number }): PredictionResult {
    const intermediate = options.intermediateFlowM3s ?? 5.0;
    const calculatedFlow = 0.95 * options.mazarDischargeFlowM3s + intermediate;
    const forecastFlow = Math.max(0, parseFloat(calculatedFlow.toFixed(2)));

    return {
      plantKey: 'molino',
      plantName: 'Molino',
      forecastFlow,
      horizon: '1h',
      horizonHours: 1,
      method: 'Hydraulic Cascade Balance (Mazar Discharge + Intermediate Basin)',
      components: {
        mazarDischargeFlowM3s: options.mazarDischargeFlowM3s,
        intermediateFlowM3s: intermediate
      },
      isFallback: false,
      calculatedAt: new Date()
    };
  }

  /**
   * Hydraulic cascade model for Sopladora for 1h horizon.
   * Eq: Q_Sopladora(t+1h) = 1.00 * Q_turbinado,Molino(t)
   */
  public predictSopladoraCascade(options: { molinoTurbinedFlowM3s: number }): PredictionResult {
    const calculatedFlow = 1.0 * options.molinoTurbinedFlowM3s;
    const forecastFlow = Math.max(0, parseFloat(calculatedFlow.toFixed(2)));

    return {
      plantKey: 'sopladora',
      plantName: 'Sopladora',
      forecastFlow,
      horizon: '1h',
      horizonHours: 1,
      method: 'Direct Tunnel Conveyance Cascade (Molino Turbined Flow)',
      components: {
        molinoTurbinedFlowM3s: options.molinoTurbinedFlowM3s
      },
      isFallback: false,
      calculatedAt: new Date()
    };
  }

  /**
   * High-level prediction dispatcher that executes the scientifically optimal model
   * for each plant based on the Decision Matrix in PREDICTIONS.md.
   */
  public async predictPlantFlow(
    plantKey: string,
    options: { horizon?: PredictionHorizon; targetDate?: Date } = {}
  ): Promise<PredictionResult> {
    const plant = hydroelectricPlants[plantKey];
    if (!plant) {
      throw new Error(`Unknown hydroelectric plant key: ${plantKey}`);
    }

    const targetDate = options.targetDate ?? new Date();
    const horizon = options.horizon ?? (plantKey === 'cocaCodoSinclair' ? '3h' : '24h');

    switch (plantKey) {
      case 'cocaCodoSinclair':
        return this.predictCocaCodoSinclair({ targetDate });

      case 'mazar':
        if (horizon === '3h') {
          return this.predictMazar3h({ targetDate });
        }
        return this.predictMazar24h({ targetDate });

      case 'molino':
        if (plant.geoglows?.comid) {
          const comidFlow = await this.geoglowsService.fetchGeoglowsForecast(plant.geoglows.comid, targetDate);
          return {
            plantKey: 'molino',
            plantName: 'Molino',
            forecastFlow: comidFlow ?? (plant.physicalData?.flowThresholds?.normal ?? 120),
            horizon: '24h',
            horizonHours: 24,
            method: 'Calibrated Hydropowers / GEOGLOWS (COMID 620976006)',
            pearsonR: 0.723,
            mae: 37.6,
            isFallback: comidFlow === null,
            components: { comidFlowM3s: comidFlow },
            calculatedAt: targetDate
          };
        }
        break;

      case 'sopladora':
        if (plant.geoglows?.comid) {
          const comidFlow = await this.geoglowsService.fetchGeoglowsForecast(plant.geoglows.comid, targetDate);
          return {
            plantKey: 'sopladora',
            plantName: 'Sopladora',
            forecastFlow: comidFlow ?? (plant.physicalData?.flowThresholds?.normal ?? 100),
            horizon: '24h',
            horizonHours: 24,
            method: 'GEOGLOWS Stream Reach (COMID 620976003)',
            pearsonR: 0.342,
            isFallback: comidFlow === null,
            components: { comidFlowM3s: comidFlow },
            calculatedAt: targetDate
          };
        }
        break;

      case 'agoyan':
        if (plant.geoglows?.comid) {
          const comidFlow = await this.geoglowsService.fetchGeoglowsForecast(plant.geoglows.comid, targetDate);
          return {
            plantKey: 'agoyan',
            plantName: 'Agoyán',
            forecastFlow: comidFlow ?? (plant.physicalData?.flowThresholds?.normal ?? 110),
            horizon: '24h',
            horizonHours: 24,
            method: 'Calibrated Hydropowers / GEOGLOWS (Pastaza)',
            pearsonR: 0.407,
            isFallback: comidFlow === null,
            components: { comidFlowM3s: comidFlow },
            calculatedAt: targetDate
          };
        }
        break;

      case 'minasSanFrancisco':
        if (plant.geoglows?.comid) {
          const comidFlow = await this.geoglowsService.fetchGeoglowsForecast(plant.geoglows.comid, targetDate);
          return {
            plantKey: 'minasSanFrancisco',
            plantName: 'Minas San Francisco',
            forecastFlow: comidFlow ?? (plant.physicalData?.flowThresholds?.normal ?? 45),
            horizon: '24h',
            horizonHours: 24,
            method: 'GEOGLOWS Stream Reach (COMID 670022995)',
            pearsonR: 0.414,
            isFallback: comidFlow === null,
            components: { comidFlowM3s: comidFlow },
            calculatedAt: targetDate
          };
        }
        break;
    }

    // Default generic fallback
    return {
      plantKey,
      plantName: plant.name,
      forecastFlow: plant.physicalData?.flowThresholds?.normal ?? 50,
      horizon: '24h',
      horizonHours: 24,
      method: 'Historical Baseline Fallback',
      isFallback: true,
      components: {},
      calculatedAt: targetDate
    };
  }
}
