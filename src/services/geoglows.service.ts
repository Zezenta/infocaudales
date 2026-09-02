import axios from 'axios';
import { geoglowsLogger } from '../utils/logger.js';

export class GeoglowsService {
  private readonly geoglowsFcstUrl = 'https://services.geoglows.org/api/hydroviewer/get-forecast-csv';
  private readonly wrfWmsUrl = 'https://services.geoglows.org/geoserver/wrf/wms';

  /**
   * Fetches streamflow forecast (in m³/s) from GEOGLOWS Hydroviewer CSV endpoint.
   */
  public async fetchGeoglowsForecast(comid: number, targetDate: Date = new Date()): Promise<number | null> {
    const dateStr = targetDate.toISOString().slice(0, 10);
    const url = `${this.geoglowsFcstUrl}?comid=${comid}&date=${dateStr}`;

    try {
      const response = await axios.get(url, { timeout: 20000 });
      if (response.status === 200 && typeof response.data === 'string') {
        const lines = response.data.trim().split('\n');
        if (lines.length > 1) {
          const header = lines[0].split(',').map(h => h.trim());
          const flowAvgIdx = header.indexOf('flow_avg') !== -1 ? header.indexOf('flow_avg') : header.indexOf('flow_res');

          if (flowAvgIdx !== -1) {
            const todayValues: number[] = [];
            for (let i = 1; i < lines.length; i++) {
              const cols = lines[i].split(',');
              if (cols[0]?.includes(dateStr) && cols[flowAvgIdx]) {
                const val = parseFloat(cols[flowAvgIdx]);
                if (!isNaN(val)) todayValues.push(val);
              }
            }

            if (todayValues.length > 0) {
              const avg = todayValues.reduce((a, b) => a + b, 0) / todayValues.length;
              geoglowsLogger.info(`Fetched GEOGLOWS forecast for COMID ${comid} on ${dateStr}: ${avg.toFixed(2)} m³/s`);
              return avg;
            }
          }
        }
      }
    } catch (error: any) {
      geoglowsLogger.error(`Failed to fetch GEOGLOWS forecast for COMID ${comid}: ${error?.message || error}`);
    }
    return null;
  }

  /**
   * Fetches WRF daily accumulated precipitation (in mm) from GeoServer WMS GetFeatureInfo.
   */
  public async fetchWrfPrecipitation(x: number, y: number, targetDate: Date = new Date()): Promise<number> {
    const initd = new Date(targetDate.getTime() - 24 * 3600 * 1000);
    const initdStr = initd.toISOString().slice(0, 10) + 'T07:00:00.000Z';
    const timeStr = targetDate.toISOString().slice(0, 10) + 'T07:00:00.000Z';

    const params = {
      SERVICE: 'WMS',
      VERSION: '1.1.1',
      REQUEST: 'GetFeatureInfo',
      LAYERS: 'wrf:wrf_precipitation_daily',
      QUERY_LAYERS: 'wrf:wrf_precipitation_daily',
      INFO_FORMAT: 'application/json',
      WIDTH: '1000',
      HEIGHT: '1000',
      SRS: 'EPSG:4326',
      BBOX: '-81.0989,-5.0323,-75.1859,1.4747',
      X: x.toString(),
      Y: y.toString(),
      TIME: timeStr,
      DIM_INITD: initdStr
    };

    try {
      const response = await axios.get(this.wrfWmsUrl, { params, timeout: 15000 });
      if (response.status === 200 && response.data?.features?.length > 0) {
        const val = response.data.features[0]?.properties?.GRAY_INDEX;
        if (val !== undefined && val !== null) {
          const rainMm = parseFloat(val);
          geoglowsLogger.info(`Fetched WRF precipitation at (${x}, ${y}) for ${timeStr}: ${rainMm.toFixed(2)} mm`);
          return isNaN(rainMm) ? 0.0 : rainMm;
        }
      }
    } catch (error: any) {
      geoglowsLogger.error(`Failed to fetch WRF precipitation at (${x}, ${y}): ${error?.message || error}`);
    }
    return 0.0;
  }
}
