import { hydroelectricPlants } from '../../data/hydroelectric-plants.js';
import { CelecService, CelecPointValue } from './celec.service.js';
import { CenaceService } from './cenace.service.js';
import { TelemetryData } from '../report-generator.service.js';
import { db } from '../../utils/db.js';

export class DataPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataPendingError';
  }
}

export const celecService = new CelecService();
export const cenaceService = new CenaceService();

/**
 * Extracts point value by index from CELEC array.
 * If requireTargetHour is true and current hour value is null, throws DataPendingError for retry.
 * Otherwise, falls back to the nearest non-null earlier point.
 */
export function extractCelecPoint(
  pointsToday: CelecPointValue[],
  targetIdx: number,
  requireTargetHour: boolean = false
): { value: number | null; timestamp?: Date } {
  if (!pointsToday || pointsToday.length === 0) return { value: null };

  const safeIdx = Math.min(Math.max(0, targetIdx), pointsToday.length - 1);

  if (pointsToday[safeIdx] && pointsToday[safeIdx].value !== null && pointsToday[safeIdx].value !== undefined) {
    const pointDate = pointsToday[safeIdx].timestamp ? new Date(pointsToday[safeIdx].timestamp) : undefined;
    return { value: pointsToday[safeIdx].value, timestamp: pointDate };
  }

  if (requireTargetHour) {
    throw new DataPendingError(`CELEC target point at index ${safeIdx} is not yet published (null)`);
  }

  // Fallback mode: find first available non-null point starting from safeIdx onwards
  for (let i = safeIdx; i < pointsToday.length; i++) {
    if (pointsToday[i] && pointsToday[i].value !== null && pointsToday[i].value !== undefined) {
      const pointDate = pointsToday[i].timestamp ? new Date(pointsToday[i].timestamp) : undefined;
      return { value: pointsToday[i].value, timestamp: pointDate };
    }
  }

  return { value: null };
}

/**
 * Helper to get latest and previous non-null values from CELEC points to calculate trend.
 */
export function extractPointsWithTrend(points: CelecPointValue[]): {
  current: number | null;
  prev: number | null;
  trend: 'up' | 'down';
  timestamp?: Date;
} {
  const valid = (points || []).filter(p => p && p.value !== null && p.value !== undefined);
  if (valid.length === 0) {
    return { current: null, prev: null, trend: 'up' };
  }
  const current = valid[0].value!;
  const prev = valid.length > 1 ? valid[1].value! : current;
  const timestamp = valid[0].timestamp ? new Date(valid[0].timestamp) : undefined;
  const trend: 'up' | 'down' = current >= prev ? 'up' : 'down';
  return { current, prev, trend, timestamp };
}

/**
 * Fetches real-time telemetry data for a specific plant.
 * Supports retry validation when requireTargetHour is true.
 * Returns null if essential live metrics (gen, flow) cannot be obtained.
 */
