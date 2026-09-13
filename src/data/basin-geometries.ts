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
    bbox: [-81.5, -5.2, -75.0, 1.8],
  },
  cocaCodoSinclair: {
    key: 'cocaCodoSinclair',
    name: 'Cuenca Coca Codo Sinclair',
    subtitle: 'Ríos Quijos / Salado / Coca',
    bbox: [-78.4, -0.8, -77.1, 0.5],
    plantLocation: {
      lat: -0.21,
      lon: -77.7,
      label: 'Captación CCS'
    }
  },
  mazar: {
    key: 'mazar',
    name: 'Complejo Paute / Mazar',
    subtitle: 'Cuenca Río Paute',
    bbox: [-79.3, -3.1, -78.2, -2.1],
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
    bbox: [-79.3, -3.1, -78.2, -2.1],
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
    bbox: [-79.3, -3.1, -78.2, -2.1],
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
    bbox: [-78.7, -1.6, -77.9, -1.2],
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
    bbox: [-79.8, -3.6, -79.2, -3.1],
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
