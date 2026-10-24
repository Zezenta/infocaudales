import { describe, it, expect } from 'vitest';
import { buildMessageText, formatVal, buildStormAlertPostText, sortPlantsForSocial, buildSocialRoundupCaption } from './post-formatter.js';
import { hydroelectricPlants } from '../data/hydroelectric-plants.js';

describe('post-formatter', () => {
  it('formats values without unnecessary trailing zeros for integers', () => {
    expect(formatVal(100.0)).toBe('100');
    expect(formatVal(100.5)).toBe('100.5');
    expect(formatVal(100.567)).toBe('100.57');
  });

  it('formats Mazar post with dual reference when above critical level (2115 msnm)', () => {
    const mazarPlant = hydroelectricPlants.mazar;
    const text = buildMessageText(mazarPlant, 'mazar', {
      gen: 136,
      flow: 85,
      flow3hAgo: 80,
      turbines: 2,
      cota: 2132.5,
    });

    expect(text).toContain('Hidroeléctrica #Mazar #Paute');
    expect(text).toContain('💧Cota actual: 2132.5 msnm');
    expect(text).toContain('• A 17.5 m de nivel crítico (2115)');
    expect(text).toContain('• A 34.5 m de apagado total (2098)');
    expect(text).toContain('🌊Caudal: 85 m³/s');
    expect(text).toContain('+6.25% desde hace 3h');
    expect(text).toContain('🔋Generación: 136 MWh');
    expect(text).toContain('Turbinas Activas: 2/2');
  });

  it('formats Mazar post with warning when below critical level (< 2115 msnm)', () => {
    const mazarPlant = hydroelectricPlants.mazar;
    const text = buildMessageText(mazarPlant, 'mazar', {
      gen: 0,
      flow: 25,
      flow3hAgo: 30,
      turbines: 0,
      cota: 2112.4,
    });

    expect(text).toContain('💧Cota actual: 2112.4 msnm');
    expect(text).toContain('⚠️ Bajo cota crítica (-2.6 m de 2115)');
    expect(text).toContain('• A 14.4 m de apagado total (2098)');
  });

  it('formats other plants (e.g. Molino) with single standard cota line', () => {
    const molinoPlant = hydroelectricPlants.molino;
    const text = buildMessageText(molinoPlant, 'molino', {
      gen: 913,
      flow: 154,
      flow3hAgo: 150,
      turbines: 8,
      cota: 1987.5,
    });

    expect(text).toContain('Hidroeléctrica #Molino #Paute');
    expect(text).toContain('💧Cota actual: 1987.5 msnm\nA 12.5 m de la cota mínima');
    expect(text).not.toContain('nivel crítico');
    expect(text).not.toContain('apagado total');
  });

  it('formats 24h cota decrease correctly for Mazar and other plants', () => {
    const mazarPlant = hydroelectricPlants.mazar;
    const text = buildMessageText(mazarPlant, 'mazar', {
      gen: 136,
      flow: 85,
      flow3hAgo: 80,
      turbines: 2,
      cota: 2132.5,
      cota24hAgo: 2132.9,
    });

    expect(text).toContain('💧Cota actual: 2132.5 msnm\n📉 Bajó 0.4 m en 24h (ayer: 2132.9)');
    expect(text).toContain('• A 17.5 m de nivel crítico (2115)');
    expect(text).toContain('• A 34.5 m de apagado total (2098)');

    const molinoPlant = hydroelectricPlants.molino;
    const molinoText = buildMessageText(molinoPlant, 'molino', {
      gen: 913,
      flow: 154,
      turbines: 8,
      cota: 1987.5,
      cota24hAgo: 1988.0,
    });

    expect(molinoText).toContain('💧Cota actual: 1987.5 msnm\n📉 Bajó 0.5 m en 24h (ayer: 1988)\nA 12.5 m de la cota mínima');
  });

  it('formats 24h cota increase and no change correctly', () => {
    const mazarPlant = hydroelectricPlants.mazar;
    const textUp = buildMessageText(mazarPlant, 'mazar', {
      gen: 136,
      flow: 85,
      turbines: 2,
      cota: 2132.5,
      cota24hAgo: 2132.2,
    });
    expect(textUp).toContain('💧Cota actual: 2132.5 msnm\n📈 Subió 0.3 m en 24h (ayer: 2132.2)');

    const textSame = buildMessageText(mazarPlant, 'mazar', {
      gen: 136,
      flow: 85,
      turbines: 2,
      cota: 2132.5,
      cota24hAgo: 2132.5,
    });
    expect(textSame).toContain('💧Cota actual: 2132.5 msnm\n= Sin variación en 24h (ayer: 2132.5)');
  });

  it('formats CCS without cota line', () => {
    const ccsPlant = hydroelectricPlants.cocaCodoSinclair;
    const text = buildMessageText(ccsPlant, 'cocaCodoSinclair', {
      gen: 1120,
      flow: 620,
      flow3hAgo: 600,
    }, 4500);

    expect(text).toContain('Hidroeléctrica Coca Codo Sinclair');
    expect(text).not.toContain('💧Cota');
    expect(text).toContain('Está generando el 24.89% de la energía usada en Ecuador en este momento.');
  });

  describe('buildStormAlertPostText', () => {
    it('formats Paute storm alert with peak coverage and duration', () => {
      const text = buildStormAlertPostText({
        plantKey: 'paute',
        peakCoveragePct: 42.67,
        durationMinutes: 90,
        dateEcuador: '2026-10-10',
        timeEcuador: '15:30'
      });

      expect(text).toContain('Complejo Hidroeléctrico Paute');
      expect(text).toContain('Pico de cobertura: 42.7%');
      expect(text).toContain('Duración aproximada: 90 min');
      expect(text).toContain('Registro: 2026-10-10 15:30 ECT');
      expect(text).toContain('#Paute');
      expect(text).toContain('#Lluvias');
    });

    it('formats Coca Codo Sinclair storm alert with proper hashtags', () => {
      const text = buildStormAlertPostText({
        plantKey: 'cocaCodoSinclair',
        peakCoveragePct: 65.0,
        durationMinutes: 120
      });

      expect(text).toContain('la cuenca hídrica de Coca Codo Sinclair');
      expect(text).toContain('Pico de cobertura: 65%');
      expect(text).toContain('Duración aproximada: 120 min');
      expect(text).toContain('#CocaCodoSinclair #CCS');
    });

    it('does not duplicate timestamp when dateEcuador and timeEcuador are identical', () => {
      const text = buildStormAlertPostText({
        plantKey: 'paute',
        peakCoveragePct: 20.0,
        dateEcuador: '2026-10-10 18:40',
        timeEcuador: '2026-10-10 18:40'
      });

      expect(text).toContain('• Registro: 2026-10-10 18:40 ECT');
      expect(text).not.toContain('2026-10-10 18:40 2026-10-10 18:40');
    });

    it('formats rain event alert with time range and without using the word tormenta', () => {
      const text = buildStormAlertPostText({
        plantKey: 'paute',
        peakCoveragePct: 35.5,
        durationMinutes: 45,
        dateEcuador: '2026-10-16',
        startTimeEcuador: '01:10',
        endTimeEcuador: '01:55'
      });

      expect(text).toContain('• Registro: 2026-10-16 de 01:10 a 01:55 ECT');
      expect(text).toContain('🌧️ Evento de Lluvia en el Complejo Hidroeléctrico Paute');
      expect(text).not.toContain('Monitoreo Satelital GOES-16');
      expect(text.toLowerCase()).not.toContain('tormenta');
    });
  });

  describe('sortPlantsForSocial', () => {
    it('sorts Mazar first, Coca Codo Sinclair second, and remaining by generation descending', () => {
      const items = [
        { plantKey: 'molino', telemetry: { gen: 500 } as any },
        { plantKey: 'agoyan', telemetry: { gen: 80 } as any },
        { plantKey: 'cocaCodoSinclair', telemetry: { gen: 300 } as any },
        { plantKey: 'mazar', telemetry: { gen: 120 } as any },
        { plantKey: 'sopladora', telemetry: { gen: 450 } as any }
      ];

      const sorted = sortPlantsForSocial(items);
      expect(sorted.map(s => s.plantKey)).toEqual([
        'mazar',
        'cocaCodoSinclair',
        'molino',
        'sopladora',
        'agoyan'
      ]);
    });
  });

  describe('buildSocialRoundupCaption', () => {
    it('appends corte HH:MM ECT when plant telemetry is delayed relative to report hour', () => {
      const delayedTimestamp = new Date('2026-10-16T16:00:00.000Z'); // 11:00 ECT
      const currentTimestamp = new Date('2026-10-16T18:00:00.000Z'); // 13:00 ECT

      const caption = buildSocialRoundupCaption({
        dateStr: 'Viernes, 16 de octubre del 2026',
        hourStr: '13:15 ECT',
        totalMW: 1800,
        capacityPct: 45,
        plants: [
          {
            plantKey: 'mazar',
            plant: hydroelectricPlants.mazar,
            telemetry: {
              gen: 120,
              flow: 85,
              flow3hAgo: 80,
              cota: 2130,
              cota24hAgo: 2129,
              turbines: 2,
              timestamp: currentTimestamp
            }
          },
          {
            plantKey: 'agoyan',
            plant: hydroelectricPlants.agoyan,
            telemetry: {
              gen: 80,
              flow: 75,
              flow3hAgo: 70,
              cota: 1648,
              cota24hAgo: 1648,
              turbines: 1,
              timestamp: delayedTimestamp
            }
          }
        ]
      });

      expect(caption).toContain('🔹 Mazar\n');
      expect(caption).toContain('🔹 Agoyán (corte 11:00 ECT)\n');
      expect(caption).toContain('Generación hidroeléctrica total: 1,800 MW');
    });
  });
});

