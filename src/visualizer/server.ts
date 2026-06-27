import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3000;
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');
const HTML_FILE = path.join(TEMPLATE_DIR, 'hydro-card.html');
const CSS_FILE = path.join(TEMPLATE_DIR, 'hydro-card.css');

// Keep track of active SSE connections
const clients: Set<http.ServerResponse> = new Set();

const server = http.createServer((req, res) => {
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
  
  // Serve the CSS file
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
  if (filename !== 'hydro-card.html' && filename !== 'hydro-card.css') {
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
  console.log(`   👉 http://localhost:${PORT}`);
  console.log(`\nWatching files in: ${TEMPLATE_DIR} for changes (live reloading active)`);
});
