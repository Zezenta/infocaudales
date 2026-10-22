import { execFile } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { hydroelectricPlants } from '../data/hydroelectric-plants.js';
import { BASIN_GEOMETRIES, ALL_HYDRO_PLANTS_PINS, DEFAULT_REFERENCE_CITIES } from '../data/basin-geometries.js';
import { SatelliteTelemetryService, SatelliteMapService } from '../services/telemetry/satellite-telemetry.service.js';
import { SatelliteArchiverService } from '../services/satellite/satellite-archiver.service.js';
import { VideoCompilerService } from '../services/satellite/video-compiler.service.js';
import { RainMonitorService } from '../services/satellite/rain-monitor.service.js';
import { db } from '../utils/db.js';
import { fetchCoverLiveData, fetchTelemetry } from '../services/telemetry/live-telemetry.service.js';

const execFileAsync = promisify(execFile);

const PORT = 3000;
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');
const HTML_FILE = path.join(TEMPLATE_DIR, 'hydro-card.html');
const CSS_FILE = path.join(TEMPLATE_DIR, 'hydro-card.css');

const satelliteMapService = new SatelliteMapService();
const satelliteArchiverService = new SatelliteArchiverService(satelliteMapService);
const videoCompilerService = new VideoCompilerService(satelliteMapService);
const rainMonitorService = new RainMonitorService(satelliteMapService, videoCompilerService);

// Preload recent frames in RAM cache in the background
satelliteMapService.preloadAllOptionsBackground();

// Keep track of active SSE connections
const clients: Set<http.ServerResponse> = new Set();

