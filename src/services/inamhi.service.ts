import axios from 'axios';
import * as https from 'https';
import { inamhiLogger } from '../utils/logger.js';

export interface StationLevelResult {
  value: number;
  timestamp?: Date;
  ageHours?: number;
  isFallback: boolean;
}

export interface StationPrecipitationResult {
  value: number;
  timestamp?: Date;
  isMatched: boolean;
}

export class InamhiService {
  private readonly visorDataUrl = 'https://inamhi.gob.ec/api_visor/station_data_automaticas/get_data_hour/';
  private readonly visorPrecipUrl = 'https://inamhi.gob.ec/api_visor/station_data_automaticas/get_precipitation/';
  
  private readonly agent = new https.Agent({ rejectUnauthorized: false });

  /**
   * Parses various datetime formats returned by INAMHI Visor API.
   */
  public parseVisorDatetime(dtStr: string): Date | null {
    if (!dtStr) return null;
    try {
      if (dtStr.length > 10 && dtStr.slice(10).includes('-')) {
        const parts = dtStr.slice(10).split('-');
        const base = dtStr.slice(0, 10) + parts[0];
        const tzH = parseInt(parts[1].split(':')[0], 10);
        const dt = new Date(base.split('.')[0] + 'Z');
        return new Date(dt.getTime() + tzH * 3600 * 1000);
      } else if (dtStr.length > 10 && dtStr.slice(10).includes('+')) {
        const parts = dtStr.slice(10).split('+');
        const base = dtStr.slice(0, 10) + parts[0];
        const tzH = parseInt(parts[1].split(':')[0], 10);
        const dt = new Date(base.split('.')[0] + 'Z');
        return new Date(dt.getTime() - tzH * 3600 * 1000);
      } else if (dtStr.endsWith('Z')) {
        return new Date(dtStr);
      } else {
        return new Date(dtStr.replace(' ', 'T') + 'Z');
      }
    } catch {
      return null;
    }
  }

  /**
   * Fetches real-time water level (in meters) from an INAMHI hydrological station.
   * Applies age verification: if data is older than maxAgeHours, applies fallback baseline.
   */
  public async fetchStationLevel(
    stationId: number | string,
    stationName: string = '',
    options: { fallback?: number; maxAgeHours?: number; targetDate?: Date } = {}
  ): Promise<StationLevelResult> {
    const fallback = options.fallback ?? 1.0;
    const maxAgeHours = options.maxAgeHours ?? 4.0;
    const nowUtc = options.targetDate ?? new Date();

    const payload = {
      id_estacion: Number(stationId),
      table_names: ['014100101h', '014100201h', '014100401h', '014101601h']
    };

    try {
      const response = await axios.post(this.visorDataUrl, payload, {
        httpsAgent: this.agent,
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.status === 200 && response.data?.series) {
        const series: any[] = response.data.series;
        // Prefer 014100401h (average level)
        let targetSeries = series.find(s => s.code === '014100401h') || series[0];

        if (targetSeries?.data) {
          const validPts: Array<{ date: Date; val: number }> = [];
          for (const pt of targetSeries.data) {
            const dtVal = this.parseVisorDatetime(pt.date);
            const val = parseFloat(pt.value);
            if (dtVal && !isNaN(val)) {
              validPts.push({ date: dtVal, val });
            }
          }

          if (validPts.length > 0) {
            validPts.sort((a, b) => a.date.getTime() - b.date.getTime());
            const latest = validPts[validPts.length - 1];
            const ageHours = (nowUtc.getTime() - latest.date.getTime()) / (3600 * 1000);

            if (ageHours > maxAgeHours) {
              inamhiLogger.warn(
                `Sensor data for ${stationName || stationId} is stale (${ageHours.toFixed(1)}h old). Value was ${latest.val} m. Using baseline fallback: ${fallback} m`
              );
              return { value: fallback, timestamp: latest.date, ageHours, isFallback: true };
            }

            inamhiLogger.info(
              `Fetched level for ${stationName || stationId}: ${latest.val} m at ${latest.date.toISOString()} (Age: ${ageHours.toFixed(2)}h)`
            );
            return { value: latest.val, timestamp: latest.date, ageHours, isFallback: false };
          }
        }
      }
    } catch (error: any) {
      inamhiLogger.error(`Failed to fetch level for station ${stationName || stationId}: ${error?.message || error}`);
    }

    inamhiLogger.warn(`Using fallback level for ${stationName || stationId}: ${fallback} m`);
    return { value: fallback, isFallback: true };
  }

  /**
   * Fetches hourly precipitation (in mm) from an INAMHI meteorological station for a specific target time.
   */
  public async fetchStationPrecipitation(
    stationId: number | string,
    stationName: string = '',
    targetDate: Date = new Date()
  ): Promise<StationPrecipitationResult> {
    const yesterday = new Date(targetDate.getTime() - 24 * 3600 * 1000);
    const fechaDesde = yesterday.toISOString().slice(0, 10);
    const fechaHasta = targetDate.toISOString().slice(0, 10);

    const payload = {
      id_estacion: Number(stationId),
      fecha_desde: fechaDesde,
      fecha_hasta: fechaHasta
    };

    try {
      const response = await axios.post(this.visorPrecipUrl, payload, {
        httpsAgent: this.agent,
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.status === 200 && response.data?.series) {
        const series: any[] = response.data.series;
        // Prefer hourly series (code ending in 'h')
        const targetSeries = series.find(s => s.code?.endsWith('h')) || series[0];

        if (targetSeries?.data) {
          const pts: Array<{ date: Date; val: number }> = [];
          for (const pt of targetSeries.data) {
            const dtVal = this.parseVisorDatetime(pt.date);
            const val = parseFloat(pt.value);
            if (dtVal && !isNaN(val)) {
              pts.push({ date: dtVal, val });
            }
          }

          if (pts.length > 0) {
            // Find point closest to targetDate
            let closest = pts[0];
            let minDiff = Math.abs(pts[0].date.getTime() - targetDate.getTime());

            for (const pt of pts) {
              const diff = Math.abs(pt.date.getTime() - targetDate.getTime());
              if (diff < minDiff) {
                minDiff = diff;
                closest = pt;
              }
            }

            const diffHours = minDiff / (3600 * 1000);
            if (diffHours <= 3.0) {
              inamhiLogger.info(
                `Fetched precip for ${stationName || stationId}: ${closest.val} mm for target ${targetDate.toISOString()} (diff: ${diffHours.toFixed(1)}h)`
              );
              return { value: closest.val, timestamp: closest.date, isMatched: true };
            }
          }
        }
      }
    } catch (error: any) {
      inamhiLogger.error(`Failed to fetch precipitation for ${stationName || stationId}: ${error?.message || error}`);
    }

    return { value: 0.0, isMatched: false };
  }
}
