import axios from 'axios';
import * as https from 'https';
import { HydroelectricPlant } from '../types/hydroelectric.js';

// Type definitions for output values
export interface SystemCurvePoint {
  time: string; // e.g., "10:30"
  demandMW: number | null;
  totalHydroMW: number | null;
  totalThermalMW: number | null;
  importsMW: number | null;
  exportsMW: number | null;
  renewableMW: number | null;
}

export interface LiveProductionData {
  compositionMWh: Record<string, number>;      // Matrix share (e.g. { HYDRO: 22488, THERMAL: 2847 })
  plantsAccumulatedMWh: Record<string, number>; // e.g. { cocaCodoSinclair: 6468, molino: 5402 }
  generationCurve: SystemCurvePoint[];         // 30-min intervals of power curves (MW)
}

export interface LiveDemandData {
  cnelVsOthersMW: Record<string, number>;
  distributorsMW: Record<string, number>;      // e.g. { eeQuito: 554.6, cnelGuayaquil: 782.3 }
}

export interface YesterdayOperationalData {
  compositionMWh: Record<string, number>;
  plantsDailyTotalMWh: Record<string, number>;  // Yesterday's total output (MWh)
  generationCurve: SystemCurvePoint[];          // Full 24-hour power curve for yesterday
}

export interface MonthlyAccumulatedData {
  compositionMWh: Record<string, number>;
  plantsMonthlyTotalMWh: Record<string, number>; // Monthly total output (MWh)
  generationCurve: SystemCurvePoint[];
}

export interface YearlyAccumulatedData {
  compositionGWh: Record<string, number>;
  plantsYearlyTotalGWh: Record<string, number>;  // Yearly total output (GWh)
  generationCurve: SystemCurvePoint[];
}

export class CenaceService {
  private readonly url = 'https://www.cenace.gob.ec/info-operativa/InformacionOperativa.htm';
  private readonly agent = new https.Agent({ rejectUnauthorized: false });

