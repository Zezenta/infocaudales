import { execFile } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { hydroelectricPlants } from '../data/hydroelectric-plants.js';
import { BASIN_GEOMETRIES, ALL_HYDRO_PLANTS_PINS, DEFAULT_REFERENCE_CITIES } from '../data/basin-geometries.js';
import { SatelliteMapService } from '../services/satellite-map.service.js';
import { SatelliteArchiverService } from '../services/satellite-archiver.service.js';
import { VideoCompilerService } from '../services/video-compiler.service.js';
import { RainMonitorService } from '../services/rain-monitor.service.js';
import { db } from '../utils/db.js';

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

function getOrComputeMetricsForRows(rows: Array<{ timestamp_iso: string; file_path: string }>): Record<string, { ccs: number; paute: number; costa: number; sierra: number; amazonia: number }> {
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
        const m = rainMonitorService.computeEcuadorFrameMetrics(buf);
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

let isSyncingFrames = false;
async function syncRecentVisualizerFrames(): Promise<void> {
  if (isSyncingFrames) return;
  isSyncingFrames = true;
  try {
    await satelliteArchiverService.archiveLatestFrames({ limit: 18, plantKey: 'ecuador' });

    // Compute metrics for any frames in today's archive that don't yet have metrics
    const uncomputed = db.prepare(`
      SELECT a.timestamp_iso, a.file_path
      FROM satellite_archive a
      LEFT JOIN satellite_frame_metrics m ON a.timestamp_iso = m.timestamp_iso
      WHERE a.date_ecuador = date('now', '-5 hours') AND m.timestamp_iso IS NULL
    `).all() as Array<{ timestamp_iso: string; file_path: string }>;

    for (const row of uncomputed) {
      if (fs.existsSync(row.file_path)) {
        try {
          const buf = fs.readFileSync(row.file_path);
          const metrics = rainMonitorService.computeEcuadorFrameMetrics(buf);
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

  // All Hydroelectric Plants Pins API
  if (req.method === 'GET' && req.url === '/api/all-hydro-pins') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ALL_HYDRO_PLANTS_PINS));
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
        { id: 'today', name: '📅 Resumen de Hoy (desde 00:00 ECT hasta ahora)' },
        { id: 'yesterday_24h', name: '📅 Resumen 24h Ayer (11 de Octubre • 133 fotogramas)' },
        { id: 'storm_paute_oct7', name: '⚡ Tormenta Severa en Paute (07-08 Oct • 37 fotogramas)' },
        { id: 'storm_ccs_oct7', name: '🌧️ Tormenta Coca Codo Sinclair (07 Oct • 31 fotogramas)' },
        { id: 'recent_50', name: '📁 Últimos 50 fotogramas archivados' },
        { id: 'all_frames', name: '📁 Archivo Histórico Completo' },
        { id: 'live', name: '📡 En Vivo: Últimas 3 horas (INAMHI GeoServer directo)' }
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ presets }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Satellite Timestamps by Preset API (includes live metrics per frame)
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/archive-timestamps')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const preset = urlObj.searchParams.get('preset') || 'today';

    try {
      let rows: Array<{ timestamp_iso: string; file_path: string }> = [];

      if (preset === 'today' || preset === 'live_today') {
        await syncRecentVisualizerFrames();

        rows = db.prepare(`
          SELECT timestamp_iso, file_path FROM satellite_archive
          WHERE date_ecuador = date('now', '-5 hours')
          ORDER BY timestamp_iso ASC
        `).all() as any[];

        if (rows.length < 6) {
          // Early morning fallback: include frames from last 20 hours
          rows = db.prepare(`
            SELECT timestamp_iso, file_path FROM satellite_archive
            WHERE timestamp_iso >= datetime('now', '-5 hours', '-20 hours')
            ORDER BY timestamp_iso ASC
          `).all() as any[];
        }
      } else if (preset === 'yesterday_24h') {
        rows = db.prepare(`
          SELECT timestamp_iso, file_path FROM satellite_archive
          WHERE date_ecuador = date('now', '-5 hours', '-1 day')
          ORDER BY timestamp_iso ASC
        `).all() as any[];
      } else if (preset === 'storm_paute_oct7') {
        rows = db.prepare(`
          SELECT timestamp_iso, file_path FROM satellite_archive
          WHERE timestamp_iso >= '2026-10-07T23:30:00.000Z' AND timestamp_iso <= '2026-10-08T05:30:00.000Z'
          ORDER BY timestamp_iso ASC
        `).all() as any[];
      } else if (preset === 'storm_ccs_oct7') {
        rows = db.prepare(`
          SELECT timestamp_iso, file_path FROM satellite_archive
          WHERE timestamp_iso >= '2026-10-07T17:30:00.000Z' AND timestamp_iso <= '2026-10-07T22:30:00.000Z'
          ORDER BY timestamp_iso ASC
        `).all() as any[];
      } else if (preset === 'recent_50') {
        const recentRows = db.prepare(`
          SELECT timestamp_iso, file_path FROM satellite_archive
          ORDER BY timestamp_iso DESC LIMIT 50
        `).all() as any[];
        rows = recentRows.reverse();
      } else if (preset === 'all_frames' || preset === 'all_966') {
        rows = db.prepare(`
          SELECT timestamp_iso, file_path FROM satellite_archive
          ORDER BY timestamp_iso ASC
        `).all() as any[];
      } else {
        // live GeoServer
        const timestamps = await satelliteMapService.fetchGoesTimestamps({ limit: 18 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ timestamps, metrics: {} }));
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

  // Satellite Single Frame Proxy API (handles CORS, local archive & layers)
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/satellite-frame')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const time = urlObj.searchParams.get('time') || undefined;
    const plantKey = urlObj.searchParams.get('plantKey') || 'ecuador';
    const layer = urlObj.searchParams.get('layer') || 'goes16_inamhi';
    const width = parseInt(urlObj.searchParams.get('width') || '800', 10);
    const height = parseInt(urlObj.searchParams.get('height') || '800', 10);

    // Fast path: Check local satellite archive if layer is default IR on ecuador
    if (plantKey === 'ecuador' && time && layer === 'goes16_inamhi') {
      try {
        const row = db.prepare('SELECT file_path FROM satellite_archive WHERE timestamp_iso = ?').get(time) as { file_path: string } | undefined;
        if (row && fs.existsSync(row.file_path)) {
          fs.readFile(row.file_path, (err, buffer) => {
            if (!err && buffer) {
              res.writeHead(200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=86400'
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
      layers = 'satellite_based_precipitation:persiann_pdir_24h,ecuador:provincias';
    } else if (layer === 'wrf_daily') {
      layers = 'wrf:wrf_precipitation_daily,ecuador:provincias';
    } else {
      layers = 'goes:goes_abi_l2_cmipf_13,ecuador:provincias';
    }

    satelliteMapService.fetchMapTile({
      source,
      layers,
      plantKey,
      time,
      width,
      height
    })
      .then(buffer => {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=300'
        });
        res.end(buffer);
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error loading satellite frame: ${err.message}`);
      });
    return;
  }

  // Compile Rain Video on demand API
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
        const showThermalScale = layer === 'goes16_inamhi';

        console.log(`[Visualizer] Compiling rain animation for ${plantKey} (preset: ${payload.preset || 'live'}, layer: ${layer}, title: "${customTitle}")...`);
        const showSummaryCards = payload.showSummaryCards !== false && plantKey === 'ecuador';

        const preset = payload.preset;
        let diskFrames: any[] = [];
        if (preset && preset !== 'live') {
          let rows: any[] = [];
          if (preset === 'today' || preset === 'live_today') {
            rows = db.prepare(`SELECT timestamp_iso, file_path FROM satellite_archive WHERE date_ecuador = date('now', '-5 hours') ORDER BY timestamp_iso ASC`).all() as any[];
            if (rows.length < 6) {
              rows = db.prepare(`SELECT timestamp_iso, file_path FROM satellite_archive WHERE timestamp_iso >= datetime('now', '-5 hours', '-20 hours') ORDER BY timestamp_iso ASC`).all() as any[];
            }
          } else if (preset === 'yesterday_24h') {
            rows = db.prepare(`SELECT timestamp_iso, file_path FROM satellite_archive WHERE date_ecuador = date('now', '-5 hours', '-1 day') ORDER BY timestamp_iso ASC`).all() as any[];
          } else if (preset === 'storm_paute_oct7') {
            rows = db.prepare(`SELECT timestamp_iso, file_path FROM satellite_archive WHERE timestamp_iso >= '2026-10-07T23:30:00.000Z' AND timestamp_iso <= '2026-10-08T05:30:00.000Z' ORDER BY timestamp_iso ASC`).all() as any[];
          } else if (preset === 'storm_ccs_oct7') {
            rows = db.prepare(`SELECT timestamp_iso, file_path FROM satellite_archive WHERE timestamp_iso >= '2026-10-07T17:30:00.000Z' AND timestamp_iso <= '2026-10-07T22:30:00.000Z' ORDER BY timestamp_iso ASC`).all() as any[];
          } else if (preset === 'recent_50') {
            const recent = db.prepare(`SELECT timestamp_iso, file_path FROM satellite_archive ORDER BY timestamp_iso DESC LIMIT 50`).all() as any[];
            rows = recent.reverse();
          } else if (preset === 'all_frames' || preset === 'all_966') {
            rows = db.prepare(`SELECT timestamp_iso, file_path FROM satellite_archive ORDER BY timestamp_iso ASC`).all() as any[];
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
                  source: 'geoserver'
                };
              });
          }
        }

        const compileOptions: any = {
          plantKey,
          createMp4,
          createGif,
          framerate,
          customTitle,
          customBadge,
          customDateSubtitle: payload.customDateSubtitle,
          singlePinLabel: pinLabel,
          showSinglePin,
          showAllPins,
          showCityPins: payload.showCityPins !== false && plantKey === 'ecuador',
          showDetectionBoxes: payload.showDetectionBoxes !== undefined ? payload.showDetectionBoxes : true,
          activeBasinKeys: payload.activeBasinKeys,
          highlightBasinKey: payload.activeBasinKeys?.[0],
          showThermalScale,
          layer,
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
      res.writeHead(200, { 'Content-Type': 'text/html' });
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
  const watchedFiles = ['hydro-card.html', 'hydro-card.css', 'daily-report.html', 'daily-report.css', 'forecast-card.html', 'rain-map.html', 'rain-map.css'];
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
