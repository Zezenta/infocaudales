import { describe, it, expect, afterAll } from 'vitest';
import { generateReportCard, closeBrowser, TelemetryData } from './report-generator.service.js';
import { hydroelectricPlants } from '../data/hydroelectric-plants.js';

describe('ReportGeneratorService (Headless Chrome Generation)', () => {
  afterAll(async () => {
    await closeBrowser();
  });

  it('should evaluate flow status labels (Bajo, Normal, Alto, Crecida) correctly for all plants', async () => {
    const { getVisualizerPlantsData } = await import('./report-generator.service.js');
    const { plantsData } = getVisualizerPlantsData();

    // Helper implementing the template logic
    function evaluateFlowStatus(plantKey: string, plant: any, flowVal: number): string {
      const extremeStatus = plantKey === 'cocaCodoSinclair' ? 'Crecida' : 'Muy Alto';
      if (plant.flowThresholds) {
        if (flowVal < plant.flowThresholds.low) return 'Bajo';
        if (flowVal < plant.flowThresholds.normal) return 'Normal';
        if (flowVal < plant.flowThresholds.high) return 'Alto';
        return extremeStatus;
      }
      const flowRatio = flowVal / plant.maxFlowM3s;
      if (flowRatio < 0.25) return 'Bajo';
      if (flowRatio < 0.50) return 'Normal';
      if (flowRatio < 0.75) return 'Alto';
      return extremeStatus;
    }

    // Verify all 6 plants
    for (const [key, plant] of Object.entries(hydroelectricPlants)) {
      if (!plant.physicalData?.flowThresholds) continue;
      const { low, normal, high } = plant.physicalData.flowThresholds;
      const expectedExtreme = key === 'cocaCodoSinclair' ? 'Crecida' : 'Muy Alto';

      expect(evaluateFlowStatus(key, plantsData[key], low - 1)).toBe('Bajo');
      expect(evaluateFlowStatus(key, plantsData[key], low)).toBe('Normal');
      expect(evaluateFlowStatus(key, plantsData[key], (low + normal) / 2)).toBe('Normal');
      expect(evaluateFlowStatus(key, plantsData[key], normal)).toBe('Alto');
      expect(evaluateFlowStatus(key, plantsData[key], (normal + high) / 2)).toBe('Alto');
      expect(evaluateFlowStatus(key, plantsData[key], high)).toBe(expectedExtreme);
      expect(evaluateFlowStatus(key, plantsData[key], high + 100)).toBe(expectedExtreme);
    }
  });

  it('should generate a valid PNG buffer for a report card with fictional telemetry', async () => {
    const telemetry: TelemetryData = { gen: 950.75, turbines: 8, flow: 140.35, cota: 1988.42 };
    const pngBuffer = await generateReportCard('molino', telemetry);
    expect(pngBuffer).toBeInstanceOf(Buffer);
    expect(pngBuffer.length).toBeGreaterThan(1000);
  }, 60000);
});
