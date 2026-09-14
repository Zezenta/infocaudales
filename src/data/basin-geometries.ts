export interface PlantPin {
  lat: number;
  lon: number;
  label: string;
}

export interface BasinGeometry {
  key: string;
  name: string;
  subtitle: string;
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  plantLocation?: PlantPin;
}

export const BASIN_GEOMETRIES: Record<string, BasinGeometry> = {
  ecuador: {
    key: 'ecuador',
    name: 'Ecuador Continental',
    subtitle: 'Nacional',
    bbox: [-81.65, -5.10, -74.85, 1.70],
  },
  cocaCodoSinclair: {
    key: 'cocaCodoSinclair',
    name: 'Cuenca Coca Codo Sinclair',
    subtitle: 'Ríos Quijos / Salado / Coca',
    bbox: [-78.40, -0.80, -77.10, 0.50],
    plantLocation: {
      lat: -0.21,
      lon: -77.70,
      label: 'Captación CCS'
    }
  },
  paute: {
    key: 'paute',
    name: 'Complejo Hidroeléctrico Paute',
    subtitle: 'Mazar • Molino • Sopladora',
    bbox: [-79.15, -3.15, -78.05, -2.05],
    plantLocation: {
      lat: -2.58,
      lon: -78.58,
      label: 'Complejo Paute'
    }
  },
  mazar: {
    key: 'mazar',
    name: 'Complejo Paute / Mazar',
    subtitle: 'Cuenca Río Paute',
    bbox: [-79.15, -3.15, -78.05, -2.05],
    plantLocation: {
      lat: -2.54,
      lon: -78.63,
      label: 'Embalse Mazar'
    }
  },
  molino: {
    key: 'molino',
    name: 'Complejo Paute / Molino',
    subtitle: 'Cuenca Río Paute',
    bbox: [-79.15, -3.15, -78.05, -2.05],
    plantLocation: {
      lat: -2.58,
      lon: -78.58,
      label: 'Presa Amaluza'
    }
  },
  sopladora: {
    key: 'sopladora',
    name: 'Complejo Paute / Sopladora',
    subtitle: 'Cuenca Río Paute',
    bbox: [-79.15, -3.15, -78.05, -2.05],
    plantLocation: {
      lat: -2.61,
      lon: -78.54,
      label: 'Central Sopladora'
    }
  },
  agoyan: {
    key: 'agoyan',
    name: 'Cuenca Pastaza / Agoyán',
    subtitle: 'Río Pastaza',
    bbox: [-78.80, -1.85, -77.90, -0.95],
    plantLocation: {
      lat: -1.40,
      lon: -78.36,
      label: 'Presa Agoyán'
    }
  },
  minasSanFrancisco: {
    key: 'minasSanFrancisco',
    name: 'Cuenca Jubones / MSF',
    subtitle: 'Río Jubones',
    bbox: [-79.88, -3.74, -79.08, -2.94],
    plantLocation: {
      lat: -3.34,
      lon: -79.48,
      label: 'Central Minas San Francisco'
    }
  }
};

export const ALL_HYDRO_PLANTS_PINS: PlantPin[] = [
  { lat: -0.21, lon: -77.70, label: 'Coca Codo Sinclair' },
  { lat: -2.54, lon: -78.63, label: 'Mazar' },
  { lat: -2.58, lon: -78.58, label: 'Molino' },
  { lat: -2.61, lon: -78.54, label: 'Sopladora' },
  { lat: -1.40, lon: -78.36, label: 'Agoyán' },
  { lat: -3.34, lon: -79.48, label: 'Minas San Francisco' }
];
