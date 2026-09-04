export type ForecastSource = 'multivariate' | 'hydropowers' | 'geoglows' | 'none';

export interface HydroelectricPlant {
  name: string;
  isPauteComplex: boolean;

  // Physical specifications and operational limits
  physicalData?: {
    maxEnergyMW?: number;       // Installed capacity in Megawatts
    maxTurbines?: number;       // Maximum active turbines
    maxFlowM3s?: number;        // Design flow rate in m³/s
    minLevelMasl?: number;      // Minimum operational level (meters above sea level)
    maxLevelMasl?: number;      // Maximum operational level (meters above sea level)
    turbineType?: 'Pelton' | 'Francis' | 'Kaplan'; // Type of turbine used
    flowThresholds?: {
      low: number;              // Threshold below which caudal is considered 'Bajo'
      normal: number;           // Threshold below which caudal is considered 'Normal'
      high: number;             // Threshold below which caudal is considered 'Alto' (above is 'Crecida')
    };
  };

  // Specific configuration for CELEC's API endpoints
  celec?: {
    prefix: string;             // Prefix for endpoints (e.g., 'maz', 'mol')
    flowId?: string;            // mrid for inflow measurements
    levelId?: string;           // mrid for reservoir level measurements
    turbinesId?: string;        // mrid for active turbine status
  };

  // Integration settings for INAMHI's stations and telemetry
  inamhi?: {
    hydropowersKey?: string;    // Key in INAMHI's Hydropowers API (e.g., 'Amaluza')
    levelStationIds?: string[]; // INAMHI hydrological station IDs for river levels
    rainStationIds?: string[];  // INAMHI meteorological station IDs for precipitation
  };

  // Integration settings for the global GEOGLOWS model
  geoglows?: {
    comid: number;              // River reach ID in GEOGLOWS
  };

  // Which prediction model is mapped to this plant
  forecastSource: ForecastSource;

  // Visualizer and report card rendering specifications
  visualData?: {
    drawingImage?: string;
    defaultGen?: number;
    defaultTurbines?: number;
    defaultFlow?: number;
    defaultCota?: number;
    turbineGrid?: {
      rows: number;
      cols: number;
      width: number;
      height: number;
    };
  };
}

export type PredictionHorizon = '1h' | '2h' | '3h' | '4h' | '5h' | '6h' | '12h' | '24h' | '48h';

export interface MultiComidModelSpec {
  horizon: number;
  modelName: 'multi_guarded' | 'multi_comid' | 'autoregressive' | 'outlet_hybrid' | 'persistence' | 'multi_ratio_guarded' | 'multi_comid_ratio';
  n: number;
  pearsonR: number;
  mae: number;
  vsPersistence: string;
  directionAccuracy: number;
}

export interface PredictionPercentiles {
  p10: number;                      // 10th percentile (lower broad uncertainty bound)
  p25: number;                      // 25th percentile (lower high-confidence bound)
  p50: number;                      // 50th percentile (median expected forecast)
  p75: number;                      // 75th percentile (upper high-confidence bound)
  p90: number;                      // 90th percentile (upper broad uncertainty bound)
}

export interface ForecastTrajectoryPoint {
  step: number;                     // Hour step: negative for past (e.g. -6..0), positive for future (e.g. 1..6)
  label: string;                    // Time label (e.g. '-3h', 'AHORA', '+1h', '+3h')
  isHistorical: boolean;            // True if observed historical data
  observedFlow?: number;            // Actual flow measured in m³/s
  percentiles?: PredictionPercentiles; // Statistical forecast fan spread
  modelSpec?: MultiComidModelSpec;  // Exact model specification used for this hourly step
}

export interface PredictionResult {
  plantKey: string;
  plantName: string;
  forecastFlow: number;             // Predicted flow rate in m³/s (median / p50)
  percentiles?: PredictionPercentiles; // Statistical prediction percentiles
  trajectory?: ForecastTrajectoryPoint[]; // Full historical + forecast curve for fan charts
  horizon: PredictionHorizon;       // Forecast horizon
  horizonHours: number;             // Numeric hours (1, 2, 3, 4, 5, 6, 24)
  method: string;                   // Description of the model
  pearsonR?: number;                // Empirical Pearson correlation coefficient
  mae?: number;                     // Mean Absolute Error in m³/s
  isFallback: boolean;              // True if any degraded sensor fallback was used
  components: Record<string, number | null | undefined>; // Intermediate inputs/variables
  calculatedAt: Date;
  modelSpec?: MultiComidModelSpec;
}
