import axios from 'axios';
import { BASIN_GEOMETRIES, BasinGeometry } from '../data/basin-geometries.js';
import { systemLogger } from '../utils/logger.js';

export type SatelliteSource = 'geoserver' | 'nasa_gibs' | 'esri_satellite';

export interface FetchMapTileOptions {
  source?: SatelliteSource;
  layers?: string | string[];
  bbox?: [number, number, number, number];
  plantKey?: string;
  time?: string;
  width?: number;
  height?: number;
  format?: string;
  srs?: string;
  transparent?: boolean;
  dimInitd?: string;
}

export interface SatelliteFrame {
  index: number;
  timestampIso: string;
  dateEcuador: string;
  timeEcuador: string;
  buffer: Buffer;
  bbox: [number, number, number, number];
  plantKey: string;
  source: SatelliteSource;
}

export interface BasinFramesOptions {
  plantKey?: string;
  bbox?: [number, number, number, number];
  frameCount?: number;
  source?: SatelliteSource;
  width?: number;
  height?: number;
  layers?: string | string[];
  concurrency?: number;
}

export class SatelliteMapService {
  private readonly geoserverGlobalUrl = 'https://services.geoglows.org/geoserver/wms';
  private readonly geoserverGoesUrl = 'https://services.geoglows.org/geoserver/goes/wms';
  private readonly nasaGibsUrl = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
  private readonly esriSatelliteUrl = 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export';
  private readonly tileCache = new Map<string, Buffer>();

  /**
   * Fetches available GOES-16 satellite timestamps from GEOGLOWS GeoServer GetCapabilities.
   * Returns sorted array of ISO timestamp strings (oldest to newest).
   */
  public async fetchGoesTimestamps(options: { limit?: number } = {}): Promise<string[]> {
    const limit = options.limit ?? 18;
    const capabilitiesUrl = `${this.geoserverGoesUrl}?service=WMS&version=1.1.1&request=GetCapabilities`;

    try {
      const response = await axios.get(capabilitiesUrl, { timeout: 15000 });
      if (response.status === 200 && typeof response.data === 'string') {
        const xml = response.data;
        const timeMatch = xml.match(/<Extent name="time"[^>]*>([\s\S]*?)<\/Extent>/i) ||
                          xml.match(/<Dimension name="time"[^>]*>([\s\S]*?)<\/Dimension>/i);

        if (timeMatch && timeMatch[1]) {
          const rawTimes = timeMatch[1]
            .trim()
            .split(',')
            .map(t => t.trim())
            .filter(t => Boolean(t) && !isNaN(Date.parse(t)));

          rawTimes.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

          if (rawTimes.length > 0) {
            return limit > 0 ? rawTimes.slice(-limit) : rawTimes;
          }
        }
      }
    } catch (error: any) {
      systemLogger.warn(`[SatelliteMapService] Failed to fetch GOES capabilities from GeoServer: ${error?.message || error}`);
    }

    // Fallback: Generate synthetic 10-minute intervals ending at latest 10-min mark
    systemLogger.info('[SatelliteMapService] Generating synthetic 10-min interval timestamps as fallback...');
    return this.generateFallbackTimestamps(limit);
  }

  /**
   * Generates synthetic timestamps spaced by 10 minutes (for offline/fallback mode).
   */
  public generateFallbackTimestamps(count: number = 18, intervalMinutes: number = 10): string[] {
    const nowMs = Date.now();
    // Round down to previous 10-minute boundary
    const roundedMs = Math.floor(nowMs / (intervalMinutes * 60 * 1000)) * (intervalMinutes * 60 * 1000);
    const timestamps: string[] = [];

    for (let i = count - 1; i >= 0; i--) {
      const tMs = roundedMs - i * intervalMinutes * 60 * 1000;
      timestamps.push(new Date(tMs).toISOString());
    }

    return timestamps;
  }