// Persistent Satellite Frame Metrics Table for instant Visualizer playback
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS satellite_frame_metrics (
      timestamp_iso TEXT PRIMARY KEY,
      ccs REAL NOT NULL,
      paute REAL NOT NULL,
      costa REAL NOT NULL,
      sierra REAL NOT NULL,
      amazonia REAL NOT NULL,
      computed_at INTEGER NOT NULL
    );
  `);
} catch (err) {}

function getOrComputeMetricsForRows(rows: Array<{ timestamp_iso: string; file_path: string; source?: string }>): Record<string, { ccs: number; paute: number; costa: number; sierra: number; amazonia: number }> {
  const result: Record<string, any> = {};
  if (!rows || rows.length === 0) return result;

  const placeholders = rows.map(() => '?').join(',');
  let cachedRows: any[] = [];
  try {
    cachedRows = db.prepare(`SELECT * FROM satellite_frame_metrics WHERE timestamp_iso IN (${placeholders})`).all(...rows.map(r => r.timestamp_iso)) as any[];
  } catch (err) {}

  const cachedMap = new Map<string, any>();
  for (const c of cachedRows) {
    cachedMap.set(c.timestamp_iso, { ccs: c.ccs, paute: c.paute, costa: c.costa, sierra: c.sierra, amazonia: c.amazonia });
  }

  const insertStmt = db.prepare(`
    INSERT INTO satellite_frame_metrics (timestamp_iso, ccs, paute, costa, sierra, amazonia, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(timestamp_iso) DO UPDATE SET
      ccs = excluded.ccs, paute = excluded.paute, costa = excluded.costa, sierra = excluded.sierra, amazonia = excluded.amazonia
  `);

  for (const r of rows) {
    if (cachedMap.has(r.timestamp_iso)) {
      result[r.timestamp_iso] = cachedMap.get(r.timestamp_iso);
      continue;
    }

    if (r.file_path && fs.existsSync(r.file_path)) {
      try {
        const buf = fs.readFileSync(r.file_path);
        const m = rainMonitorService.computeEcuadorFrameMetrics(buf, (r.source as any) || 'geoserver');
        insertStmt.run(r.timestamp_iso, m.ccs, m.paute, m.costa, m.sierra, m.amazonia, Date.now());
        result[r.timestamp_iso] = m;
      } catch (err) {
        result[r.timestamp_iso] = { ccs: 0, paute: 0, costa: 0, sierra: 0, amazonia: 0 };
      }
    } else {
      result[r.timestamp_iso] = { ccs: 0, paute: 0, costa: 0, sierra: 0, amazonia: 0 };
    }
  }

  return result;
}

function getMetricsMapForTimestamps(timestamps: string[]): Record<string, { ccs: number; paute: number; costa: number; sierra: number; amazonia: number }> {
  const metricsMap: Record<string, any> = {};
  if (!timestamps || timestamps.length === 0) return metricsMap;
  try {
    const placeholders = timestamps.map(() => '?').join(',');
    const metricRows = db.prepare(`
      SELECT timestamp_iso, ccs, paute, costa, sierra, amazonia
      FROM satellite_frame_metrics
      WHERE timestamp_iso IN (${placeholders})
    `).all(...timestamps) as any[];
    for (const mr of metricRows) {
      metricsMap[mr.timestamp_iso] = mr;
    }
  } catch (e) {}
  return metricsMap;
}

let isSyncingFrames = false;
async function syncRecentVisualizerFrames(source: 'geoserver' | 'nasa_gibs' = 'geoserver'): Promise<void> {
  if (isSyncingFrames) return;
  isSyncingFrames = true;
  try {
    await satelliteArchiverService.archiveLatestFrames({ limit: 18, plantKey: 'ecuador', source });

    // Compute metrics for any frames in today's archive that don't yet have metrics
    const uncomputed = db.prepare(`
      SELECT a.timestamp_iso, a.file_path, a.source
      FROM satellite_archive a
      LEFT JOIN satellite_frame_metrics m ON a.timestamp_iso = m.timestamp_iso
      WHERE a.date_ecuador = date('now', '-5 hours') AND a.source = ? AND m.timestamp_iso IS NULL
    `).all(source) as Array<{ timestamp_iso: string; file_path: string; source?: string }>;

    for (const row of uncomputed) {
      if (fs.existsSync(row.file_path)) {
        try {
          const buf = fs.readFileSync(row.file_path);
          const metrics = rainMonitorService.computeEcuadorFrameMetrics(buf, (row.source as any) || source);
          db.prepare(`
            INSERT INTO satellite_frame_metrics (timestamp_iso, ccs, paute, costa, sierra, amazonia, computed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(timestamp_iso) DO UPDATE SET
              ccs = excluded.ccs, paute = excluded.paute, costa = excluded.costa, sierra = excluded.sierra, amazonia = excluded.amazonia
          `).run(row.timestamp_iso, metrics.ccs, metrics.paute, metrics.costa, metrics.sierra, metrics.amazonia, Date.now());
        } catch (e) {}
      }
    }
  } catch (err: any) {
    console.warn('[Visualizer] Warning syncing recent frames:', err?.message || err);
  } finally {
    isSyncingFrames = false;
  }
}

function generatePlantsConfigScript() {
  const plantsData: Record<string, any> = {};
  const turbineLayouts: Record<string, any> = {};

  for (const [key, plant] of Object.entries(hydroelectricPlants)) {
    if (!plant.visualData) continue;
    const phys = plant.physicalData || {};
    const vis = plant.visualData;

    plantsData[key] = {
      name: plant.name,
      maxEnergyMW: phys.maxEnergyMW,
      maxTurbines: phys.maxTurbines,
      maxFlowM3s: phys.maxFlowM3s,
      minLevelMasl: phys.minLevelMasl,
      maxLevelMasl: phys.maxLevelMasl,
      defaultGen: vis.defaultGen,
      defaultTurbines: vis.defaultTurbines,
      defaultFlow: vis.defaultFlow,
      defaultCota: vis.defaultCota,
      drawingImage: vis.drawingImage,
      flowThresholds: phys.flowThresholds,
    };

    if (vis.turbineGrid) {
      turbineLayouts[key] = {
        rows: vis.turbineGrid.rows,
        cols: vis.turbineGrid.cols,
        type: phys.turbineType || 'Francis',
        width: vis.turbineGrid.width,
        height: vis.turbineGrid.height
      };
    }
  }

  return `window.plantsData = ${JSON.stringify(plantsData, null, 2)};\nwindow.turbineLayouts = ${JSON.stringify(turbineLayouts, null, 2)};`;
}

const server = http.createServer(async (req, res) => {
  // Ignore favicon requests
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve dynamic plants configuration script
  if (req.url === '/api/plants-config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(generatePlantsConfigScript());
    return;
  }
  // Handle SSE endpoint
  if (req.url === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    
    // Add client to active pool
    clients.add(res);
    
    // Send initial ping/connection check
    res.write('data: connected\n\n');
    
    req.on('close', () => {
      clients.delete(res);
    });
    return;
  }

  // Handle PNG generation endpoint
  if (req.method === 'POST' && req.url === '/generate-report') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { filename, imageData } = payload;
        
        // Remove data URL prefix (e.g. data:image/png;base64,)
        const base64Data = imageData.replace(/^data:image\/png;base64,/, "");
        
        // Ensure /generated folder exists
        const generatedDir = path.join(__dirname, '..', '..', 'generated');
        if (!fs.existsSync(generatedDir)) {
          fs.mkdirSync(generatedDir, { recursive: true });
        }
        
        const filePath = path.join(generatedDir, filename);
        fs.writeFile(filePath, base64Data, 'base64', (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
            return;
          }
          console.log(`[Visualizer] Saved report: ${filePath}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, filePath }));
        });
      } catch (error: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // Handle Save Configuration endpoint
  if (req.method === 'POST' && req.url === '/api/save-config') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const configPath = path.join(__dirname, '..', '..', 'hydro-configs.json');
        
        fs.writeFile(configPath, JSON.stringify(payload, null, 2), 'utf8', (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
            return;
          }
          console.log(`[Visualizer] Saved configs to: ${configPath}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        });
      } catch (error: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // Handle Load Configuration endpoint
  if (req.method === 'GET' && req.url === '/api/load-config') {
    const configPath = path.join(__dirname, '..', '..', 'hydro-configs.json');
    if (!fs.existsSync(configPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Configuration file not found' }));
      return;
    }

    fs.readFile(configPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: JSON.parse(data) }));
    });
    return;
  }

  // Cover Live Data API (Parallel fetch across CELEC & CENACE for all 6 plants)
  if (req.method === 'GET' && req.url === '/api/cover-live-data') {
    try {
      console.log('[Visualizer] Querying live telemetry for cover from CELEC & CENACE...');
      const data = await fetchCoverLiveData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      console.error('[Visualizer] Error fetching cover live data:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // Single Plant Live Telemetry API
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/plant-telemetry')) {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const plantKey = urlObj.searchParams.get('plant') || 'cocaCodoSinclair';
      console.log(`[Visualizer] Querying live telemetry for plant ${plantKey}...`);
      const telemetry = await fetchTelemetry(plantKey, false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, plantKey, telemetry }));
    } catch (err: any) {
      console.error('[Visualizer] Error fetching plant live telemetry:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }
  
  // Basin Geometries API
  if (req.method === 'GET' && req.url === '/api/basin-geometries') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(BASIN_GEOMETRIES));
    return;
  }

  // All Hydroelectric Plants Pins API
  if (req.method === 'GET' && req.url === '/api/all-hydro-pins') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ALL_HYDRO_PLANTS_PINS));
    return;
  }

  // Satellite Timestamps API
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/satellite-timestamps')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const limit = parseInt(urlObj.searchParams.get('limit') || '18', 10);

    satelliteMapService.fetchGoesTimestamps({ limit })
      .then(timestamps => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ timestamps }));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }


  // Reference Cities Pins API (Quito, Guayaquil, Cuenca, etc.)
  if (req.method === 'GET' && req.url === '/api/reference-cities') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(DEFAULT_REFERENCE_CITIES));
    return;
  }

  // Satellite Archive Presets API
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/archive-presets')) {
    try {
      const presets = [
        { id: 'live_nasa_12h', name: 'NASA GIBS: Últimas 12 Horas Directo (72 fotogramas continuos)', source: 'nasa_gibs' },
        { id: 'live_nasa_6h', name: 'NASA GIBS: Últimas 6 Horas Directo (36 fotogramas continuos)', source: 'nasa_gibs' },
        { id: 'live_nasa_24h', name: 'NASA GIBS: Últimas 24 Horas Directo (144 fotogramas continuos)', source: 'nasa_gibs' },
        { id: 'today_nasa', name: 'NASA GIBS: Resumen de Hoy (desde 00:00 ECT)', source: 'nasa_gibs' },
        { id: 'live_geoserver', name: 'GEOGLOWS / INAMHI: En Vivo Directo (~3.5 horas máx)', source: 'geoserver' },
        { id: 'today', name: 'GEOGLOWS: Resumen de Hoy en Disco (desde 00:00 ECT)', source: 'geoserver' },
        { id: 'yesterday_24h', name: 'GEOGLOWS: Resumen 24h Ayer (11 de Octubre • 133 fotogramas)', source: 'geoserver' },
        { id: 'storm_paute_oct7', name: 'GEOGLOWS: Tormenta Severa en Paute (07-08 Oct • 37 fotogramas)', source: 'geoserver' },
        { id: 'storm_ccs_oct7', name: 'GEOGLOWS: Tormenta Coca Codo Sinclair (07 Oct • 31 fotogramas)', source: 'geoserver' },
        { id: 'recent_50', name: 'GEOGLOWS: Últimos 50 fotogramas archivados', source: 'geoserver' },
        { id: 'all_frames', name: 'GEOGLOWS: Archivo Histórico Completo', source: 'geoserver' }
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ presets }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Satellite Timestamps by Preset API (strictly segregated by source)
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/archive-timestamps')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const preset = urlObj.searchParams.get('preset') || 'today';
    const layer = urlObj.searchParams.get('layer') || undefined;
    const requestedSource = urlObj.searchParams.get('source');
    const isNasa = requestedSource === 'nasa_gibs' || layer === 'nasa_gibs' || preset.startsWith('live_nasa_') || preset === 'today_nasa';
    const effectiveSource: 'nasa_gibs' | 'geoserver' = isNasa ? 'nasa_gibs' : 'geoserver';

    try {
      if (effectiveSource === 'nasa_gibs') {
        if (preset === 'live_nasa_6h') {
          const timestamps = await satelliteMapService.fetchGoesTimestamps({ limit: 36, source: 'nasa_gibs' });
          const metricsMap = getMetricsMapForTimestamps(timestamps);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ timestamps, metrics: metricsMap }));
          return;
        } else if (preset === 'live_nasa_12h') {
          const timestamps = await satelliteMapService.fetchGoesTimestamps({ limit: 72, source: 'nasa_gibs' });
          const metricsMap = getMetricsMapForTimestamps(timestamps);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ timestamps, metrics: metricsMap }));
          return;
        } else if (preset === 'live_nasa_24h') {
          const timestamps = await satelliteMapService.fetchGoesTimestamps({ limit: 144, source: 'nasa_gibs' });
          const metricsMap = getMetricsMapForTimestamps(timestamps);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ timestamps, metrics: metricsMap }));
          return;
        } else if (preset === 'today' || preset === 'live_today' || preset === 'today_nasa') {
          // Generate 10-minute cadence starting from 00:00 ECT today (05:00 UTC) up to now
          const nowMs = Date.now();
          const latestAvailableMs = Math.floor((nowMs - 10 * 60 * 1000) / (10 * 60 * 1000)) * (10 * 60 * 1000);
          const ecDt = new Date(nowMs - 5 * 3600 * 1000);
          const dateEcuadorStr = ecDt.toISOString().slice(0, 10);
          const startOfTodayUtcMs = new Date(`${dateEcuadorStr}T05:00:00.000Z`).getTime();

          const timestamps: string[] = [];
          if (latestAvailableMs >= startOfTodayUtcMs) {
            for (let t = startOfTodayUtcMs; t <= latestAvailableMs; t += 10 * 60 * 1000) {
              timestamps.push(new Date(t).toISOString());
            }
          }
          if (timestamps.length < 6) {
            const fallback = await satelliteMapService.fetchGoesTimestamps({ limit: 18, source: 'nasa_gibs' });
            timestamps.push(...fallback);
          }

          const metricsMap: Record<string, any> = {};
          if (timestamps.length > 0) {
            try {
              const placeholders = timestamps.map(() => '?').join(',');
              const metricRows = db.prepare(`
                SELECT timestamp_iso, ccs, paute, costa, sierra, amazonia
                FROM satellite_frame_metrics
                WHERE timestamp_iso IN (${placeholders})
              `).all(...timestamps) as any[];
              for (const mr of metricRows) {
                metricsMap[mr.timestamp_iso] = mr;
              }
            } catch (e) {}
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ timestamps, metrics: metricsMap }));
          return;
        } else if (preset === 'yesterday_24h') {
          const nowMs = Date.now();
          const ecDt = new Date(nowMs - 5 * 3600 * 1000);
          const yesterdayEcDt = new Date(ecDt.getTime() - 24 * 3600 * 1000);
          const yDateStr = yesterdayEcDt.toISOString().slice(0, 10);
          const startUtcMs = new Date(`${yDateStr}T05:00:00.000Z`).getTime();
          const endUtcMs = startUtcMs + 24 * 3600 * 1000 - 10 * 60 * 1000;

          const timestamps: string[] = [];
          for (let t = startUtcMs; t <= endUtcMs; t += 10 * 60 * 1000) {
            timestamps.push(new Date(t).toISOString());
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ timestamps, metrics: {} }));
          return;
        } else if (preset === 'recent_50') {
          const timestamps = await satelliteMapService.fetchGoesTimestamps({ limit: 50, source: 'nasa_gibs' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ timestamps, metrics: {} }));
          return;
        } else {
          const timestamps = await satelliteMapService.fetchGoesTimestamps({ limit: 36, source: 'nasa_gibs' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ timestamps, metrics: {} }));
          return;
        }
      }

      // GEOGLOWS / GeoServer queries: ONLY query source = 'geoserver'
      let rows: Array<{ timestamp_iso: string; file_path: string; source?: string }> = [];

      if (preset === 'today' || preset === 'live_today') {
        await syncRecentVisualizerFrames('geoserver');

        rows = db.prepare(`
          SELECT timestamp_iso, file_path, source FROM satellite_archive
          WHERE date_ecuador = date('now', '-5 hours') AND source = 'geoserver'
          ORDER BY timestamp_iso ASC
        `).all() as any[];

        if (rows.length < 6) {
          // Early morning fallback: include frames from last 20 hours
          rows = db.prepare(`
            SELECT timestamp_iso, file_path, source FROM satellite_archive
            WHERE timestamp_iso >= datetime('now', '-5 hours', '-20 hours') AND source = 'geoserver'
            ORDER BY timestamp_iso ASC
          `).all() as any[];
        }
      } else if (preset === 'yesterday_24h') {
        rows = db.prepare(`
          SELECT timestamp_iso, file_path, source FROM satellite_archive
          WHERE date_ecuador = date('now', '-5 hours', '-1 day') AND source = 'geoserver'
          ORDER BY timestamp_iso ASC
        `).all() as any[];
      } else if (preset === 'storm_paute_oct7') {
        rows = db.prepare(`
          SELECT timestamp_iso, file_path, source FROM satellite_archive
          WHERE timestamp_iso >= '2026-10-07T23:30:00.000Z' AND timestamp_iso <= '2026-10-08T05:30:00.000Z'
            AND source = 'geoserver'
          ORDER BY timestamp_iso ASC
        `).all() as any[];
      } else if (preset === 'storm_ccs_oct7') {
        rows = db.prepare(`
          SELECT timestamp_iso, file_path, source FROM satellite_archive
          WHERE timestamp_iso >= '2026-10-07T17:30:00.000Z' AND timestamp_iso <= '2026-10-07T22:30:00.000Z'
            AND source = 'geoserver'
          ORDER BY timestamp_iso ASC
        `).all() as any[];
      } else if (preset === 'recent_50') {
        const recentRows = db.prepare(`
          SELECT timestamp_iso, file_path, source FROM satellite_archive
          WHERE source = 'geoserver'
          ORDER BY timestamp_iso DESC LIMIT 50
        `).all() as any[];
        rows = recentRows.reverse();
      } else if (preset === 'all_frames' || preset === 'all_966') {
        rows = db.prepare(`
          SELECT timestamp_iso, file_path, source FROM satellite_archive
          WHERE source = 'geoserver'
          ORDER BY timestamp_iso ASC
        `).all() as any[];
      } else if (preset === 'live_geoserver' || preset === 'live') {
        // live GeoServer GetCapabilities (last 18-22 available frames, ~3.5h)
        const timestamps = await satelliteMapService.fetchGoesTimestamps({ limit: 22, source: 'geoserver' });
        const metricsMap = getMetricsMapForTimestamps(timestamps);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ timestamps, metrics: metricsMap }));
        return;
      } else {
        const timestamps = await satelliteMapService.fetchGoesTimestamps({ limit: 18, source: 'geoserver' });
        const metricsMap = getMetricsMapForTimestamps(timestamps);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ timestamps, metrics: metricsMap }));
        return;
      }

      const metricsMap = getOrComputeMetricsForRows(rows);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        timestamps: rows.map(r => r.timestamp_iso),
        metrics: metricsMap
      }));
    } catch (err: any) {
      console.error('[Visualizer] Error loading archive timestamps:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Provincial Boundaries Overlay Image API
  if (req.method === 'GET' && (req.url === '/api/provincias-overlay' || req.url === '/assets/overlays/ecuador_provincias_800.png')) {
    const candidates = [
      path.join(__dirname, '..', 'assets', 'overlays', 'ecuador_provincias_800.png'),
      path.join(process.cwd(), 'src', 'assets', 'overlays', 'ecuador_provincias_800.png')
    ];
    let overlayPath: string | null = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        overlayPath = c;
        break;
      }
    }

    if (!overlayPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Overlay not found');
      return;
    }

    fs.readFile(overlayPath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading overlay');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(data);
    });
    return;
  }

  // Hydroelectric Basin Polygons Vector API (From INAMHI/GEOGLOWS GeoServer WFS)
  if (req.method === 'GET' && (req.url === '/api/basin-polygons' || req.url?.startsWith('/api/basin-polygons?'))) {
    const jsonPath = path.join(process.cwd(), 'src', 'data', 'basin-svg-paths.json');
    if (fs.existsSync(jsonPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      fs.createReadStream(jsonPath).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Basin polygons not found' }));
    return;
  }

  // Provincial Boundaries Vector Overlay API (Clean SVG vector paths)
  if (req.method === 'GET' && (req.url?.startsWith('/api/provincias-vector') || req.url?.startsWith('/assets/overlays/ecuador_provincias.svg'))) {
    const candidates = [
      path.join(__dirname, '..', 'assets', 'overlays', 'ecuador_provincias.svg'),
      path.join(process.cwd(), 'src', 'assets', 'overlays', 'ecuador_provincias.svg')
    ];
    let svgPath: string | null = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        svgPath = c;
        break;
      }
    }

    if (!svgPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Vector overlay not found');
      return;
    }

    fs.readFile(svgPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading vector overlay');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(data);
    });
    return;
  }

  // GeoServer Provincial Delineation Differential Reference PNG API
  if (req.method === 'GET' && (req.url?.startsWith('/api/geoserver-provinces-diff') || req.url === '/assets/overlays/geoserver_provinces_differential.png')) {
    const candidates = [
      path.join(__dirname, '..', 'assets', 'overlays', 'geoserver_provinces_differential.png'),
      path.join(process.cwd(), 'src', 'assets', 'overlays', 'geoserver_provinces_differential.png')
    ];
    let diffPath: string | null = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        diffPath = c;
        break;
      }
    }
    if (!diffPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Differential PNG not found');
      return;
    }
    fs.readFile(diffPath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading differential PNG');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(data);
    });
    return;
  }

  // GeoServer Provincial Delineation Clean White PNG API
  if (req.method === 'GET' && (req.url?.startsWith('/api/geoserver-provinces-clean') || req.url === '/assets/overlays/geoserver_provincias_clean_white.png')) {
    const candidates = [
      path.join(__dirname, '..', 'assets', 'overlays', 'geoserver_provincias_clean_white.png'),
      path.join(process.cwd(), 'src', 'assets', 'overlays', 'geoserver_provincias_clean_white.png')
    ];
    let cleanPath: string | null = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        cleanPath = c;
        break;
      }
    }
    if (!cleanPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Clean white provincias PNG not found');
      return;
    }
    fs.readFile(cleanPath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading clean white provincias PNG');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(data);
    });
    return;
  }

  // GeoServer Normal Satellite Frame with Provincial Delineation
  if (req.method === 'GET' && (req.url?.startsWith('/api/geoserver-normal-frame') || req.url === '/assets/overlays/geoserver_provinces_normal_frame.png')) {
    const candidates = [
      path.join(__dirname, '..', 'assets', 'overlays', 'geoserver_provinces_normal_frame.png'),
      path.join(process.cwd(), 'src', 'assets', 'overlays', 'geoserver_provinces_normal_frame.png')
    ];
    let framePath: string | null = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        framePath = c;
        break;
      }
    }
    if (!framePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Normal frame not found');
      return;
    }
    fs.readFile(framePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading normal frame');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(data);
    });
    return;
  }

  // GeoServer Provincial Direct Transparent WMS PNG API
  if (req.method === 'GET' && (req.url?.startsWith('/api/geoserver-provinces-direct') || req.url === '/assets/overlays/geoserver_provincias_direct.png')) {
    const candidates = [
      path.join(__dirname, '..', 'assets', 'overlays', 'geoserver_provincias_direct.png'),
      path.join(process.cwd(), 'src', 'assets', 'overlays', 'geoserver_provincias_direct.png')
    ];
    let directPath: string | null = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        directPath = c;
        break;
      }
    }
    if (!directPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Direct provincias PNG not found');
      return;
    }
    fs.readFile(directPath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading direct provincias PNG');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(data);
    });
    return;
  }

  // Satellite Single Frame Proxy API (handles CORS, local archive & layers)
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/satellite-frame')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const time = urlObj.searchParams.get('time') || undefined;
    const plantKey = urlObj.searchParams.get('plantKey') || 'ecuador';
    const layer = urlObj.searchParams.get('layer') || 'goes16_inamhi';
    const width = parseInt(urlObj.searchParams.get('width') || '800', 10);
    const height = parseInt(urlObj.searchParams.get('height') || '800', 10);
    const unbaked = urlObj.searchParams.get('unbaked') === 'true';

    // Fast path: Check local satellite archive if layer matches archived frame or is default IR on ecuador
    if (plantKey === 'ecuador' && time && (layer === 'goes16_inamhi' || layer === 'nasa_gibs')) {
      try {
        let archiveSource = 'geoserver';
        if (layer === 'nasa_gibs') {
          archiveSource = 'nasa_gibs';
        } else if (unbaked) {
          archiveSource = 'geoserver_clean';
        }
        const query = "SELECT file_path, source FROM satellite_archive WHERE timestamp_iso = ? AND source = ?";
        const row = db.prepare(query).get(time, archiveSource) as { file_path: string; source?: string } | undefined;

        if (row && fs.existsSync(row.file_path)) {
          fs.readFile(row.file_path, (err, buffer) => {
            if (!err && buffer) {
              res.writeHead(200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'no-cache, must-revalidate'
              });
              res.end(buffer);
            } else {
              res.writeHead(500, { 'Content-Type': 'text/plain' });
              res.end('Error reading local archived frame');
            }
          });
          return;
        }
      } catch (dbErr) {
        // Fallback to network fetch if db fails
      }
    }

    let source: 'geoserver' | 'nasa_gibs' | 'esri_satellite' = 'geoserver';
    let layers: string | undefined = undefined;

    if (layer === 'esri_satellite') {
      source = 'esri_satellite';
    } else if (layer === 'blue_marble') {
      source = 'nasa_gibs';
      layers = 'BlueMarble_NextGeneration';
    } else if (layer === 'nasa_gibs') {
      source = 'nasa_gibs';
      layers = 'GOES-East_ABI_Band13_Clean_Infrared';
    } else if (layer === 'persiann_24h') {
      layers = unbaked ? 'satellite_based_precipitation:persiann_pdir_24h' : 'satellite_based_precipitation:persiann_pdir_24h,ecuador:provincias';
    } else if (layer === 'wrf_daily') {
      layers = unbaked ? 'wrf:wrf_precipitation_daily' : 'wrf:wrf_precipitation_daily,ecuador:provincias';
    } else {
      layers = unbaked ? 'goes:goes_abi_l2_cmipf_13' : 'goes:goes_abi_l2_cmipf_13,ecuador:provincias';
    }

    satelliteMapService.fetchMapTile({
      source,
      layers,
      plantKey,
      time,
      width,
      height,
      unbaked
    })
      .then(async buffer => {
        // Cache clean raw NASA frame to disk archive for instant future scrubs & compilation
        if (time && layer === 'nasa_gibs' && plantKey === 'ecuador' && buffer && buffer.length > 0) {
          try {
            const { dateEcuador, timeEcuador } = satelliteMapService.formatEcuadorTimestamp(time);
            const yearMonth = dateEcuador.slice(0, 7);
            const targetSubdir = path.join(process.cwd(), 'data', 'satellite_archive', yearMonth);
            if (!fs.existsSync(targetSubdir)) fs.mkdirSync(targetSubdir, { recursive: true });
            const safeTs = time.replace(/[^a-zA-Z0-9_-]/g, '_');
            const cachedFilePath = path.join(targetSubdir, `goes16_nasa_gibs_${plantKey}_${safeTs}.png`);
            if (!fs.existsSync(cachedFilePath)) {
              fs.writeFileSync(cachedFilePath, buffer);
              db.prepare(`
                INSERT INTO satellite_archive (
                  timestamp_iso, date_ecuador, time_ecuador, plant_key,
                  file_path, file_size_bytes, recorded_at, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'nasa_gibs')
                ON CONFLICT(timestamp_iso, source) DO UPDATE SET
                  file_path = excluded.file_path,
                  file_size_bytes = excluded.file_size_bytes,
                  recorded_at = excluded.recorded_at
              `).run(time, dateEcuador, timeEcuador, plantKey, cachedFilePath, buffer.length, Date.now());
            }
          } catch (cacheErr) {}
        }

        // Cache clean raw GeoServer unbaked frame to disk archive for instant future scrubs & compilation
        if (time && layer === 'goes16_inamhi' && unbaked && plantKey === 'ecuador' && buffer && buffer.length > 0) {
          try {
            const { dateEcuador, timeEcuador } = satelliteMapService.formatEcuadorTimestamp(time);
            const yearMonth = dateEcuador.slice(0, 7);
            const targetSubdir = path.join(process.cwd(), 'data', 'satellite_archive', yearMonth);
            if (!fs.existsSync(targetSubdir)) fs.mkdirSync(targetSubdir, { recursive: true });
            const safeTs = time.replace(/[^a-zA-Z0-9_-]/g, '_');
            const cachedFilePath = path.join(targetSubdir, `goes16_geoserver_clean_${plantKey}_${safeTs}.png`);
            if (!fs.existsSync(cachedFilePath)) {
              fs.writeFileSync(cachedFilePath, buffer);
              db.prepare(`
                INSERT INTO satellite_archive (
                  timestamp_iso, date_ecuador, time_ecuador, plant_key,
                  file_path, file_size_bytes, recorded_at, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'geoserver_clean')
                ON CONFLICT(timestamp_iso, source) DO UPDATE SET
                  file_path = excluded.file_path,
                  file_size_bytes = excluded.file_size_bytes,
                  recorded_at = excluded.recorded_at
              `).run(time, dateEcuador, timeEcuador, plantKey, cachedFilePath, buffer.length, Date.now());
            }
          } catch (cacheErr) {}
        }

        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-cache, must-revalidate'
        });
        res.end(buffer);
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error loading satellite frame: ${err.message}`);
      });
    return;
  }

  // Compile Rain Video on demand API (strictly isolated by source)
  if (req.method === 'POST' && req.url === '/api/compile-rain-video') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const plantKey = payload.plantKey || 'ecuador';
        const createMp4 = payload.createMp4 !== false;
        const createGif = payload.createGif !== false;
        const framerate = payload.framerate || 8;
        const customTitle = payload.customTitle || 'Vista Satelital En Vivo';
        const customBadge = payload.customBadge;
        const pinLabel = payload.pinLabel;
        const showSinglePin = payload.showSinglePin;
        const showAllPins = payload.showAllPins;
        const layer = payload.layer || 'goes16_inamhi';
        const isNasa = layer === 'nasa_gibs';
        const targetSource: 'nasa_gibs' | 'geoserver' = isNasa ? 'nasa_gibs' : 'geoserver';
        const showThermalScale = layer === 'goes16_inamhi' || layer === 'nasa_gibs';
        const is916 = payload.aspectRatio !== '1:1';
        const showProvinces = payload.showProvinces !== undefined
          ? payload.showProvinces
          : (payload.useVectorProvinces !== undefined ? payload.useVectorProvinces : true);
        const showGeoserverProvinces = payload.showGeoserverProvinces !== undefined
          ? payload.showGeoserverProvinces
          : (payload.unbakedProvinces !== undefined ? !payload.unbakedProvinces : false);
        const unbakedProvinces = !showGeoserverProvinces;
        const useVectorProvinces = showProvinces;

        console.log(`[Visualizer] Compiling rain animation for ${plantKey} (preset: ${payload.preset || 'live'}, layer: ${layer}, source: ${targetSource}, vectorProvinces: ${useVectorProvinces}, unbaked: ${unbakedProvinces}, title: "${customTitle}")...`);
        const showSummaryCards = payload.showSummaryCards !== false && plantKey === 'ecuador';

        const preset = payload.preset || 'live';
        let diskFrames: any[] = [];
        let liveFrameCount: number | undefined = undefined;

        const archiveSource = (unbakedProvinces && targetSource === 'geoserver') ? 'geoserver_clean' : targetSource;

        if (preset === 'live_nasa_6h') {
          liveFrameCount = 36;
        } else if (preset === 'live_nasa_12h') {
          liveFrameCount = 72;
        } else if (preset === 'live_nasa_24h') {
          liveFrameCount = 144;
        } else if (preset === 'live_geoserver' || preset === 'live') {
          liveFrameCount = 22;
        } else if (preset && !preset.startsWith('live_nasa_')) {
          let rows: any[] = [];
          if (preset === 'today' || preset === 'live_today' || preset === 'today_nasa') {
            rows = db.prepare(`SELECT timestamp_iso, file_path, source FROM satellite_archive WHERE date_ecuador = date('now', '-5 hours') AND source = ? ORDER BY timestamp_iso ASC`).all(archiveSource) as any[];
            if (rows.length < 6) {
              rows = db.prepare(`SELECT timestamp_iso, file_path, source FROM satellite_archive WHERE timestamp_iso >= datetime('now', '-5 hours', '-20 hours') AND source = ? ORDER BY timestamp_iso ASC`).all(archiveSource) as any[];
            }
          } else if (preset === 'yesterday_24h') {
            rows = db.prepare(`SELECT timestamp_iso, file_path, source FROM satellite_archive WHERE date_ecuador = date('now', '-5 hours', '-1 day') AND source = ? ORDER BY timestamp_iso ASC`).all(archiveSource) as any[];
          } else if (preset === 'storm_paute_oct7') {
            rows = db.prepare(`SELECT timestamp_iso, file_path, source FROM satellite_archive WHERE timestamp_iso >= '2026-10-07T23:30:00.000Z' AND timestamp_iso <= '2026-10-08T05:30:00.000Z' AND source = ? ORDER BY timestamp_iso ASC`).all(archiveSource) as any[];
          } else if (preset === 'storm_ccs_oct7') {
            rows = db.prepare(`SELECT timestamp_iso, file_path, source FROM satellite_archive WHERE timestamp_iso >= '2026-10-07T17:30:00.000Z' AND timestamp_iso <= '2026-10-07T22:30:00.000Z' AND source = ? ORDER BY timestamp_iso ASC`).all(archiveSource) as any[];
          } else if (preset === 'recent_50') {
            const recent = db.prepare(`SELECT timestamp_iso, file_path, source FROM satellite_archive WHERE source = ? ORDER BY timestamp_iso DESC LIMIT 50`).all(archiveSource) as any[];
            rows = recent.reverse();
          } else if (preset === 'all_frames' || preset === 'all_966') {
            rows = db.prepare(`SELECT timestamp_iso, file_path, source FROM satellite_archive WHERE source = ? ORDER BY timestamp_iso ASC`).all(archiveSource) as any[];
          }

          if (rows.length > 0) {
            diskFrames = rows
              .filter(r => r.file_path && fs.existsSync(r.file_path))
              .map((r, idx) => {
                const { dateEcuador, timeEcuador } = satelliteMapService.formatEcuadorTimestamp(r.timestamp_iso);
                return {
                  index: idx,
                  timestampIso: r.timestamp_iso,
                  dateEcuador,
                  timeEcuador,
                  buffer: fs.readFileSync(r.file_path),
                  bbox: (BASIN_GEOMETRIES as any)[plantKey]?.bbox || [-81.5, -5.2, -75.0, 1.8],
                  plantKey,
                  source: (r.source as any) || targetSource
                };
              });
          }
        }

        // If compiling NASA GIBS for today and local archive has few frames, compute frame count from 00:00 ECT
        if (diskFrames.length === 0 && !liveFrameCount && isNasa && (preset === 'today' || preset === 'today_nasa' || preset === 'live_today')) {
          const nowMs = Date.now();
          const ecDt = new Date(nowMs - 5 * 3600 * 1000);
          const dateEcuadorStr = ecDt.toISOString().slice(0, 10);
          const startOfTodayUtcMs = new Date(`${dateEcuadorStr}T05:00:00.000Z`).getTime();
          const latestAvailableMs = Math.floor((nowMs - 10 * 60 * 1000) / (10 * 60 * 1000)) * (10 * 60 * 1000);
          const diffMs = Math.max(0, latestAvailableMs - startOfTodayUtcMs);
          liveFrameCount = Math.max(18, Math.floor(diffMs / (10 * 60 * 1000)) + 1);
        }

        const compileOptions: any = {
          plantKey,
          source: targetSource,
          frameCount: liveFrameCount,
          hoursBack: liveFrameCount ? liveFrameCount / 6 : undefined,
          createMp4,
          createGif,
          framerate,
          customTitle,
          customBadge,
          customDateSubtitle: payload.customDateSubtitle,
          watermarkBrand: payload.aspectRatio === '1:1' ? 'x' : 'instagram',
          singlePinLabel: pinLabel,
          showSinglePin,
          showAllPins,
          showCityPins: payload.showCityPins !== false && plantKey === 'ecuador',
          showDetectionBoxes: payload.showDetectionBoxes !== undefined ? payload.showDetectionBoxes : true,
          showProvinces: payload.showProvinces !== undefined ? payload.showProvinces : false,
          useVectorProvinces,
          unbakedProvinces: useVectorProvinces,
          provincesColor: payload.provincesColor || '#38bdf8',
          provincesOpacity: typeof payload.provincesOpacity === 'number' ? payload.provincesOpacity : 0.85,
          provincesWidth: typeof payload.provincesWidth === 'number' ? payload.provincesWidth : 1.2,
          svgOffsetX: typeof payload.svgOffsetX === 'number' ? payload.svgOffsetX : 0,
          svgOffsetY: typeof payload.svgOffsetY === 'number' ? payload.svgOffsetY : 0,
          svgScale: typeof payload.svgScale === 'number' ? payload.svgScale : 1.0,
          activeBasinKeys: payload.activeBasinKeys,
          highlightBasinKey: payload.activeBasinKeys?.[0],
          showThermalScale,
          showWfsBasins: payload.showWfsBasins === true,
          layer,
          aspectRatio: payload.aspectRatio === '1:1' ? '1:1' : '9:16',
          width: payload.aspectRatio === '1:1' ? 800 : 1080,
          height: payload.aspectRatio === '1:1' ? 800 : 1920,
          minDurationSeconds: payload.minDurationSeconds !== undefined ? payload.minDurationSeconds : 10,
          summaryCardsResolver: showSummaryCards ? (frame: any, idx: number) => {
            let m: any = null;
            try {
              m = db.prepare('SELECT ccs, paute, costa, sierra, amazonia FROM satellite_frame_metrics WHERE timestamp_iso = ?').get(frame.timestampIso);
            } catch (e) {}
            if (!m && frame.buffer) {
              m = rainMonitorService.computeEcuadorFrameMetrics(frame.buffer);
            }
            if (!m) m = { ccs: 0, paute: 0, costa: 0, sierra: 0, amazonia: 0 };
            return {
              basins: [
                { label: 'Coca Codo Sinclair', value: `${m.ccs.toFixed(1)}%`, color: '#38bdf8', highlight: m.ccs >= 10.0 },
                { label: 'Paute', value: `${m.paute.toFixed(1)}%`, color: '#a855f7', highlight: m.paute >= 15.0 }
              ],
              regions: [
                { label: 'Costa', value: `${m.costa.toFixed(1)}%`, color: '#38bdf8', highlight: m.costa >= 10.0 },
                { label: 'Sierra', value: `${m.sierra.toFixed(1)}%`, color: '#34d399', highlight: m.sierra >= 10.0 },
                { label: 'Amazonía', value: `${m.amazonia.toFixed(1)}%`, color: '#f59e0b', highlight: m.amazonia >= 10.0 }
              ]
            };
          } : undefined
        };

        let result;
        if (diskFrames.length > 0) {
          result = await videoCompilerService.compileFramesToVideo(diskFrames, compileOptions);
        } else {
          result = await videoCompilerService.generateBasinAnimation(compileOptions);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result }));
      } catch (error: any) {
        console.error('[Visualizer] Error compiling rain video:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // Get recent rain events API
  if (req.method === 'GET' && req.url === '/api/rain-events') {
    try {
      const events = rainMonitorService.getRecentEvents(20);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, events }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // Trigger immediate satellite rain check for a basin API
  if (req.method === 'POST' && req.url === '/api/check-rain-basin') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const plantKey = payload.plantKey || 'cocaCodoSinclair';
        const stormThresholdPct = payload.stormThresholdPct;
        const autoCompileVideo = payload.autoCompileVideo !== false;

        const result = await rainMonitorService.checkBasin(plantKey, {
          stormThresholdPct,
          autoCompileVideo
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Serve the HTML file
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(HTML_FILE, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading template HTML');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // Serve Daily Report HTML
  if (req.url === '/daily' || req.url === '/daily-report.html') {
    const dailyHtmlPath = path.join(TEMPLATE_DIR, 'daily-report.html');
    fs.readFile(dailyHtmlPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading daily report HTML');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // Serve Forecast Fan Chart HTML
  if (req.url === '/forecast' || req.url === '/forecasts' || req.url === '/forecast-card.html') {
    const forecastHtmlPath = path.join(TEMPLATE_DIR, 'forecast-card.html');
    fs.readFile(forecastHtmlPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading forecast HTML');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // Serve Rain Map & Satellite Visualizer HTML
  if (req.url === '/rain' || req.url === '/rain-maps' || req.url === '/rain-map.html') {
    const rainHtmlPath = path.join(TEMPLATE_DIR, 'rain-map.html');
    fs.readFile(rainHtmlPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading rain map HTML');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(data);
    });
    return;
  }

  // Serve Social Media / Instagram Cover HTML
  if (req.url === '/social' || req.url === '/cover' || req.url === '/instagram' || req.url === '/social-cover.html') {
    const socialHtmlPath = path.join(TEMPLATE_DIR, 'social-cover.html');
    fs.readFile(socialHtmlPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading social cover HTML');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(data);
    });
    return;
  }

  // Serve Temporary SVG Calibration HTML
  if (req.url === '/calibration' || req.url === '/svg-calib' || req.url === '/svg-calibration.html') {
    const calibHtmlPath = path.join(TEMPLATE_DIR, 'svg-calibration.html');
    fs.readFile(calibHtmlPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading SVG calibration HTML');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(data);
    });
    return;
  }

  // Serve the CSS files
  if (req.url === '/hydro-card.css') {
    fs.readFile(CSS_FILE, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading template CSS');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(data);
    });
    return;
  }

  if (req.url === '/daily-report.css') {
    const dailyCssPath = path.join(TEMPLATE_DIR, 'daily-report.css');
    fs.readFile(dailyCssPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading daily report CSS');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(data);
    });
    return;
  }

  if (req.url === '/rain-map.css') {
    const rainCssPath = path.join(TEMPLATE_DIR, 'rain-map.css');
    fs.readFile(rainCssPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading rain map CSS');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(data);
    });
    return;
  }

  // Serve Font files
  if (req.url && req.url.startsWith('/fonts/')) {
    const fontName = path.basename(req.url);
    const fontPath = path.join(__dirname, '..', 'fonts', fontName);
    fs.readFile(fontPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Font not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'font/ttf' });
      res.end(data);
    });
    return;
  }

  // Serve Hydroelectric Drawings
  if (req.url && req.url.startsWith('/hydroelectric-drawings/')) {
    const filename = path.basename(req.url);
    const imagePath = path.join(__dirname, '..', 'hydroelectric-drawings', filename);
    fs.readFile(imagePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Image not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(data);
    });
    return;
  }
  
  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

