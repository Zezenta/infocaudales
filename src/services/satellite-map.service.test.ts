import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { SatelliteMapService } from './satellite-map.service.js';
import { BASIN_GEOMETRIES } from '../data/basin-geometries.js';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('SatelliteMapService', () => {
  let service: SatelliteMapService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SatelliteMapService();
  });

  describe('resolveBbox', () => {
    it('returns custom bbox if explicitly provided', () => {
      const customBbox: [number, number, number, number] = [-80, -4, -76, 0];
      const result = service.resolveBbox({ bbox: customBbox });
      expect(result).toEqual(customBbox);
    });

    it('resolves plant bbox from basin geometries', () => {
      const result = service.resolveBbox({ plantKey: 'cocaCodoSinclair' });
      expect(result).toEqual(BASIN_GEOMETRIES.cocaCodoSinclair.bbox);
    });

    it('defaults to Ecuador national bbox when unknown or omitted', () => {
      const result = service.resolveBbox({});
      expect(result).toEqual(BASIN_GEOMETRIES.ecuador.bbox);
    });
  });

  describe('buildWmsUrl', () => {
    it('builds valid GeoServer WMS URL with default layers and EPSG:4326', () => {
      const { url, params } = service.buildWmsUrl({
        plantKey: 'cocaCodoSinclair',
        time: '2026-09-10T20:00:00.000Z',
        width: 600,
        height: 600
      });

      expect(url).toBe('https://services.geoglows.org/geoserver/wms');
      expect(params.SERVICE).toBe('WMS');
      expect(params.VERSION).toBe('1.1.1');
      expect(params.LAYERS).toBe('goes:goes_abi_l2_cmipf_13,ecuador:provincias');
      expect(params.BBOX).toBe('-78.4,-0.8,-77.1,0.5');
      expect(params.TIME).toBe('2026-09-10T20:00:00.000Z');
      expect(params.WIDTH).toBe('600');
      expect(params.HEIGHT).toBe('600');
    });

    it('builds valid NASA GIBS WMS URL with CRS:84 / EPSG:4326', () => {
      const { url, params } = service.buildWmsUrl({
        source: 'nasa_gibs',
        plantKey: 'ecuador',
        time: '2026-09-10T20:00:00Z'
      });

      expect(url).toBe('https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi');
      expect(params.SERVICE).toBe('WMS');
      expect(params.VERSION).toBe('1.3.0');
      expect(params.LAYERS).toBe('GOES-East_ABI_Band13_Clean_Infrared');
      expect(params.TIME).toBe('2026-09-10T20:00:00Z');
    });
  });

  describe('generateFallbackTimestamps', () => {
    it('generates chronological 10-minute timestamps', () => {
      const timestamps = service.generateFallbackTimestamps(6, 10);
      expect(timestamps).toHaveLength(6);

      const t0 = new Date(timestamps[0]).getTime();
      const t1 = new Date(timestamps[1]).getTime();
      expect(t1 - t0).toBe(10 * 60 * 1000);
    });
  });

  describe('formatEcuadorTimestamp', () => {
    it('correctly converts UTC ISO string to Ecuador local time (UTC-5)', () => {
      const iso = '2026-09-11T03:30:00.000Z'; // 03:30 UTC = 22:30 ECT previous day
      const { dateEcuador, timeEcuador } = service.formatEcuadorTimestamp(iso);

      expect(dateEcuador).toBe('2026-09-10');
      expect(timeEcuador).toBe('22:30');
    });
  });

  describe('fetchGoesTimestamps', () => {
    it('parses timestamps from GeoServer XML GetCapabilities', async () => {
      const mockXml = `
        <WMT_MS_Capabilities version="1.1.1">
          <Capability>
            <Layer>
              <Extent name="time" default="2026-09-10T22:00:00.000Z">
                2026-09-10T20:00:00.000Z,2026-09-10T21:00:00.000Z,2026-09-10T22:00:00.000Z
              </Extent>
            </Layer>
          </Capability>
        </WMT_MS_Capabilities>
      `;

      mockedAxios.get.mockResolvedValueOnce({ status: 200, data: mockXml });

      const timestamps = await service.fetchGoesTimestamps({ limit: 2 });
      expect(timestamps).toEqual(['2026-09-10T21:00:00.000Z', '2026-09-10T22:00:00.000Z']);
    });

    it('falls back gracefully to synthetic timestamps on network error', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));

      const timestamps = await service.fetchGoesTimestamps({ limit: 5 });
      expect(timestamps).toHaveLength(5);
    });
  });

  describe('fetchBasinRecentFrames', () => {
    it('downloads frames and formats them with Ecuador time', async () => {
      const mockXml = `
        <Extent name="time">2026-09-11T03:00:00.000Z,2026-09-11T03:10:00.000Z</Extent>
      `;
      mockedAxios.get.mockResolvedValueOnce({ status: 200, data: mockXml });

      // Mock valid image buffer response (PNG header)
      const fakeImageBuf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
      mockedAxios.get.mockResolvedValue({ status: 200, data: fakeImageBuf });

      const frames = await service.fetchBasinRecentFrames({
        plantKey: 'cocaCodoSinclair',
        frameCount: 2
      });

      expect(frames).toHaveLength(2);
      expect(frames[0].plantKey).toBe('cocaCodoSinclair');
      expect(frames[0].buffer).toEqual(fakeImageBuf);
      expect(frames[0].timeEcuador).toBe('22:00');
      expect(frames[1].timeEcuador).toBe('22:10');
    });
  });
});
