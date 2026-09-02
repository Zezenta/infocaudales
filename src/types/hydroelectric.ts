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

export type PredictionHorizon = '1h' | '3h' | '24h';

export interface PredictionResult {
  plantKey: string;
  plantName: string;
  forecastFlow: number;             // Predicted flow rate in m³/s
  horizon: PredictionHorizon;       // Forecast horizon
  horizonHours: number;             // Numeric hours (1, 3, 24)
  method: string;                   // Description of the model (e.g. 'Multivariate 3h (INAMHI Telemetry)')
  pearsonR?: number;                // Empirical Pearson correlation coefficient
  mae?: number;                     // Mean Absolute Error in m³/s
  isFallback: boolean;              // True if any degraded sensor fallback was used
  components: Record<string, number | null | undefined>; // Intermediate inputs/variables
  calculatedAt: Date;
}