export async function fetchTelemetry(plantKey: string, requireTargetHour: boolean = false): Promise<TelemetryData | null> {
  const plant = hydroelectricPlants[plantKey];
  if (!plant) throw new Error(`Plant ${plantKey} not found in configuration`);

  const now = new Date();
  const { hora } = celecService.getEcuadorDateParts(now);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const targetIdx = Math.max(0, 24 - hora);

  let flow: number | null = null;
  let flow3hAgo: number | null = null;
  let cota: number | undefined = undefined;
  let cota24hAgo: number | undefined = undefined;
  let turbines: number | undefined = undefined;
  let gen: number | null = null;
  let telemetryTimestamp: Date = now;

  // 1. Fetch Flow (Caudal) from CELEC
  try {
    const flowPointsToday = await celecService.fetchFlow(plant, now);
    const flowResult = extractCelecPoint(flowPointsToday, targetIdx, requireTargetHour);
    if (flowResult.value !== null) {
      flow = flowResult.value;
      if (flowResult.timestamp) telemetryTimestamp = flowResult.timestamp;
    }

    // Contingency for Coca Codo Sinclair: if read flow is 0 m³/s, fallback to current day's latest non-zero flow
    if (plantKey === 'cocaCodoSinclair' && flow === 0) {
      console.warn(`[LiveTelemetry] Coca Codo Sinclair flow is 0 m³/s. Searching current day for latest non-zero flow...`);
      for (let i = targetIdx; i < flowPointsToday.length; i++) {
        const pVal = flowPointsToday[i]?.value;
        if (pVal !== null && pVal !== undefined && pVal > 0) {
          flow = pVal;
          console.log(`[LiveTelemetry] Contingency applied: using current day's non-zero flow (${flow} m³/s) for Coca Codo Sinclair.`);
          break;
        }
      }
    }

    // Extract 3h ago flow
    if (hora >= 4) {
      const idx3h = 24 - hora + 3;
      const flow3hResult = extractCelecPoint(flowPointsToday, idx3h, false);
      if (flow3hResult.value !== null) flow3hAgo = flow3hResult.value;
    } else {
      try {
        const flowPointsYesterday = await celecService.fetchFlow(plant, yesterday);
        const idxYesterday = Math.max(0, 3 - hora);
        const flow3hResult = extractCelecPoint(flowPointsYesterday, idxYesterday, false);
        if (flow3hResult.value !== null) {
          flow3hAgo = flow3hResult.value;
        }
      } catch (e) {}
    }
  } catch (err) {
    if (err instanceof DataPendingError) throw err;
    console.warn(`[LiveTelemetry] Failed to fetch flow for ${plant.name}:`, err);
  }

  // 2. Fetch Cota (Reservoir Level) from CELEC (ignored for Sopladora & CCS)
  const minLevel = plant.physicalData?.minLevelMasl;
  if (plantKey !== 'sopladora' && plantKey !== 'cocaCodoSinclair' && minLevel !== undefined) {
    try {
      const levelPointsToday = await celecService.fetchLevel(plant, now);
      const levelResult = extractCelecPoint(levelPointsToday, targetIdx, requireTargetHour);
      if (levelResult.value !== null) {
        cota = levelResult.value;
        if (levelResult.timestamp && telemetryTimestamp === now) telemetryTimestamp = levelResult.timestamp;
      }
    } catch (err) {
      if (err instanceof DataPendingError) throw err;
      console.warn(`[LiveTelemetry] Failed to fetch level for ${plant.name}:`, err);
    }

    try {
      const levelPointsYesterday = await celecService.fetchLevel(plant, yesterday);
      const level24hResult = extractCelecPoint(levelPointsYesterday, targetIdx, false);
      if (level24hResult.value !== null) {
        cota24hAgo = level24hResult.value;
      }
    } catch (err) {
      console.warn(`[LiveTelemetry] Failed to fetch 24h ago level for ${plant.name}:`, err);
    }
  } else {
    cota = undefined;
    cota24hAgo = undefined;
  }

  // 3. Fetch Active Turbines from CELEC (ignored for CCS)
  if (plantKey !== 'cocaCodoSinclair') {
    try {
      const turbinePointsToday = await celecService.fetchActiveTurbines(plant, now);
      const turbineResult = extractCelecPoint(turbinePointsToday, targetIdx, requireTargetHour);
      if (turbineResult.value !== null) {
        turbines = turbineResult.value;
      }
    } catch (err) {
      if (err instanceof DataPendingError) throw err;
      console.warn(`[LiveTelemetry] Failed to fetch turbines for ${plant.name}:`, err);
    }
  } else {
    turbines = undefined;
  }

  // 4. Fetch Generation
  if (plantKey === 'cocaCodoSinclair') {
    try {
      const ecTime = new Date(now.getTime() - 5 * 60 * 60 * 1000);
      const year = ecTime.getUTCFullYear();
      const month = ecTime.getUTCMonth();
      const date = ecTime.getUTCDate();
      
      const targetUtcMs = Date.UTC(year, month, date, hora + 5);
      const prevUtcMs = targetUtcMs - 60 * 60 * 1000;

      const rows = db.prepare(`
        SELECT timestamp, accumulated_mwh 
        FROM coca_codo_hourly_log 
        WHERE timestamp = ? OR timestamp = ?
        ORDER BY timestamp ASC
      `).all(prevUtcMs, targetUtcMs) as any[];

      let ccsGen: number | null = null;

      if (rows.length === 2) {
        const start = rows[0];
        const end = rows[1];
        const diffHours = (end.timestamp - start.timestamp) / (1000 * 60 * 60);
        let deltaMWh = end.accumulated_mwh - start.accumulated_mwh;
        if (deltaMWh < 0) {
          deltaMWh = end.accumulated_mwh;
        }
        
        if (diffHours > 0.05 && deltaMWh >= 0) {
          const rawRate = deltaMWh / diffHours;
          ccsGen = Math.min(rawRate, 1500);
          console.log(`[LiveTelemetry] Inferred completed hourly generation for Coca Codo Sinclair from SQLite: ${ccsGen.toFixed(2)} MW`);
        }
      }

      if (ccsGen === null) {
        console.log(`[LiveTelemetry] Completed hourly logs for Coca Codo Sinclair not found in SQLite. Falling back to daily average.`);
        const currentMWh = await cenaceService.fetchPlantProduction('cocaCodoSinclair');
        if (currentMWh !== null && currentMWh > 0) {
          const currentLocalHour = Math.max(1, hora === 0 ? 24 : hora);
          ccsGen = currentMWh / currentLocalHour;
        }
      }

      if (ccsGen !== null) {
        gen = ccsGen;
      }
    } catch (err) {
      console.warn(`[LiveTelemetry] Failed to fetch SQLite/CENACE generation for Coca Codo Sinclair:`, err);
    }
  } else {
    try {
      const energyPointsToday = await celecService.fetchDailyEnergy(plant, now);
      const energyResult = extractCelecPoint(energyPointsToday, targetIdx, requireTargetHour);
      if (energyResult.value !== null) {
        gen = energyResult.value;
      }
    } catch (err) {
      if (err instanceof DataPendingError) throw err;
      console.warn(`[LiveTelemetry] Failed to fetch CELEC generation for ${plant.name}:`, err);
    }
  }

  if (gen === null || flow === null) {
    console.warn(`[LiveTelemetry] Aborting telemetry for ${plant.name}: missing live data (gen: ${gen}, flow: ${flow})`);
    return null;
  }

  return {
    gen,
    flow,
    flow3hAgo: flow3hAgo ?? flow,
    cota,
    cota24hAgo,
    turbines,
    timestamp: telemetryTimestamp
  };
}

