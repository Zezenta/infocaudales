import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { hydroelectricPlants } from './data/hydroelectric-plants.js';
import { TARGET_PLANT_KEYS, fetchTelemetry } from './index.js';
import { buildMessageText } from './utils/post-formatter.js';
import { generateReportCard } from './services/report-generator.service.js';

describe('Main Bot Pipeline (Dry Run Integration Test)', () => {
  it('should fetch telemetry, format text, and generate report cards for all 6 hydroelectric plants', async () => {
    const outputDir = path.join(__dirname, '..', 'generated');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    const currentDateStr = `${year}-${month}-${day}`;
    const currentTimeStr = `${hours}-${minutes}-${seconds}`;

    console.log(`\n==================================================`);
    console.log(`🧪 STARTING DRY RUN BOT PIPELINE TEST`);
    console.log(`Timestamp: ${currentDateStr} ${currentTimeStr}`);
    console.log(`==================================================\n`);

    for (const plantKey of TARGET_PLANT_KEYS) {
      const plant = hydroelectricPlants[plantKey];
      expect(plant).toBeDefined();

      console.log(`--------------------------------------------------`);
      console.log(`🔍 Processing Dry Run for: ${plant.name} (${plantKey})`);
      console.log(`--------------------------------------------------`);

      // 1. Fetch live telemetry
      const telemetry = await fetchTelemetry(plantKey);
      if (!telemetry) {
        console.log(`⚠️ Telemetry for ${plant.name} is currently missing from live CELEC. Skipping dry run card generation.`);
        continue;
      }

      expect(typeof telemetry.gen).toBe('number');
      expect(typeof telemetry.flow).toBe('number');

      // 2. Format social media text message
      const textMessage = buildMessageText(plant, plantKey, telemetry, 4200);
      console.log(`\n📱 [Formatted Post Text]\n${textMessage}\n`);

      // 3. Generate high-resolution report card buffer
      const imageBuffer = await generateReportCard(plantKey, telemetry);
      expect(Buffer.isBuffer(imageBuffer)).toBe(true);
      expect(imageBuffer.length).toBeGreaterThan(1000);

      // 4. Save image with naming convention: service_test_[hydroelectric]_[currentdate]_[currenttime].png
      const fileName = `service_test_${plantKey}_${currentDateStr}_${currentTimeStr}.png`;
      const filePath = path.join(outputDir, fileName);
      fs.writeFileSync(filePath, imageBuffer);

      console.log(`💾 Saved report card to: ${filePath} (${imageBuffer.length} bytes)\n`);
      expect(fs.existsSync(filePath)).toBe(true);
    }

    console.log(`==================================================`);
    console.log(`✅ DRY RUN TEST COMPLETED SUCCESSFULLY FOR ALL 6 PLANTS`);
    console.log(`==================================================\n`);
  }, 60000);

  it('should format individual forecast posts and verify weekly schedule rotation', async () => {
    const { FORECAST_SCHEDULE_ROTATION } = await import('./index.js');
    expect(FORECAST_SCHEDULE_ROTATION[1]).toEqual({ morning: 'cocaCodoSinclair', afternoon: 'mazar' });
    expect(FORECAST_SCHEDULE_ROTATION[2]).toEqual({ morning: 'molino', afternoon: 'agoyan' });
    expect(FORECAST_SCHEDULE_ROTATION[3]).toEqual({ morning: 'sopladora', afternoon: 'minasSanFrancisco' });
    expect(FORECAST_SCHEDULE_ROTATION[4]).toEqual({ morning: 'cocaCodoSinclair', afternoon: 'mazar' });
    expect(FORECAST_SCHEDULE_ROTATION[5]).toEqual({ morning: 'molino', afternoon: 'agoyan' });
    expect(FORECAST_SCHEDULE_ROTATION[6]).toEqual({ morning: 'sopladora', afternoon: 'minasSanFrancisco' });
    expect(FORECAST_SCHEDULE_ROTATION[0]).toEqual({ morning: 'cocaCodoSinclair', afternoon: '' });

    const plant = hydroelectricPlants.cocaCodoSinclair;
    const { buildForecastPostText, buildWeeklyAccuracyReportText } = await import('./utils/post-formatter.js');

    const forecastPost = buildForecastPostText(plant, 'cocaCodoSinclair', {
      currentFlow: 336,
      targetFlow: 622.37,
      p25: 558,
      p75: 687,
      horizonHours: 6,
      modelName: 'multi_guarded',
      mae: 76.28
    });

    expect(forecastPost).toContain('Coca Codo Sinclair (+6h)');
    expect(forecastPost).toContain('336 m³/s');
    expect(forecastPost).toContain('622.37 m³/s');
    expect(forecastPost).toContain('+85.2%');
    expect(forecastPost).toContain('558 - 687 m³/s');
    expect(forecastPost).toContain('multi_guarded');

    const weeklyReport = buildWeeklyAccuracyReportText({
      periodStart: Date.now() - 7 * 86400000,
      periodEnd: Date.now(),
      totalForecastsResolved: 12,
      overallMae: 14.5,
      overallDirectionalAccuracy: 0.833,
      overallP25P75Coverage: 0.75,
      overallP10P90Coverage: 0.917,
      plants: {
        cocaCodoSinclair: {
          plantKey: 'cocaCodoSinclair',
          plantName: 'Coca Codo Sinclair',
          totalEvaluations: 4,
          observedMae: 22.4,
          expectedMae: 40.0,
          directionalAccuracy: 0.75,
          withinP25P75: 0.75,
          withinP10P90: 1.0,
          avgBias: -2.1,
          horizons: { 6: { count: 4, observedMae: 22.4, directionalAccuracy: 0.75 } }
        }
      },
      mostAccuratePlant: 'cocaCodoSinclair'
    });

    expect(weeklyReport).toContain('Reporte Semanal');
    expect(weeklyReport).toContain('Acierto de Tendencia: 83.3%');
    expect(weeklyReport).toContain('Error Medio (MAE): 14.5 m³/s');
    expect(weeklyReport).toContain('Central más precisa: Coca Codo Sinclair');
  });
});
