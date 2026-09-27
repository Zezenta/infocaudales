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
    expect(text).toContain('💧Cota: 2132.5 msnm');
    expect(text).toContain('• A 17.5 m del nivel crítico (2115 msnm)');
    expect(text).toContain('• A 34.5 m del apagado total (2098 msnm)');
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

    expect(text).toContain('💧Cota: 2112.4 msnm');
    expect(text).toContain('⚠️ Bajo cota crítica (-2.6 m de 2115 msnm)');
    expect(text).toContain('• A 14.4 m del apagado total (2098 msnm)');
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
    expect(text).toContain('💧Cota: 1987.5 msnm\nA 12.5 m de la cota mínima');
    expect(text).not.toContain('nivel crítico');
    expect(text).not.toContain('apagado total');
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