  /**
   * Request wrapper with automatic retries and exponential backoff
   */
  private async requestWithRetry<T>(fn: () => Promise<T>, retries = 3, delay = 2000): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (retries <= 0) throw error;
      console.warn(`[CenaceService] Request failed, retrying in ${delay}ms... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return this.requestWithRetry(fn, retries - 1, delay * 2);
    }
  }

  /**
   * Main method to scrape the CENACE page and extract all Plotly datasets in order.
   */
  private async fetchPlotlyDatasets(): Promise<any[]> {
    return this.requestWithRetry(async () => {
      const response = await axios.get(this.url, {
        httpsAgent: this.agent,
        timeout: 25000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const html = response.data;
      const regex = /Plotly\.newPlot\(\s*['"][^'"]+['"]\s*,\s*(\[[\s\S]*?\])\s*,\s*(\{[\s\S]*?\})/g;
      
      const datasets: any[] = [];
      let match;
      while ((match = regex.exec(html)) !== null) {
        try {
          datasets.push(JSON.parse(match[1]));
        } catch (parseError) {
          console.error('[CenaceService] Failed to parse Plotly dataset JSON:', parseError);
        }
      }
      return datasets;
    });
  }

  /**
   * Decodes Plotly base64-encoded float64 arrays into standard numeric arrays.
   */
  private decodePlotlyArray(val: any): (number | null)[] {
    if (Array.isArray(val)) {
      return val.map(v => v === null ? null : Number(v));
    }
    if (val && typeof val === 'object' && val.bdata && val.dtype === 'f8') {
      const buf = Buffer.from(val.bdata, 'base64');
      const floats = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
      return Array.from(floats).map(v => isNaN(v) ? null : v);
    }
    return [];
  }

  /**
   * Helper to parse plant generation lists (bar charts)
   */
  private parsePlantBarChart(dataset: any[]): Record<string, number> {
    const plants: Record<string, number> = {};
    if (!dataset || !Array.isArray(dataset)) return plants;

    for (const trace of dataset) {
      if (trace.name && trace.y && trace.y.length > 0) {
        const rawName = trace.name.toLowerCase().trim();
        let key = rawName;
        if (rawName.includes('coca codo')) key = 'cocaCodoSinclair';
        else if (rawName.includes('paute')) key = 'molino';
        else if (rawName.includes('sopladora')) key = 'sopladora';
        else if (rawName.includes('delsitanisagua')) key = 'delsitanisagua';
        else if (rawName.includes('san francisco')) key = 'sanFrancisco';
        else if (rawName.includes('mazar')) key = 'mazar';
        else if (rawName.includes('agoyán') || rawName.includes('agoyan')) key = 'agoyan';
        else if (rawName.includes('minas')) key = 'minasSanFrancisco';
        else if (rawName.includes('otras')) key = 'otherHydro';

        plants[key] = Number(trace.y[0]);
      }
    }
    return plants;
  }

  /**
   * Helper to parse composition pie charts
   */
  private parseCompositionPieChart(dataset: any[]): Record<string, number> {
    const composition: Record<string, number> = {};
    if (!dataset || dataset.length === 0) return composition;

    const trace = dataset[0];
    if (trace && trace.values && trace.labels) {
      for (let i = 0; i < trace.labels.length; i++) {
        const label = trace.labels[i].toUpperCase().trim();
        composition[label] = Number(trace.values[i]);
      }
    }
    return composition;
  }

  /**
   * Helper to parse hourly power curve scatter charts
   */
  private parseSystemCurve(dataset: any[]): SystemCurvePoint[] {
    const curvePoints: SystemCurvePoint[] = [];
    if (!dataset || dataset.length === 0) return curvePoints;

    const times = dataset[0].x || [];
    if (times.length === 0) return curvePoints;

    const dataMap: Record<string, (number | null)[]> = {};
    for (const trace of dataset) {
      if (trace.name) {
        const decodedY = this.decodePlotlyArray(trace.y);
        dataMap[trace.name.toUpperCase().trim()] = decodedY;
      }
    }

    for (let i = 0; i < times.length; i++) {
      curvePoints.push({
        time: times[i],
        demandMW: dataMap['DEMANDA NACIONAL']?.[i] ?? null,
        totalHydroMW: dataMap['HIDRÁULICA']?.[i] ?? dataMap['HIDRAULICA']?.[i] ?? null,
        totalThermalMW: dataMap['TÉRMICA']?.[i] ?? dataMap['TERMICA']?.[i] ?? null,
        importsMW: dataMap['IMPORTACIÓN']?.[i] ?? dataMap['IMPORTACION']?.[i] ?? null,
        exportsMW: dataMap['EXPORTACIÓN']?.[i] ?? dataMap['EXPORTACION']?.[i] ?? null,
        renewableMW: dataMap['RENOVABLE']?.[i] ?? null
      });
    }

    return curvePoints;
  }

  /**
   * Resolves a plant argument (HydroelectricPlant object or string key) into a normalized string key.
   */
  private resolvePlantKey(plant: HydroelectricPlant | string): string {
    if (typeof plant === 'string') return plant;
    if (plant && plant.name) {
      const name = plant.name.toLowerCase();
      if (name.includes('coca codo')) return 'cocaCodoSinclair';
      if (name.includes('molino') || name.includes('paute')) return 'molino';
      if (name.includes('sopladora')) return 'sopladora';
      if (name.includes('mazar')) return 'mazar';
      if (name.includes('agoyán') || name.includes('agoyan')) return 'agoyan';
      if (name.includes('minas')) return 'minasSanFrancisco';
      return name;
    }
    return String(plant);
  }

  // --- PLANT SPECIFIC TARGETED METHODS (Celec-style API) ---

  /**
   * Fetches real-time accumulated energy output (MWh) for a specific hydroelectric plant.
   */
  public async fetchPlantProduction(plant: HydroelectricPlant | string): Promise<number | null> {
    const key = this.resolvePlantKey(plant);
    const live = await this.fetchRealTimeProduction();
    return live.plantsAccumulatedMWh[key] ?? null;
  }

  /**
   * Fetches yesterday's total energy output (MWh) for a specific hydroelectric plant.
   */
  public async fetchPlantYesterdayProduction(plant: HydroelectricPlant | string): Promise<number | null> {
    const key = this.resolvePlantKey(plant);
    const yesterday = await this.fetchYesterdayOperationalData();
    return yesterday.plantsDailyTotalMWh[key] ?? null;
  }

  /**
   * Fetches current monthly total energy output (MWh) for a specific hydroelectric plant.
   */
  public async fetchPlantMonthlyProduction(plant: HydroelectricPlant | string): Promise<number | null> {
    const key = this.resolvePlantKey(plant);
    const monthly = await this.fetchMonthlyAccumulatedData();
    return monthly.plantsMonthlyTotalMWh[key] ?? null;
  }

  /**
   * Fetches current yearly total energy output (GWh) for a specific hydroelectric plant.
   */
  public async fetchPlantYearlyProduction(plant: HydroelectricPlant | string): Promise<number | null> {
    const key = this.resolvePlantKey(plant);
    const yearly = await this.fetchYearlyAccumulatedData();
    return yearly.plantsYearlyTotalGWh[key] ?? null;
  }

  // --- GLOBAL GRID SYSTEM METHODS ---

  /**
   * Tab 0: Scrapes real-time energy production and the 30-min system generation curves.
   */
  public async fetchRealTimeProduction(): Promise<LiveProductionData> {
    const datasets = await this.fetchPlotlyDatasets();
    if (datasets.length < 4) {
      throw new Error(`[CenaceService] Missing expected Tab 0 datasets (found ${datasets.length})`);
    }

    return {
      compositionMWh: this.parseCompositionPieChart(datasets[0]),
      plantsAccumulatedMWh: this.parsePlantBarChart(datasets[1]),
      generationCurve: this.parseSystemCurve(datasets[3])
    };
  }

  /**
   * Tab 1: Scrapes real-time power demand distributed by regional distribution companies.
   */
  public async fetchRealTimeDemand(): Promise<LiveDemandData> {
    const datasets = await this.fetchPlotlyDatasets();
    if (datasets.length < 6) {
      throw new Error(`[CenaceService] Missing expected Tab 1 datasets (found ${datasets.length})`);
    }

    const cnelVsOthers = this.parseCompositionPieChart(datasets[4]);
    
    const distributors: Record<string, number> = {};
    const trace = datasets[5]?.[0];
    if (trace && trace.x && trace.y) {
      const decodedX = this.decodePlotlyArray(trace.x);
      for (let i = 0; i < trace.y.length; i++) {
        distributors[trace.y[i]] = decodedX[i] || 0;
      }
    }

    return {
      cnelVsOthersMW: cnelVsOthers,
      distributorsMW: distributors
    };
  }

  /**
   * Tab 2: Scrapes yesterday's final energy totals for the daily reporting cycle.
   */
  public async fetchYesterdayOperationalData(): Promise<YesterdayOperationalData> {
    const datasets = await this.fetchPlotlyDatasets();
    if (datasets.length < 10) {
      throw new Error(`[CenaceService] Missing expected Tab 2 datasets (found ${datasets.length})`);
    }

    return {
      compositionMWh: this.parseCompositionPieChart(datasets[6]),
      plantsDailyTotalMWh: this.parsePlantBarChart(datasets[7]),
      generationCurve: this.parseSystemCurve(datasets[9])
    };
  }

  /**
   * Tab 3: Scrapes the total MWh production accumulated during the current calendar month.
   */
  public async fetchMonthlyAccumulatedData(): Promise<MonthlyAccumulatedData> {
    const datasets = await this.fetchPlotlyDatasets();
    if (datasets.length < 14) {
      throw new Error(`[CenaceService] Missing expected Tab 3 datasets (found ${datasets.length})`);
    }

    return {
      compositionMWh: this.parseCompositionPieChart(datasets[10]),
      plantsMonthlyTotalMWh: this.parsePlantBarChart(datasets[11]),
      generationCurve: this.parseSystemCurve(datasets[13])
    };
  }

  /**
   * Tab 4: Scrapes the total GWh production accumulated during the current calendar year.
   */
  public async fetchYearlyAccumulatedData(): Promise<YearlyAccumulatedData> {
    const datasets = await this.fetchPlotlyDatasets();
    if (datasets.length < 18) {
      throw new Error(`[CenaceService] Missing expected Tab 4 datasets (found ${datasets.length})`);
    }

    return {
      compositionGWh: this.parseCompositionPieChart(datasets[14]),
      plantsYearlyTotalGWh: this.parsePlantBarChart(datasets[15]),
      generationCurve: this.parseSystemCurve(datasets[17])
    };
  }
}
