import { HydroelectricPlant } from '../types/hydroelectric.js';

export const hydroelectricPlants: Record<string, HydroelectricPlant> = {
  mazar: {
    name: 'Mazar',
    isPauteComplex: true,
    forecastSource: 'multivariate',
    physicalData: {
      maxEnergyMW: 170,
      maxTurbines: 2,
      maxFlowM3s: 150,
      minLevelMasl: 2098,
      maxLevelMasl: 2153,
      turbineType: 'Francis',
    },
    celec: {
      prefix: 'maz',
      flowId: '30538',
      levelId: '30031',
      turbinesId: '30503',
    },
    inamhi: {
      levelStationIds: ['62179'],
      rainStationIds: ['23', '7'],
    },
    geoglows: {
      comid: 620967750,
    },
  },

  molino: {
    name: 'Molino',
    isPauteComplex: true,
    forecastSource: 'hydropowers',
    physicalData: {
      maxEnergyMW: 1100,
      maxTurbines: 10,
      maxFlowM3s: 150,
      minLevelMasl: 1975,
      maxLevelMasl: 1991,
      turbineType: 'Pelton',
    },
    celec: {
      prefix: 'mol',
      flowId: '24811',
      levelId: '24019',
      turbinesId: '44822',
    },
    inamhi: {
      hydropowersKey: 'Amaluza',
    },
    geoglows: {
      comid: 620976006,
    },
  },

  sopladora: {
    name: 'Sopladora',
    isPauteComplex: true,
    forecastSource: 'geoglows',
    physicalData: {
      maxEnergyMW: 487,
      maxTurbines: 3,
      maxFlowM3s: 100,
      turbineType: 'Francis',
    },
    celec: {
      prefix: 'sop',
      flowId: '90537',
      levelId: '90919',
      turbinesId: '90503',
    },
    geoglows: {
      comid: 620976003,
    },
  },

  minasSanFrancisco: {
    name: 'Minas San Francisco',
    isPauteComplex: false,
    forecastSource: 'geoglows',
    physicalData: {
      maxEnergyMW: 270,
      maxTurbines: 3,
      maxFlowM3s: 80,
      minLevelMasl: 783,
      maxLevelMasl: 792,
      turbineType: 'Pelton',
    },
    celec: {
      prefix: 'msf',
      flowId: '650538',
      levelId: '650919',
      turbinesId: '650503',
    },
    geoglows: {
      comid: 670022995,
    },
  },

  cocaCodoSinclair: {
    name: 'Coca Codo Sinclair',
    isPauteComplex: false,
    forecastSource: 'multivariate',
    physicalData: {
      maxEnergyMW: 1500,
      maxTurbines: 8,
      maxFlowM3s: 3000,
      turbineType: 'Pelton',
    },
    celec: {
      prefix: 'ccs',
      flowId: '100037',
      levelId: '100540',
      turbinesId: '100503',
    },
    inamhi: {
      levelStationIds: ['62023', '65012'],
      rainStationIds: ['63781', '66270', '63821'],
    },
    geoglows: {
      comid: 620922213,
    },
  },

  agoyan: {
    name: 'Agoyán',
    isPauteComplex: false,
    forecastSource: 'hydropowers',
    physicalData: {
      maxEnergyMW: 120,
      maxFlowM3s: 120,
      turbineType: 'Francis',
    },
    celec: {
      prefix: 'ago',
      flowId: '140537',
      levelId: '140031',
      turbinesId: '140503',
    },
    inamhi: {
      hydropowersKey: 'Agoyán',
    },
  },

  manduriacu: {
    name: 'Manduriacu',
    isPauteComplex: false,
    forecastSource: 'none',
    physicalData: {
      maxEnergyMW: 65,
      maxTurbines: 2,
      maxFlowM3s: 210,
      minLevelMasl: 489.4,
      maxLevelMasl: 492.7,
      turbineType: 'Kaplan',
    },
    celec: {
      prefix: 'man',
      flowId: '110537',
      levelId: '110031',
      turbinesId: '110503',
    },
  },

  celecSur: {
    name: 'CELEC EP SUR',
    isPauteComplex: false,
    forecastSource: 'none',
    celec: {
      prefix: 'csr',
      flowId: '24812',
    },
  },
};
