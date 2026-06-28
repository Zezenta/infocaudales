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
      expect(telemetry).toBeDefined();
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
});
