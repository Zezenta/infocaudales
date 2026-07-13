import axios from 'axios';
import * as https from 'https';
import { HydroelectricPlant } from '../types/hydroelectric.js';

export interface CelecPointValue {
  timestamp: string; // ISO string or loctimestamp
  value: number | null;
}

export class CelecService {
  private readonly baseUrl = 'https://generacioncsr.celec.gob.ec:8443/ords/csr';
  private readonly agent = new https.Agent({ rejectUnauthorized: false });

  /**
   * Helper to format a Date into Ecuador (GMT-5) components and current local hour
   */
  public getEcuadorDateParts(date: Date = new Date()) {
    const ecDate = new Date(date.getTime() - 5 * 60 * 60 * 1000);
    const year = ecDate.getUTCFullYear().toString();
    const month = (ecDate.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = ecDate.getUTCDate().toString().padStart(2, '0');
    const hora = ecDate.getUTCHours();
    return { year, month, day, hora };
  }

  /**
   * Request wrapper with automatic retries and exponential backoff
   */
  private async requestWithRetry<T>(fn: () => Promise<T>, retries = 3, delay = 2000): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (retries <= 0) throw error;
      console.warn(`[CelecService] Request failed, retrying in ${delay}ms... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return this.requestWithRetry(fn, retries - 1, delay * 2);
    }
  }

  /**
   * Private low-level helper to query pointValues endpoint by raw mrid.
   * CELEC returns items array ordered such that index (24 - hora) corresponds to the current local hour.
   */
  private async fetchPointValuesRaw(mrid: string, date: Date): Promise<CelecPointValue[]> {
    const { year, month, day } = this.getEcuadorDateParts(date);
    const fechaInicio = `${year}-${month}-${day}T06:00:00.000Z`;
    
    const startDateObj = new Date(fechaInicio);
    const endDateObj = new Date(startDateObj.getTime() + 23 * 60 * 60 * 1000);
    const fechaFin = endDateObj.toISOString();

    const fechaStr = `${day}/${month}/${year} 01:00:00`;

    return this.requestWithRetry(async () => {
      const response = await axios.get(`${this.baseUrl}/sardomcsr/pointValues`, {
        httpsAgent: this.agent,
        timeout: 15000,
        params: {
          mrid: mrid,
          fechaInicio: fechaInicio,
          fechaFin: fechaFin,
          fecha: fechaStr
        }
      });

      const items = response.data?.items || [];
      return items.map((item: any) => ({
        timestamp: item.loctimestamp,
        value: item.valueedit === null ? null : Number(item.valueedit)
      }));
    });
  }

  /**
   * Fetches hourly inflows for a specific hydroelectric plant.
   */
  public async fetchFlow(plant: HydroelectricPlant, date: Date = new Date()): Promise<CelecPointValue[]> {
    if (!plant.celec || !plant.celec.flowId) {
      throw new Error(`[CelecService] Plant "${plant.name}" does not support flow measurements.`);
    }
    return this.fetchPointValuesRaw(plant.celec.flowId, date);
  }

  /**
   * Fetches reservoir levels (Cota) for a specific hydroelectric plant.
   */
  public async fetchLevel(plant: HydroelectricPlant, date: Date = new Date()): Promise<CelecPointValue[]> {
    if (!plant.celec || !plant.celec.levelId) {
      throw new Error(`[CelecService] Plant "${plant.name}" does not support level measurements.`);
    }
    return this.fetchPointValuesRaw(plant.celec.levelId, date);
  }

  /**
   * Fetches active turbines for a specific hydroelectric plant.
   */
  public async fetchActiveTurbines(plant: HydroelectricPlant, date: Date = new Date()): Promise<CelecPointValue[]> {
    if (!plant.celec || !plant.celec.turbinesId) {
      throw new Error(`[CelecService] Plant "${plant.name}" does not support active turbine status.`);
    }
    return this.fetchPointValuesRaw(plant.celec.turbinesId, date);
  }

  /**
   * Fetches daily energy generated (MW) for a specific hydroelectric plant.
   */
  public async fetchDailyEnergy(plant: HydroelectricPlant, date: Date = new Date()): Promise<CelecPointValue[]> {
    if (!plant.celec || !plant.celec.prefix) {
      throw new Error(`[CelecService] Plant "${plant.name}" does not support daily energy queries.`);
    }

    const { prefix } = plant.celec;
    const { year, month, day } = this.getEcuadorDateParts(date);
    const fechaStr = `${day}/${month}/${year} 00:00:00`;

    return this.requestWithRetry(async () => {
      const response = await axios.get(`${this.baseUrl}/sardom${prefix}/${prefix}EnerDia`, {
        httpsAgent: this.agent,
        timeout: 45000,
        params: {
          fecha: fechaStr
        }
      });

      const items = response.data?.items || [];
      return items.map((item: any) => ({
        timestamp: item.loctimestamp,
        value: item.valueedit === null ? null : Number(item.valueedit)
      }));
    });
  }
}
