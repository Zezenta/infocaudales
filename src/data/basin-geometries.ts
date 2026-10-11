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
