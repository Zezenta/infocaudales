import fs from 'fs';
import path from 'path';
import puppeteer, { Browser } from 'puppeteer';
import { hydroelectricPlants } from '../data/hydroelectric-plants.js';

export interface TelemetryData {
  gen: number;
  turbines?: number;
  flow: number;
  flow3hAgo?: number;
  cota?: number;
  timestamp?: Date;
}

interface SavedConfig {
  plantConfigs?: Record<string, any>;
  globalThirds?: Record<string, any>;
}

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.connected) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--allow-file-access-from-files', '--enable-local-file-accesses']
    });
  }
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

function getVisualizerPlantsData() {
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

  return { plantsData, turbineLayouts };
}

function getProjectRoot(): string {
  if (__dirname.includes('dist')) {
    return path.resolve(path.join(__dirname, '..', '..', '..'));
  }
  return path.resolve(path.join(__dirname, '..', '..'));
}

function loadSavedConfigs(): SavedConfig {
  const configPath = path.join(getProjectRoot(), 'hydro-configs.json');
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      console.error('Error loading hydro-configs.json in report service:', e);
    }
  }
  return {};
}

export async function generateReportCard(
  plantKey: string,
  telemetry: TelemetryData
): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({
      width: 1200,
      height: 900,
      deviceScaleFactor: 2
    });

    const projectRoot = getProjectRoot();
    const htmlPath = path.join(projectRoot, 'src', 'templates', 'hydro-card.html');
    const fileUrl = `file://${htmlPath}`;
    const drawingsDir = path.join(projectRoot, 'src', 'hydroelectric-drawings');

    const { plantsData, turbineLayouts } = getVisualizerPlantsData();
    const savedConfigs = loadSavedConfigs();

    // Convert drawing image paths to absolute file:// URLs
    Object.keys(plantsData).forEach(k => {
      if (plantsData[k].drawingImage && plantsData[k].drawingImage.startsWith('/hydroelectric-drawings/')) {
        const imgName = plantsData[k].drawingImage.replace('/hydroelectric-drawings/', '');
        plantsData[k].drawingImage = `file://${drawingsDir}/${imgName}`;
      }
    });

    // Pre-inject window variables & localStorage before document scripts execute
    await page.evaluateOnNewDocument((plantsObj, turbinesObj, savedConfigData) => {
      // @ts-ignore
      window.plantsData = plantsObj;
      // @ts-ignore
      window.turbineLayouts = turbinesObj;

      if (savedConfigData) {
        if (savedConfigData.plantConfigs) {
          localStorage.setItem('hydro_plant_configs', JSON.stringify(savedConfigData.plantConfigs));
        }
        if (savedConfigData.globalThirds) {
          localStorage.setItem('hydro_global_thirds', JSON.stringify(savedConfigData.globalThirds));
        }
      }
    }, plantsData, turbineLayouts, savedConfigs);

    // Load static HTML template directly from disk
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });

    // Inject and apply telemetry into the UI
    await page.evaluate(async (key, data, plantsObj, turbinesObj, savedConfigData, drawingsPath) => {
      // Re-ensure global state in DOM context
      // @ts-ignore
      window.plantsData = plantsObj;
      // @ts-ignore
      window.turbineLayouts = turbinesObj;

      if (savedConfigData) {
        if (savedConfigData.plantConfigs) {
          localStorage.setItem('hydro_plant_configs', JSON.stringify(savedConfigData.plantConfigs));
        }
        if (savedConfigData.globalThirds) {
          localStorage.setItem('hydro_global_thirds', JSON.stringify(savedConfigData.globalThirds));
        }
      }

      const select = document.getElementById('plant-select') as HTMLSelectElement;
      if (select) {
        select.value = key;
      }

      // Trigger loadPlantControls
      // @ts-ignore
      if (typeof loadPlantControls === 'function') loadPlantControls();

      // Apply telemetry input values
      const genSlider = document.getElementById('gen-slider') as HTMLInputElement;
      if (genSlider && data.gen !== undefined) {
        genSlider.step = '0.01';
        genSlider.value = String(data.gen);
      }

      const turbinesSlider = document.getElementById('turbines-slider') as HTMLInputElement;
      if (turbinesSlider && data.turbines !== undefined) turbinesSlider.value = String(data.turbines);

      const flowSlider = document.getElementById('flow-slider') as HTMLInputElement;
      if (flowSlider && data.flow !== undefined) {
        flowSlider.max = '10000';
        flowSlider.step = '0.01';
        flowSlider.value = String(data.flow);
      }

      const cotaSlider = document.getElementById('cota-slider') as HTMLInputElement;
      if (cotaSlider && data.cota !== undefined) {
        cotaSlider.step = '0.01';
        cotaSlider.value = String(data.cota);
      }

      if (data.timestamp) {
        const dateInput = document.getElementById('date-input') as HTMLInputElement;
        if (dateInput) {
          const dt = new Date(data.timestamp);
          const tzOffset = dt.getTimezoneOffset() * 60000;
          const localISO = (new Date(dt.getTime() - tzOffset)).toISOString().slice(0, 16);
          dateInput.value = localISO;
        }
      }

      // Helper to fix turbine overlay icon image paths for file:// protocol
      const fixTurbineIcons = () => {
        const turbineIcons = Array.from(document.querySelectorAll('.turbine-icon'));
        turbineIcons.forEach(img => {
          const htmlImg = img as HTMLImageElement;
          const src = htmlImg.getAttribute('src') || '';
          if (src.includes('Turbina_')) {
            const iconName = src.includes('Pelton') ? 'Turbina_Pelton.png' : 'Turbina_Francis.png';
            htmlImg.src = `file://${drawingsPath}/${iconName}`;
          }
        });
      };

      // Force UI card update & fix turbine icons
      // @ts-ignore
      if (typeof updateCards === 'function') updateCards();
      fixTurbineIcons();
    }, plantKey, telemetry, plantsData, turbineLayouts, savedConfigs, drawingsDir);

    // Wait for images to load cleanly and re-update cards with cached image dimensions
    await page.evaluate(async (drawingsPath) => {
      const images = Array.from(document.querySelectorAll('img, image'));
      await Promise.all(images.map(img => {
        const htmlImg = img as HTMLImageElement;
        if (htmlImg.complete) return Promise.resolve();
        return new Promise(res => {
          htmlImg.addEventListener('load', res);
          htmlImg.addEventListener('error', res);
          setTimeout(res, 300);
        });
      }));
      // @ts-ignore
      if (typeof updateCards === 'function') updateCards();

      const turbineIcons = Array.from(document.querySelectorAll('.turbine-icon'));
      turbineIcons.forEach(img => {
        const htmlImg = img as HTMLImageElement;
        const src = htmlImg.getAttribute('src') || '';
        if (src.includes('Turbina_')) {
          const iconName = src.includes('Pelton') ? 'Turbina_Pelton.png' : 'Turbina_Francis.png';
          htmlImg.src = `file://${drawingsPath}/${iconName}`;
        }
      });
    }, drawingsDir);

    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));

    const cardElement = await page.$('.card-obsidian-grotesk');
    if (!cardElement) {
      throw new Error('Card element .card-obsidian-grotesk not found on page');
    }

    const imageBuffer = await cardElement.screenshot({
      type: 'png',
      omitBackground: true
    });

    return Buffer.from(imageBuffer);
  } finally {
    await page.close();
  }
}

export async function generateDailyReport(outputPath: string): Promise<void> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({
      width: 1200,
      height: 1800,
      deviceScaleFactor: 2
    });

    const projectRoot = getProjectRoot();
    const htmlPath = path.join(projectRoot, 'src', 'templates', 'daily-report.html');
    const fileUrl = `file://${htmlPath}`;

    const { plantsData } = getVisualizerPlantsData();
    await page.evaluateOnNewDocument((plantsObj) => {
      // @ts-ignore
      window.plantsData = plantsObj;
    }, plantsData);

    await page.goto(fileUrl, { waitUntil: 'networkidle0' });

    // Wait a brief period for fonts, styles and SVG rendering loop to settle
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));

    const cardElement = await page.$('#daily-report-card');
    if (!cardElement) {
      throw new Error('Daily report card element #daily-report-card not found');
    }

    await cardElement.screenshot({
      path: outputPath,
      type: 'png',
      omitBackground: true
    });
  } finally {
    await page.close();
  }
}
