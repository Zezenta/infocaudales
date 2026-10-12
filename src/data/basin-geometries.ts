export interface PlantPin {
  lat: number;
  lon: number;
  label: string;
  placement?: 'top-left' | 'bottom-left' | 'top-right' | 'bottom-right' | 'right' | 'left';
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
    subtitle: 'Ríos Quijos • Salado • Cosanga (Aguas arriba)',
    bbox: [-78.30, -0.75, -77.60, 0.20],
    plantLocation: {
      lat: -0.21,
      lon: -77.70,
      label: 'Captación CCS'
    }
  },
  paute: {
    key: 'paute',
    name: 'Complejo Hidroeléctrico Paute',
    subtitle: 'Cajas • Cuenca • Mazar • Amaluza • Sopladora',
    bbox: [-79.38, -3.30, -78.40, -2.25],
    plantLocation: {
      lat: -2.58,
      lon: -78.58,
      label: 'Complejo Paute'
    }
  },
  mazar: {
    key: 'mazar',
    name: 'Complejo Paute / Mazar',
    subtitle: 'Cuenca Río Paute y Mazar',
    bbox: [-79.38, -3.30, -78.40, -2.25],
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
    bbox: [-79.38, -3.30, -78.40, -2.25],
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
    bbox: [-79.38, -3.30, -78.40, -2.25],
    plantLocation: {
      lat: -2.61,
      lon: -78.54,
      label: 'Central Sopladora'
    }
  },
  agoyan: {
    key: 'agoyan',
    name: 'Cuenca Pastaza / Agoyán',
    subtitle: 'Ríos Chambo y Patate (Aguas arriba)',
    bbox: [-78.98, -2.35, -78.30, -0.58],
    plantLocation: {
      lat: -1.40,
      lon: -78.36,
      label: 'Presa Agoyán'
    }
  },
  minasSanFrancisco: {
    key: 'minasSanFrancisco',
    name: 'Cuenca Jubones / MSF',
    subtitle: 'Cuenca Alta Río Jubones',
    bbox: [-79.60, -3.75, -78.90, -3.00],
    plantLocation: {
      lat: -3.34,
      lon: -79.48,
      label: 'Central Minas San Francisco'
    }
  }
};

export const ALL_HYDRO_PLANTS_PINS: PlantPin[] = [
  { lat: -0.21, lon: -77.70, label: 'Coca Codo Sinclair', placement: 'right' },
  { lat: -2.54, lon: -78.63, label: 'Mazar', placement: 'top-left' },
  { lat: -2.58, lon: -78.58, label: 'Molino', placement: 'bottom-left' },
  { lat: -2.61, lon: -78.54, label: 'Sopladora', placement: 'right' },
  { lat: -1.40, lon: -78.36, label: 'Agoyán', placement: 'right' },
  { lat: -3.34, lon: -79.48, label: 'Minas San Francisco', placement: 'right' }
];

export interface CityPin {
  lat: number;
  lon: number;
  label: string;
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

export const DEFAULT_REFERENCE_CITIES: CityPin[] = [
  { lat: -0.180, lon: -78.468, label: 'Quito', placement: 'left' },
  { lat: -2.189, lon: -79.889, label: 'Guayaquil', placement: 'right' },
  { lat: -2.900, lon: -79.006, label: 'Cuenca', placement: 'bottom-left' },
  { lat: -1.054, lon: -80.454, label: 'Portoviejo', placement: 'left' },
  { lat: -0.844, lon: -80.164, label: 'Calceta', placement: 'top-right' }
];

export const COSTA_SIERRA_DIVIDE: Array<[number, number]> = [
  [-78.80, 1.45],
  [-78.95, 0.85],
  [-79.10, 0.10],
  [-79.20, -0.30],
  [-79.25, -0.95],
  [-79.30, -1.45],
  [-79.38, -1.85],
  [-79.48, -2.30],
  [-79.58, -2.75],
  [-79.68, -3.20],
  [-79.82, -3.70],
  [-79.98, -4.10],
  [-80.20, -4.45],
  [-80.45, -4.65]
];

export const SIERRA_AMAZONIA_DIVIDE: Array<[number, number]> = [
  [-77.55, 0.75],
  [-77.85, -0.05],
  [-77.95, -0.55],
  [-78.05, -1.05],
  [-78.18, -1.45],
  [-78.32, -2.05],
  [-78.45, -2.85],
  [-78.60, -3.45],
  [-78.85, -4.00],
  [-79.05, -4.65],
  [-79.15, -4.95]
];

export function interpolateDivideLon(divide: Array<[number, number]>, lat: number): number {
  if (lat >= divide[0][1]) return divide[0][0];
  if (lat <= divide[divide.length - 1][1]) return divide[divide.length - 1][0];
  for (let i = 0; i < divide.length - 1; i++) {
    const [lon1, lat1] = divide[i];
    const [lon2, lat2] = divide[i + 1];
    if (lat <= lat1 && lat >= lat2) {
      const t = (lat - lat2) / (lat1 - lat2);
      return lon2 + t * (lon1 - lon2);
    }
  }
  return divide[0][0];
}