export interface PlantCoverMetrics {
  key: string;
  name: string;
  shortName: string;
  maxMW: number;
  maxTurbines: number;
  currentMW: number;
  activeTurbines: number;
  currentStatus: 'online' | 'offline';
  hasReservoir: boolean;
  currentCota: number;
  cotaTrend: 'up' | 'down';
  currentFlow: number;
  flowTrend: 'up' | 'down';
  timestamp: string | null;
}

export interface CoverLiveData {
  success: boolean;
  updatedAtIso: string;
  formattedDateEcuador: string;
  hourEcuador: number;
  totalMW: number;
  totalCapacityMW: number;
  capacityPercent: number;
  plants: Record<string, PlantCoverMetrics>;
}

export function formatEcuadorDateString(date: Date = new Date()): string {
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  
  // Date in Ecuador time (UTC - 5)
  const ecDate = new Date(date.getTime() - 5 * 60 * 60 * 1000);
  const dayName = days[ecDate.getUTCDay()];
  const dayNum = ecDate.getUTCDate();
  const monthName = months[ecDate.getUTCMonth()];
  const year = ecDate.getUTCFullYear();
  const hours = String(ecDate.getUTCHours()).padStart(2, '0');
  const mins = String(ecDate.getUTCMinutes()).padStart(2, '0');

  return `${dayName}, ${dayNum} de ${monthName} ${year} • ${hours}:${mins} ECT`;
}

/**
 * Fetches consolidated live telemetry for all 6 hydroelectric plants in parallel,
 * formatted specifically for the social cover card and visualizer.
 */
