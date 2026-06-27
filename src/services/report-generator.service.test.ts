import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterAll } from 'vitest';
import { generateReportCard, closeBrowser, TelemetryData } from './report-generator.service.js';
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
});