  /**
   * Resolves bounding box from options (either explicit bbox, basin plantKey, or default Ecuador).
   */
  public resolveBbox(options: { bbox?: [number, number, number, number]; plantKey?: string }): [number, number, number, number] {
    if (options.bbox && options.bbox.length === 4) {
      return options.bbox;
    }
    if (options.plantKey && BASIN_GEOMETRIES[options.plantKey]) {
      return BASIN_GEOMETRIES[options.plantKey].bbox;
    }
    return BASIN_GEOMETRIES.ecuador.bbox;
  }

  /**
   * Builds the WMS GetMap query parameters for GeoServer or NASA GIBS.
   */
  public buildWmsUrl(options: FetchMapTileOptions): { url: string; params: Record<string, string> } {
    const source = options.source ?? 'geoserver';
    const bbox = this.resolveBbox(options);
    const width = options.width ?? 800;
    const height = options.height ?? 800;
    const format = options.format ?? 'image/png';
    const srs = options.srs ?? 'EPSG:4326';
    const bboxStr = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`;

    if (source === 'esri_satellite') {
      const params: Record<string, string> = {
        bbox: `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`,
        bboxSR: '4326',
        imageSR: '4326',
        size: `${width},${height}`,
        format: 'png',
        f: 'image'
      };
      return { url: this.esriSatelliteUrl, params };
    }

    if (source === 'nasa_gibs') {
      const layers = Array.isArray(options.layers)
        ? options.layers.join(',')
        : options.layers || 'GOES-East_ABI_Band13_Clean_Infrared';

      const params: Record<string, string> = {
        SERVICE: 'WMS',
        REQUEST: 'GetMap',
        VERSION: '1.3.0',
        LAYERS: layers,
        STYLES: '',
        FORMAT: format,
        TRANSPARENT: options.transparent !== false ? 'TRUE' : 'FALSE',
        CRS: srs,
        BBOX: `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`, // WMS 1.3.0 lat/lon ordering
        WIDTH: width.toString(),
        HEIGHT: height.toString()
      };

      if (options.time) {
        params.TIME = options.time;
      }

      return { url: this.nasaGibsUrl, params };
    }

    // Default: GeoServer
    const layers = Array.isArray(options.layers)
      ? options.layers.join(',')
      : options.layers || 'goes:goes_abi_l2_cmipf_13,ecuador:provincias';

    const params: Record<string, string> = {
      SERVICE: 'WMS',
      VERSION: '1.1.1',
      REQUEST: 'GetMap',
      LAYERS: layers,
      STYLES: '',
      SRS: srs,
      BBOX: bboxStr,
      WIDTH: width.toString(),
      HEIGHT: height.toString(),
      FORMAT: format,
      TRANSPARENT: options.transparent !== false ? 'TRUE' : 'FALSE'
    };

    if (options.time) {
      params.TIME = options.time;
    }
    if (options.dimInitd) {
      params.DIM_INITD = options.dimInitd;
    }

    return { url: this.geoserverGlobalUrl, params };
  }

  /**
   * Fetches a single map tile / snapshot buffer from WMS (with in-memory cache).
   */
  public async fetchMapTile(options: FetchMapTileOptions): Promise<Buffer> {
    const { url, params } = this.buildWmsUrl(options);
    const cacheKey = `${url}_${JSON.stringify(params)}`;

    if (this.tileCache.has(cacheKey)) {
      return this.tileCache.get(cacheKey)!;
    }

    try {
      const response = await axios.get(url, {
        params,
        responseType: 'arraybuffer',
        timeout: 20000
      });

      if (response.status === 200 && response.data) {
        const buf = Buffer.from(response.data);
        this.tileCache.set(cacheKey, buf);
        return buf;
      }
      throw new Error(`Invalid response status: ${response.status}`);
    } catch (error: any) {
      systemLogger.error(`[SatelliteMapService] Failed to fetch map tile: ${error?.message || error}`);
      throw error;
    }
  }

  /**
   * Asynchronously preloads frames for all 4 layer options in the background.
   */
  public preloadAllOptionsBackground(options: { limit?: number; plantKeys?: string[] } = {}): void {
    const limit = options.limit || 18;
    const plantKeys = options.plantKeys || ['ecuador', 'cocaCodoSinclair', 'paute', 'agoyan', 'minasSanFrancisco'];
    const layerConfigs: Array<{ source: SatelliteSource; layers: string }> = [
      { source: 'geoserver', layers: 'goes:goes_abi_l2_cmipf_13,ecuador:provincias' },
      { source: 'nasa_gibs', layers: 'GOES-East_ABI_Band13_Clean_Infrared' },
      { source: 'geoserver', layers: 'satellite_based_precipitation:persiann_pdir_24h,ecuador:provincias' },
      { source: 'geoserver', layers: 'wrf:wrf_precipitation_daily,ecuador:provincias' }
    ];

    setTimeout(async () => {
      systemLogger.info(`[SatelliteMapService] Starting background tile cache preload for ${layerConfigs.length} layers...`);
      try {
        const timestamps = await this.fetchGoesTimestamps({ limit });
        for (const config of layerConfigs) {
          for (const plantKey of plantKeys) {
            for (const t of timestamps) {
              try {
                await this.fetchMapTile({
                  source: config.source,
                  layers: config.layers,
                  plantKey,
                  time: t,
                  width: 800,
                  height: 800
                });
              } catch (err) {}
            }
          }
        }
        systemLogger.info(`[SatelliteMapService] Background tile cache preloading completed (${this.tileCache.size} tiles cached in RAM).`);
      } catch (err: any) {
        systemLogger.warn(`[SatelliteMapService] Background preloader warning: ${err?.message || err}`);
      }
    }, 100);
  }

  /**
   * Helper to format UTC Date into Ecuador local strings.
   */
  public formatEcuadorTimestamp(isoString: string): { dateEcuador: string; timeEcuador: string } {
    const dt = new Date(isoString);
    const ecDt = new Date(dt.getTime() - 5 * 3600 * 1000);
    const dateEcuador = ecDt.toISOString().slice(0, 10);
    const timeEcuador = ecDt.toISOString().slice(11, 16);
    return { dateEcuador, timeEcuador };
  }

  /**
   * Fetches a sequence of recent satellite frames for an area or basin.
   */
  public async fetchBasinRecentFrames(options: BasinFramesOptions = {}): Promise<SatelliteFrame[]> {
    const plantKey = options.plantKey || 'ecuador';
    const source = options.source || 'geoserver';
    const frameCount = options.frameCount || 18;
    const width = options.width || 800;
    const height = options.height || 800;
    const layers = options.layers || (source === 'nasa_gibs' ? 'GOES-East_ABI_Band13_Clean_Infrared' : 'goes:goes_abi_l2_cmipf_13,ecuador:provincias');
    const bbox = this.resolveBbox({ bbox: options.bbox, plantKey });
    const concurrency = Math.max(1, options.concurrency || 4);

    systemLogger.info(`[SatelliteMapService] Fetching ${frameCount} recent frames for ${plantKey} (source: ${source})...`);

    const timestamps = await this.fetchGoesTimestamps({ limit: frameCount });
    const frames: SatelliteFrame[] = new Array(timestamps.length);

    // Concurrently download with chunked execution
    for (let i = 0; i < timestamps.length; i += concurrency) {
      const chunk = timestamps.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (timeIso, chunkIdx) => {
          const frameIdx = i + chunkIdx;
          try {
            const buffer = await this.fetchMapTile({
              source,
              layers,
              bbox,
              time: timeIso,
              width,
              height
            });

            const { dateEcuador, timeEcuador } = this.formatEcuadorTimestamp(timeIso);

            frames[frameIdx] = {
              index: frameIdx,
              timestampIso: timeIso,
              dateEcuador,
              timeEcuador,
              buffer,
              bbox,
              plantKey,
              source
            };
          } catch (err: any) {
            systemLogger.warn(`[SatelliteMapService] Error downloading frame ${frameIdx} (${timeIso}): ${err?.message || err}`);
          }
        })
      );
    }

    // Filter out failed downloads
    const validFrames = frames.filter(Boolean);
    systemLogger.info(`[SatelliteMapService] Successfully fetched ${validFrames.length}/${timestamps.length} frames.`);
    return validFrames;
  }
}