export async function fetchCoverLiveData(): Promise<CoverLiveData> {
  const plantKeys = ['cocaCodoSinclair', 'molino', 'sopladora', 'mazar', 'minasSanFrancisco', 'agoyan'];
  const now = new Date();
  const { hora } = celecService.getEcuadorDateParts(now);

  const shortNames: Record<string, string> = {
    cocaCodoSinclair: 'Coca Codo',
    molino: 'Paute Molino',
    sopladora: 'Sopladora',
    mazar: 'Paute Mazar',
    minasSanFrancisco: 'Minas S.F.',
    agoyan: 'Agoyán'
  };

  const results = await Promise.all(
    plantKeys.map(async (key): Promise<PlantCoverMetrics> => {
      const p = hydroelectricPlants[key];
      const hasReservoir = p.physicalData?.minLevelMasl !== undefined && key !== 'sopladora' && key !== 'cocaCodoSinclair';

      const metrics: PlantCoverMetrics = {
        key,
        name: p.name,
        shortName: shortNames[key] || p.name,
        maxMW: p.physicalData?.maxEnergyMW || 0,
        maxTurbines: p.physicalData?.maxTurbines || 0,
        currentMW: 0,
        activeTurbines: 0,
        currentStatus: 'offline',
        hasReservoir,
        currentCota: 0,
        cotaTrend: 'up',
        currentFlow: 0,
        flowTrend: 'up',
        timestamp: null
      };

      // 1. Flow & Trend
      try {
        const flowPts = await celecService.fetchFlow(p, now);
        const { current, trend, timestamp } = extractPointsWithTrend(flowPts);
        if (current !== null) {
          metrics.currentFlow = Math.round(current);
          metrics.flowTrend = trend;
          if (timestamp) metrics.timestamp = timestamp.toISOString();
        }
      } catch (e) {}

      // 2. Reservoir Level (Cota) & Trend
      if (hasReservoir) {
        try {
          const lvlPts = await celecService.fetchLevel(p, now);
          const { current, trend, timestamp } = extractPointsWithTrend(lvlPts);
          if (current !== null) {
            metrics.currentCota = Math.round(current * 10) / 10;
            metrics.cotaTrend = trend;
            if (!metrics.timestamp && timestamp) metrics.timestamp = timestamp.toISOString();
          }
        } catch (e) {}
      }

      // 3. Active Turbines & Generation
      if (key !== 'cocaCodoSinclair') {
        try {
          const genPts = await celecService.fetchDailyEnergy(p, now);
          const { current } = extractPointsWithTrend(genPts);
          if (current !== null) {
            metrics.currentMW = Math.round(current);
            metrics.currentStatus = metrics.currentMW > 0 ? 'online' : 'offline';
          }
        } catch (e) {}

        try {
          const turbPts = await celecService.fetchActiveTurbines(p, now);
          const { current } = extractPointsWithTrend(turbPts);
          if (current !== null) {
            metrics.activeTurbines = Math.round(current);
          }
        } catch (e) {}
      } else {
        // CCS Generation from SQLite / CENACE
        try {
          const ecTime = new Date(now.getTime() - 5 * 60 * 60 * 1000);
          const targetUtcMs = Date.UTC(ecTime.getUTCFullYear(), ecTime.getUTCMonth(), ecTime.getUTCDate(), hora + 5);
          const prevUtcMs = targetUtcMs - 60 * 60 * 1000;

          const rows = db.prepare(`
            SELECT timestamp, accumulated_mwh 
            FROM coca_codo_hourly_log 
            WHERE timestamp = ? OR timestamp = ?
            ORDER BY timestamp ASC
          `).all(prevUtcMs, targetUtcMs) as any[];

          let ccsGen: number | null = null;
          if (rows.length === 2) {
            const diffHours = (rows[1].timestamp - rows[0].timestamp) / (1000 * 60 * 60);
            let delta = rows[1].accumulated_mwh - rows[0].accumulated_mwh;
            if (delta < 0) delta = rows[1].accumulated_mwh;
            if (diffHours > 0.05 && delta >= 0) {
              ccsGen = Math.min(1500, Math.round(delta / diffHours));
            }
          }

          if (ccsGen === null) {
            const currentMWh = await cenaceService.fetchPlantProduction('cocaCodoSinclair');
            if (currentMWh !== null && currentMWh > 0) {
              const currentLocalHour = Math.max(1, hora === 0 ? 24 : hora);
              ccsGen = Math.min(1500, Math.round(currentMWh / currentLocalHour));
            }
          }

          if (ccsGen !== null) {
            metrics.currentMW = ccsGen;
            metrics.currentStatus = ccsGen > 0 ? 'online' : 'offline';
            metrics.activeTurbines = Math.min(8, Math.max(1, Math.round(ccsGen / 187.5)));
          }
        } catch (e) {}
      }

      return metrics;
    })
  );

  const plantsMap: Record<string, PlantCoverMetrics> = {};
  let totalMW = 0;
  let totalCapacityMW = 0;

  for (const m of results) {
    plantsMap[m.key] = m;
    totalCapacityMW += m.maxMW;
    if (m.currentStatus === 'online') {
      totalMW += m.currentMW;
    }
  }

  const capacityPercent = totalCapacityMW > 0 ? Math.round((totalMW / totalCapacityMW) * 1000) / 10 : 0;
  
  // Find the latest timestamp among plants, or now
  let latestTs = now;
  for (const m of results) {
    if (m.timestamp) {
      const d = new Date(m.timestamp);
      if (d > latestTs || latestTs === now) {
        latestTs = d;
      }
    }
  }

  return {
    success: true,
    updatedAtIso: now.toISOString(),
    formattedDateEcuador: formatEcuadorDateString(latestTs),
    hourEcuador: hora,
    totalMW,
    totalCapacityMW,
    capacityPercent,
    plants: plantsMap
  };
}
