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
    visualData: {
      drawingImage: '/hydroelectric-drawings/Mazar.png',
      defaultGen: 136,
      defaultTurbines: 2,
      defaultFlow: 85,
      defaultCota: 2135.2,
      turbineGrid: { rows: 1, cols: 2, width: 80, height: 44 }
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
    visualData: {
      drawingImage: '/hydroelectric-drawings/Molino.png',
      defaultGen: 913.23,
      defaultTurbines: 8,
      defaultFlow: 154.43,
      defaultCota: 1987.74,
      turbineGrid: { rows: 2, cols: 5, width: 160, height: 68 }
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
    visualData: {
      drawingImage: '/hydroelectric-drawings/Sopladora.png',
      defaultGen: 350,
      defaultTurbines: 2,
      defaultFlow: 65,
      turbineGrid: { rows: 1, cols: 3, width: 110, height: 44 }
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
    visualData: {
      drawingImage: '/hydroelectric-drawings/Minas_San_Francisco.png',
      defaultGen: 180,
      defaultTurbines: 2,
      defaultFlow: 45,
      defaultCota: 788.4,
      turbineGrid: { rows: 1, cols: 3, width: 110, height: 44 }
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
    visualData: {
      drawingImage: '/hydroelectric-drawings/Coca_Codo_Sinclair.png',
      defaultGen: 1120,
      defaultTurbines: 6,
      defaultFlow: 620,
      turbineGrid: { rows: 2, cols: 4, width: 160, height: 68 }
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
      maxTurbines: 2,
      maxFlowM3s: 120,
      minLevelMasl: 1645,
      maxLevelMasl: 1651,
      turbineType: 'Francis',
    },
    visualData: {
      drawingImage: '/hydroelectric-drawings/Agoyan.png',
      defaultGen: 95,
      defaultTurbines: 2,
      defaultFlow: 80,
      defaultCota: 1648.5,
      turbineGrid: { rows: 1, cols: 2, width: 80, height: 44 }
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
