import { describe, it, expect } from 'vitest';
import { buildMessageText, formatVal } from './post-formatter.js';
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
});
