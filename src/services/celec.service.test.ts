import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { CelecService } from './celec.service.js';
import { HydroelectricPlant } from '../types/hydroelectric.js';

vi.mock('axios');

describe('CelecService', () => {
  let service: CelecService;

  // Mock plant configurations for tests
  const mockMazarPlant: HydroelectricPlant = {
    name: 'Mazar',
    isPauteComplex: true,
    forecastSource: 'multivariate',
    celec: {
      prefix: 'maz',
      flowId: '30538',
      levelId: '30031',
      turbinesId: '30503',
    }
  };

  const mockCelecSur: HydroelectricPlant = {
    name: 'CELEC EP SUR',
    isPauteComplex: false,
    forecastSource: 'none',
    celec: {
      prefix: 'csr',
      flowId: '24812'
    }
  };

  beforeEach(() => {
    service = new CelecService();
    vi.clearAllMocks();
  });

  it('should correctly format date parts for Ecuador (GMT-5)', () => {
    // 2026-06-23 10:00:00 UTC -> 2026-06-23 05:00:00 GMT-5
    const date = new Date('2026-06-23T10:00:00.000Z');
    const parts = (service as any).getEcuadorDateParts(date);
    expect(parts).toEqual({ year: '2026', month: '06', day: '23' });
    
    // 2026-06-23 03:00:00 UTC -> 2026-06-22 22:00:00 GMT-5 (crosses day boundary!)
    const dateBoundary = new Date('2026-06-23T03:00:00.000Z');
    const partsBoundary = (service as any).getEcuadorDateParts(dateBoundary);
    expect(partsBoundary).toEqual({ year: '2026', month: '06', day: '22' });
  });

  it('should fetch and reverse point values in chronological order using optional default today date', async () => {
    const mockData = {
      data: {
        items: [
          { loctimestamp: '2026-06-23T07:00:00Z', valueedit: '150.5' }, // 2nd hour (in reverse list)
          { loctimestamp: '2026-06-23T06:00:00Z', valueedit: '148.2' }  // 1st hour
        ]
      }
    };
    (axios.get as any).mockResolvedValue(mockData);

    // Call without date parameter (defaults to today)
    const result = await service.fetchFlow(mockMazarPlant);
    
    // Assert parameters passed to Axios (date is automatically calculated)
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/sardomcsr/pointValues'),
      expect.objectContaining({
        params: expect.objectContaining({
          mrid: '30538'
        })
      })
    );

    // Assert mapped and reversed output
    expect(result).toEqual([
      { timestamp: '2026-06-23T06:00:00Z', value: 148.2 },
      { timestamp: '2026-06-23T07:00:00Z', value: 150.5 }
    ]);
  });

  it('should fetch daily energy in chronological order for a specific date', async () => {
    const mockData = {
      data: {
        items: [
          { loctimestamp: '2026-06-23T07:00:00Z', valueedit: '120.0' },
          { loctimestamp: '2026-06-23T06:00:00Z', valueedit: '110.5' }
        ]
      }
    };
    (axios.get as any).mockResolvedValue(mockData);

    const result = await service.fetchDailyEnergy(mockMazarPlant, new Date('2026-06-23T12:00:00.000Z'));
    
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/sardommaz/mazEnerDia'),
      expect.objectContaining({
        params: expect.objectContaining({
          fecha: '23/06/2026 00:00:00' // Midnight for energy
        })
      })
    );

    expect(result).toEqual([
      { timestamp: '2026-06-23T06:00:00Z', value: 110.5 },
      { timestamp: '2026-06-23T07:00:00Z', value: 120.0 }
    ]);
  });

  it('should throw safety error if plant lacks celec settings or target ID', async () => {
    // CELEC EP SUR has no levelId configuration
    await expect(service.fetchLevel(mockCelecSur)).rejects.toThrow(
      '[CelecService] Plant "CELEC EP SUR" does not support level measurements.'
    );
  });
});