// Start watching the templates directory for modifications
let watchDebounceTimer: NodeJS.Timeout | null = null;
fs.watch(TEMPLATE_DIR, (eventType, filename) => {
  if (!filename) return;
  
  // Only trigger for the actual template files
  const watchedFiles = ['hydro-card.html', 'hydro-card.css', 'daily-report.html', 'daily-report.css', 'forecast-card.html', 'rain-map.html', 'rain-map.css', 'social-cover.html'];
  if (!watchedFiles.includes(filename)) {
    return;
  }
  
  // Debounce multiple fast events
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer);
  }
  
  watchDebounceTimer = setTimeout(() => {
    console.log(`[Visualizer] File change detected: ${filename}. Reloading clients...`);
    
    // Broadcast message to all connected SSE clients
    for (const client of clients) {
      client.write('data: reload\n\n');
    }
  }, 100);
});

server.listen(PORT, () => {
  console.log(`\n🚀 Hydro Telemetry Visualizer Server running at:`);
  console.log(`   👉 Telemetry Cards: http://localhost:${PORT}`);
  console.log(`   👉 Forecast Fan Chart: http://localhost:${PORT}/forecast`);
  console.log(`   👉 Satellite & Rain Maps: http://localhost:${PORT}/rain`);
  console.log(`\nWatching files in: ${TEMPLATE_DIR} for changes (live reloading active)`);
});
