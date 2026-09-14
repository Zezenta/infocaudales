import http from 'http';
import fs from 'fs';
import path from 'path';
import { hydroelectricPlants } from '../data/hydroelectric-plants.js';
import { BASIN_GEOMETRIES, ALL_HYDRO_PLANTS_PINS } from '../data/basin-geometries.js';
import { SatelliteMapService } from '../services/satellite-map.service.js';
import { VideoCompilerService } from '../services/video-compiler.service.js';

const PORT = 3000;
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');
const HTML_FILE = path.join(TEMPLATE_DIR, 'hydro-card.html');
const CSS_FILE = path.join(TEMPLATE_DIR, 'hydro-card.css');

const satelliteMapService = new SatelliteMapService();
const videoCompilerService = new VideoCompilerService(satelliteMapService);

// Preload recent frames in RAM cache in the background
satelliteMapService.preloadAllOptionsBackground();

// Keep track of active SSE connections
const clients: Set<http.ServerResponse> = new Set();

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

const server = http.createServer((req, res) => {
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

  // Satellite Single Frame Proxy API (handles CORS & layers)
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/satellite-frame')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const time = urlObj.searchParams.get('time') || undefined;
    const plantKey = urlObj.searchParams.get('plantKey') || 'ecuador';
    const layer = urlObj.searchParams.get('layer') || 'goes16_inamhi';
    const width = parseInt(urlObj.searchParams.get('width') || '800', 10);
    const height = parseInt(urlObj.searchParams.get('height') || '800', 10);

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
        const framerate = payload.framerate || 4;

        console.log(`[Visualizer] Compiling rain video for ${plantKey}...`);
        const result = await videoCompilerService.generateBasinAnimation({
          plantKey,
          createMp4,
          createGif,
          framerate
        });

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
