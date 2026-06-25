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
}
