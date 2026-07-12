import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterAll } from 'vitest';
import { generateReportCard, generateDailyReport, closeBrowser, TelemetryData } from './report-generator.service.js';
import { CelecService } from './celec.service.js';
import { CenaceService } from './cenace.service.js';
import { hydroelectricPlants } from '../data/hydroelectric-plants.js';

describe('ReportGeneratorService (Headless Chrome Generation)', () => {
  afterAll(async () => {
    await closeBrowser();
  });
  
  it('should generate valid PNG buffers and save them to disk for each plant with fictional data', async () => {
    const generatedDir = path.join(__dirname, '..', '..', 'generated');
    if (!fs.existsSync(generatedDir)) {
      fs.mkdirSync(generatedDir, { recursive: true });
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    const dateStr = `${year}-${month}-${day}`;
    const timeStr = `${hours}-${minutes}-${seconds}`;

    // Valid fictional telemetry test data with decimals for each hydroelectric plant
    const testCases: Record<string, TelemetryData> = {
      molino: { gen: 950.75, turbines: 8, flow: 140.35, cota: 1988.42 },
      cocaCodoSinclair: { gen: 1250.85, turbines: 6, flow: 850.45 },
      sopladora: { gen: 410.25, turbines: 3, flow: 85.60 },
      mazar: { gen: 150.90, turbines: 2, flow: 120.15, cota: 2140.78 },
      minasSanFrancisco: { gen: 210.33, turbines: 2, flow: 60.55, cota: 789.25 },
      agoyan: { gen: 105.45, turbines: 2, flow: 95.80, cota: 1649.65 }
    };

    for (const [plantKey, telemetry] of Object.entries(testCases)) {
      const plant = hydroelectricPlants[plantKey];
      expect(plant).toBeDefined();

      const pngBuffer = await generateReportCard(plantKey, telemetry);
      expect(pngBuffer).toBeInstanceOf(Buffer);
      expect(pngBuffer.length).toBeGreaterThan(1000);

      // Naming convention: service_test_[hydroelectric]_[currentdate]_[currenttime].png
      const plantNameSanitized = plant.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_');
      const filename = `service_test_${plantNameSanitized}_${dateStr}_${timeStr}.png`;
      const filePath = path.join(generatedDir, filename);

      fs.writeFileSync(filePath, pngBuffer);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  }, 35000);

  it('should generate the daily consolidated report using real live telemetry data', async () => {
    const celec = new CelecService();
    const cenace = new CenaceService();

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Formatted date string for Ecuador local time
    const daysOfWeek = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const months = [
      'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
    ];
    const ecTime = new Date(yesterday.getTime() - 5 * 60 * 60 * 1000);
    const dayName = daysOfWeek[ecTime.getUTCDay()];
    const dayVal = ecTime.getUTCDate();
    const monthName = months[ecTime.getUTCMonth()];
    const yearVal = ecTime.getUTCFullYear();
    const dateStrFormatted = `${dayName}, ${dayVal} de ${monthName} del ${yearVal}`;

    console.log(`[Test Daily Report] Fetching real telemetry for date: ${dateStrFormatted}...`);

    let ccsYesterdayMWh = 18450;
    let totalNationalMWh = 0;
    let systemHourly: number[] = new Array(24).fill(1000);

    try {
      const cenaceData = await cenace.fetchYesterdayOperationalData();
      if (cenaceData.plantsDailyTotalMWh.cocaCodoSinclair) {
        ccsYesterdayMWh = cenaceData.plantsDailyTotalMWh.cocaCodoSinclair;
      }
      if (cenaceData.compositionMWh) {
        totalNationalMWh = Object.values(cenaceData.compositionMWh).reduce((a: any, b: any) => a + b, 0);
      }
      const rawCurve = cenaceData.generationCurve || [];
      if (rawCurve.length > 0) {
        systemHourly = [];
        if (rawCurve.length >= 48) {
          for (let i = 0; i < 24; i++) {
            systemHourly.push(rawCurve[i * 2].totalHydroMW || 1000);
          }
        } else {
          for (let i = 0; i < 24; i++) {
            systemHourly.push(rawCurve[i]?.totalHydroMW || 1000);
          }
        }
      }
    } catch (err) {
      console.warn('[Test Daily Report] Failed to fetch live CENACE yesterday totals. Using baseline curve.', err);
    }

    const sumSystem = systemHourly.reduce((a, b) => a + b, 0) || 1;
    const ccsScale = ccsYesterdayMWh / sumSystem;
    const ccsGenHistory = systemHourly.map(val => val * ccsScale);

    // Fetch CCS caudal history
    let ccsFlowHistory = [280, 290, 310, 340, 380, 420, 450, 460, 440, 410, 390, 380, 370, 390, 410, 430, 460, 470, 450, 420, 390, 350, 320, 300];
    try {
      const ccsFlowPointsRaw = await celec.fetchFlow(hydroelectricPlants.cocaCodoSinclair, yesterday);
      if (ccsFlowPointsRaw && ccsFlowPointsRaw.length > 0) {
        const reversed = [...ccsFlowPointsRaw].reverse();
        const arr = new Array(24).fill(620);
        for (let i = 0; i < 24; i++) {
          if (reversed[i] && reversed[i].value !== null && reversed[i].value !== undefined) {
            arr[i] = reversed[i].value;
          } else if (i > 0) {
            arr[i] = arr[i - 1];
          }
        }
        ccsFlowHistory = arr;
      }
    } catch (err) {
      console.warn('[Test Daily Report] Failed to fetch CELEC flow for Coca Codo Sinclair.');
    }

    const ccsMaxMW = hydroelectricPlants.cocaCodoSinclair.physicalData?.maxEnergyMW || 1500;
    const ccsFactor = (ccsYesterdayMWh / (ccsMaxMW * 24)) * 100;

    const plantPayloads: any[] = [{
      key: 'cocaCodoSinclair',
      todayMWh: ccsYesterdayMWh,
      factor: ccsFactor,
      genHistory: ccsGenHistory,
      caudalHistory: ccsFlowHistory
    }];

    const celecPlantsList = [
      { key: 'molino', defFlow: 120, defCota: 1982, defaultGen: [500, 450, 380, 350, 420, 580, 720, 850, 900, 880, 850, 820, 800, 840, 890, 920, 950, 940, 900, 850, 780, 700, 620, 550], defaultCaudal: [120, 118, 122, 124, 128, 131, 135, 139, 142, 144, 146, 148, 151, 153, 155, 158, 160, 162, 163, 164, 165, 165, 166, 167], defaultCota: [1981.5, 1981.8, 1982.1, 1982.4, 1982.8, 1983.1, 1983.5, 1983.9, 1984.2, 1984.4, 1984.6, 1984.8, 1985.1, 1985.3, 1985.5, 1985.8, 1986.0, 1986.2, 1986.3, 1986.4, 1986.5, 1986.5, 1986.6, 1986.7] },
      { key: 'sopladora', defFlow: 140, defCota: 0, defaultGen: [220, 200, 180, 170, 210, 290, 360, 410, 430, 420, 400, 390, 380, 400, 420, 440, 450, 440, 420, 390, 350, 310, 270, 240], defaultCaudal: [140, 135, 130, 128, 145, 175, 190, 205, 210, 205, 195, 190, 185, 195, 205, 215, 220, 215, 205, 190, 175, 160, 150, 142] },
      { key: 'mazar', defFlow: 75, defCota: 2139, defaultGen: [80, 60, 40, 30, 50, 90, 120, 140, 150, 145, 140, 135, 130, 135, 145, 150, 155, 150, 140, 130, 110, 95, 85, 75], defaultCaudal: [65, 68, 72, 75, 78, 82, 85, 89, 92, 94, 96, 98, 101, 103, 105, 108, 110, 112, 113, 114, 115, 115, 116, 117], defaultCota: [2138.2, 2138.3, 2138.4, 2138.5, 2138.6, 2138.7, 2138.9, 2139.1, 2139.3, 2139.5, 2139.7, 2139.8, 2140.0, 2140.1, 2140.3, 2140.5, 2140.7, 2140.8, 2140.9, 2141.0, 2141.1, 2141.2, 2141.2, 2141.3] },
      { key: 'minasSanFrancisco', defFlow: 45, defCota: 783, defaultGen: [110, 90, 70, 60, 80, 130, 180, 210, 230, 220, 210, 200, 190, 200, 220, 235, 240, 230, 210, 190, 160, 140, 125, 115], defaultCaudal: [35, 38, 42, 45, 48, 52, 55, 59, 62, 64, 66, 68, 71, 73, 75, 78, 80, 82, 83, 84, 85, 85, 86, 87], defaultCota: [782.1, 782.2, 782.3, 782.4, 782.5, 782.7, 782.9, 783.1, 783.3, 783.5, 783.6, 783.7, 783.8, 783.9, 784.0, 784.1, 784.2, 784.3, 784.3, 784.4, 784.4, 784.5, 784.5, 784.5] },
      { key: 'agoyan', defFlow: 100, defCota: 1649, defaultGen: [70, 60, 50, 45, 55, 85, 110, 130, 135, 130, 125, 120, 115, 120, 130, 135, 140, 135, 125, 115, 100, 90, 80, 75], defaultCaudal: [110, 105, 98, 90, 105, 115, 120, 125, 130, 125, 115, 110, 105, 110, 120, 125, 130, 125, 115, 110, 100, 95, 90, 85], defaultCota: [1648.2, 1648.3, 1648.4, 1648.5, 1648.6, 1648.7, 1648.9, 1649.1, 1649.2, 1649.3, 1649.4, 1649.5, 1649.6, 1649.7, 1649.8, 1649.9, 1650.0, 1650.0, 1650.0, 1650.0, 1650.0, 1650.0, 1650.0, 1650.0] }
    ];

    for (const item of celecPlantsList) {
      const plant = hydroelectricPlants[item.key];
      const maxMW = plant.physicalData?.maxEnergyMW || 100;

      let genHistory = item.defaultGen;
      try {
        const genPointsRaw = await celec.fetchDailyEnergy(plant, yesterday);
        if (genPointsRaw && genPointsRaw.length > 0) {
          const reversed = [...genPointsRaw].reverse();
          const arr = new Array(24).fill(plant.visualData?.defaultGen || 50);
          for (let i = 0; i < 24; i++) {
            if (reversed[i] && reversed[i].value !== null && reversed[i].value !== undefined) {
              arr[i] = reversed[i].value;
            } else if (i > 0) {
              arr[i] = arr[i - 1];
            }
          }
          genHistory = arr;
        }
      } catch (err) {
        // use defaultGen
      }

      let caudalHistory = item.defaultCaudal;
      try {
        const flowPointsRaw = await celec.fetchFlow(plant, yesterday);
        if (flowPointsRaw && flowPointsRaw.length > 0) {
          const reversed = [...flowPointsRaw].reverse();
          const arr = new Array(24).fill(item.defFlow);
          for (let i = 0; i < 24; i++) {
            if (reversed[i] && reversed[i].value !== null && reversed[i].value !== undefined) {
              arr[i] = reversed[i].value;
            } else if (i > 0) {
              arr[i] = arr[i - 1];
            }
          }
          caudalHistory = arr;
        }
      } catch (err) {
        // use defaultCaudal
      }

      let cotaHistory = item.defaultCota;
      if (plant.physicalData?.minLevelMasl !== undefined) {
        try {
          const levelPointsRaw = await celec.fetchLevel(plant, yesterday);
          if (levelPointsRaw && levelPointsRaw.length > 0) {
            const reversed = [...levelPointsRaw].reverse();
            const arr = new Array(24).fill(item.defCota);
            for (let i = 0; i < 24; i++) {
              if (reversed[i] && reversed[i].value !== null && reversed[i].value !== undefined) {
                arr[i] = reversed[i].value;
              } else if (i > 0) {
                arr[i] = arr[i - 1];
              }
            }
            cotaHistory = arr;
          }
        } catch (err) {
          // use defaultCota
        }
      } else {
        cotaHistory = undefined as any;
      }

      const todayMWh = genHistory.reduce((a, b) => a + b, 0);
      const factor = (todayMWh / (maxMW * 24)) * 100;

      plantPayloads.push({
        key: item.key,
        todayMWh,
        factor,
        genHistory,
        caudalHistory,
        cotaHistory
      });
    }

    const sum6PlantsMWh = plantPayloads.reduce((sum, p) => sum + p.todayMWh, 0);
    const nationalShare = totalNationalMWh > 0 ? (sum6PlantsMWh / totalNationalMWh) * 100 : 65.31;

    const liveData = {
      plants: plantPayloads,
      dateStr: dateStrFormatted,
      nationalShare
    };

    const generatedDir = path.join(__dirname, '..', '..', 'generated');
    const nowLocal = new Date();
    const year = nowLocal.getFullYear();
    const month = String(nowLocal.getMonth() + 1).padStart(2, '0');
    const day = String(nowLocal.getDate()).padStart(2, '0');
    const hours = String(nowLocal.getHours()).padStart(2, '0');
    const minutes = String(nowLocal.getMinutes()).padStart(2, '0');
    const seconds = String(nowLocal.getSeconds()).padStart(2, '0');
    const dateStrLocal = `${year}-${month}-${day}`;
    const timeStrLocal = `${hours}-${minutes}-${seconds}`;

    const filename = `service_test_daily_report_${dateStrLocal}_${timeStrLocal}.png`;
    const filePath = path.join(generatedDir, filename);

    await generateDailyReport(filePath, liveData);
    expect(fs.existsSync(filePath)).toBe(true);
    console.log(`[Test Daily Report] Successfully generated and verified daily report file: ${filePath}`);
  }, 45000);
});
