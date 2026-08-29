/**
 * Energie-Akkumulation und Historie (permanentes Energiegedächtnis).
 *
 * Läuft serverseitig, unabhängig vom Browser (Engine ruft integrate() auf).
 * - Integriert Live-Leistungen (W) zu Energiemengen (Wh), je Wechselrichter/Speicher.
 * - Führt die Tageskurve (1-Minuten-Auflösung) mit Werten je Gerät.
 * - Persistiert: Tagesaggregate (history.json), heutiger Zwischenstand (today.json)
 *   und je abgeschlossenem Tag ein Archiv (days/YYYY-MM-DD.json) mit voller Kurve.
 *
 * Migrationssicher: Bestehende Historie wird nur ergänzt, nie gelöscht.
 * Zeitzone: lokale Maschinenzeit (Haus). Tagesgrenzen bei lokaler Mitternacht,
 * Sommer-/Winterzeit über Date berücksichtigt.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  aggregateStorage,
  autarkyPercent,
  computeCosts,
  consumptionSources,
  emptyTotals,
  productionSinks,
  selfConsumptionPercent,
  totalBatteryChargeWh,
  totalBatteryDischargeWh,
  type EnergyTotals,
  type Tariff,
} from '@energy/core';

import type { EngineState } from './engine.ts';
import { writeJsonAtomic } from './persist.ts';

export interface DailyRecord {
  readonly date: string; // YYYY-MM-DD (lokale Zeit)
  readonly totals: EnergyTotals;
}

/** Ein Punkt der Tageskurve. Leistungen in W, SOC in %. */
export interface SeriesPoint {
  readonly t: number; // Unix ms
  readonly pv: number | null;
  readonly house: number | null;
  readonly gridImport: number | null;
  readonly gridExport: number | null;
  /** PV je Wechselrichter (Connector-ID -> W). */
  readonly inv: Record<string, number | null>;
  /** Je Speicher: p = Nettoleistung (+ laden, - entladen), soc = %. */
  readonly bat: Record<string, { p: number | null; soc: number | null }>;
  /** Kapazitätsgewichteter Gesamt-SOC. */
  readonly socAgg: number | null;
}

interface MutableTotals {
  productionWh: number;
  perInverterWh: Record<string, number>;
  houseConsumptionWh: number;
  gridImportWh: number;
  gridExportWh: number;
  batteryChargeWh: Record<string, number>;
  batteryDischargeWh: Record<string, number>;
  evChargeWh: number;
}

const MAX_DT_SECONDS = 15;
const SERIES_INTERVAL_MS = 60_000;

export interface AccumulatorOptions {
  readonly dataDir: string;
  readonly pvSources: readonly string[];
  readonly names: Readonly<Record<string, string>>;
  readonly tariff: Tariff;
}

export class EnergyAccumulator {
  private readonly dataDir: string;
  private readonly daysDir: string;
  private readonly pvSources: readonly string[];
  private readonly names: Readonly<Record<string, string>>;
  private tariff: Tariff;

  private history: DailyRecord[] = [];
  private today: MutableTotals = freshTotals();
  private currentDate: string;
  private series: SeriesPoint[] = [];
  private lastIntegrationAt: number | null = null;
  private lastSeriesAt = 0;
  private dirty = false;

  private readonly startedAt = new Date();
  /** Geräte-Metadaten für die Beschriftung der Serien (deviceId/id -> Name). */
  private batteryNames: Record<string, string> = {};
  private batteryCaps: Record<string, number | null> = {};

  constructor(options: AccumulatorOptions) {
    this.dataDir = options.dataDir;
    this.daysDir = resolve(this.dataDir, 'days');
    this.pvSources = options.pvSources;
    this.names = options.names;
    this.tariff = options.tariff;
    this.currentDate = localDate(new Date());

    mkdirSync(this.daysDir, { recursive: true });
    this.load();

    setInterval(() => this.persistIfDirty(), 120_000).unref();
  }

  integrate(state: EngineState): void {
    const now = state.polledAt.getTime();
    const date = localDate(state.polledAt);
    if (date !== this.currentDate) this.rollover(date);

    const previous = this.lastIntegrationAt;
    this.lastIntegrationAt = now;
    if (previous === null) return;

    const dtSeconds = Math.min(MAX_DT_SECONDS, (now - previous) / 1000);
    if (dtSeconds <= 0) return;
    const hours = dtSeconds / 3600;

    const snap = state.resolution.snapshot;

    addEnergy(this.today, 'productionWh', snap.solarProductionW.valueW, hours);
    addEnergy(this.today, 'houseConsumptionWh', snap.houseConsumptionW.valueW, hours);
    addEnergy(this.today, 'gridImportWh', snap.gridImportW.valueW, hours);
    addEnergy(this.today, 'gridExportWh', snap.gridExportW.valueW, hours);

    for (const reading of state.readings) {
      if (!this.pvSources.includes(reading.connectorId)) continue;
      const w = reading.solarProductionW?.valueW ?? null;
      if (w !== null && Number.isFinite(w) && w >= 0) {
        this.today.perInverterWh[reading.connectorId] =
          (this.today.perInverterWh[reading.connectorId] ?? 0) + w * hours;
      }
    }

    // Wallbox: eigene Energiesumme. Sie wird NICHT zum Hausverbrauch addiert —
    // dort ist sie physikalisch bereits enthalten (Wallbox hängt hinter dem
    // Hauszähler). Hier nur separat mitgeschrieben, um sie ausweisen zu können.
    const evW = snap.evCharger?.chargePowerW ?? null;
    if (evW !== null && Number.isFinite(evW) && evW > 0) {
      this.today.evChargeWh += evW * hours;
    }

    for (const battery of snap.batteries) {
      this.batteryNames[battery.deviceId] = battery.displayName;
      this.batteryCaps[battery.deviceId] = battery.usableCapacityWh;
      if (battery.chargeW !== null && battery.chargeW > 0) {
        this.today.batteryChargeWh[battery.deviceId] =
          (this.today.batteryChargeWh[battery.deviceId] ?? 0) + battery.chargeW * hours;
      }
      if (battery.dischargeW !== null && battery.dischargeW > 0) {
        this.today.batteryDischargeWh[battery.deviceId] =
          (this.today.batteryDischargeWh[battery.deviceId] ?? 0) + battery.dischargeW * hours;
      }
    }

    this.dirty = true;
    this.maybeAppendSeries(state, now);
  }

  private maybeAppendSeries(state: EngineState, now: number): void {
    if (now - this.lastSeriesAt < SERIES_INTERVAL_MS) return;
    this.lastSeriesAt = now;

    const snap = state.resolution.snapshot;
    const inv: Record<string, number | null> = {};
    for (const reading of state.readings) {
      if (this.pvSources.includes(reading.connectorId)) {
        inv[reading.connectorId] = reading.solarProductionW?.valueW ?? null;
      }
    }
    const bat: Record<string, { p: number | null; soc: number | null }> = {};
    for (const b of snap.batteries) {
      const p =
        b.chargeW !== null || b.dischargeW !== null
          ? (b.chargeW ?? 0) - (b.dischargeW ?? 0)
          : null;
      bat[b.deviceId] = { p, soc: b.socPercent };
    }
    const agg = aggregateStorage(
      snap.batteries.map((b) => ({ usableCapacityWh: b.usableCapacityWh, socPercent: b.socPercent })),
    );

    this.series.push({
      t: now,
      pv: snap.solarProductionW.valueW,
      house: snap.houseConsumptionW.valueW,
      gridImport: snap.gridImportW.valueW,
      gridExport: snap.gridExportW.valueW,
      inv,
      bat,
      socAgg: agg.socPercent,
    });
  }

  private rollover(newDate: string): void {
    // Vollständige Tageskurve + Aggregat des abgeschlossenen Tages archivieren.
    this.archiveDay(this.currentDate, toReadonly(this.today), this.series);

    this.history = this.history.filter((r) => r.date !== this.currentDate);
    this.history.push({ date: this.currentDate, totals: toReadonly(this.today) });
    this.history.sort((a, b) => a.date.localeCompare(b.date));

    this.today = freshTotals();
    this.series = [];
    this.currentDate = newDate;
    this.persist();
  }

  private archiveDay(date: string, totals: EnergyTotals, series: readonly SeriesPoint[]): void {
    try {
      writeJsonAtomic(resolve(this.daysDir, `${date}.json`), {
        date,
        totals,
        series,
        batteryNames: this.batteryNames,
        batteryCaps: this.batteryCaps,
        quality: 'local_live',
      });
    } catch (error) {
      console.warn(`Tag ${date} konnte nicht archiviert werden:`, error);
    }
  }

  setTariff(tariff: Tariff): void {
    this.tariff = tariff;
    this.persist();
  }
  getTariff(): Tariff {
    return this.tariff;
  }

  todayView(): unknown {
    return this.dayView(this.currentDate);
  }
  todaySeries(): readonly SeriesPoint[] {
    return this.series;
  }

  /** Vollständige Tagesansicht für ein beliebiges Datum (heute = live). */
  dayView(date: string): unknown {
    const isToday = date === this.currentDate;
    let totals: EnergyTotals | null = null;
    let series: readonly SeriesPoint[] = [];
    let names = this.batteryNames;
    let caps = this.batteryCaps;
    let quality = 'local_live';

    if (isToday) {
      totals = toReadonly(this.today);
      series = this.series;
    } else {
      const archived = this.loadDay(date);
      if (archived) {
        totals = archived.totals;
        series = archived.series;
        names = archived.batteryNames ?? this.batteryNames;
        caps = archived.batteryCaps ?? this.batteryCaps;
        quality = archived.quality ?? 'local_live';
      } else {
        // Kein Kurven-Archiv, aber evtl. ein Aggregat aus history.json.
        const rec = this.recordFor(date);
        if (rec) {
          totals = rec.totals;
          quality = 'aggregated';
        }
      }
    }

    if (totals === null) {
      return { date, isToday, hasData: false, hasSeries: false };
    }

    const prev = this.aggregateFor(shiftDate(date, -1));
    return {
      date,
      isToday,
      hasData: true,
      hasSeries: series.length > 1,
      quality,
      totals,
      derived: this.derive(totals),
      inverters: Object.keys(totals.perInverterWh).map((id) => ({
        id,
        name: this.names[id] ?? id,
      })),
      batteries: unionKeys(Object.keys(names), batteryIds(totals)).map((deviceId) => ({
        deviceId,
        name: names[deviceId] ?? deviceId,
        usableCapacityWh: caps[deviceId] ?? null,
        chargeWh: totals.batteryChargeWh[deviceId] ?? 0,
        dischargeWh: totals.batteryDischargeWh[deviceId] ?? 0,
      })),
      comparison: prev ? { previous: this.derive(prev), previousTotals: prev } : null,
      series,
    };
  }

  historyView(range: 'day' | 'month' | 'year' | 'total'): unknown {
    const all = [...this.history, { date: this.currentDate, totals: toReadonly(this.today) }];
    if (range === 'day' || range === 'month') return { range, days: all.slice(-31) };
    if (range === 'year') return { range, months: aggregateByMonth(all).slice(-12) };
    return { range, months: aggregateByMonth(all), lifetime: sumAll(all) };
  }

  /** Zustand des Datensammlers für die Admin-/Diagnoseansicht. */
  collectorHealth(): unknown {
    return {
      running: true,
      startedAt: this.startedAt.toISOString(),
      lastMeasurementAt: this.lastIntegrationAt ? new Date(this.lastIntegrationAt).toISOString() : null,
      currentDate: this.currentDate,
      pointsToday: this.series.length,
      seriesIntervalSeconds: SERIES_INTERVAL_MS / 1000,
      // Nur abgeschlossene Tage zählen, nicht der laufende (heutige) Tag.
      archivedDays: this.availableDates().filter((d) => d !== this.currentDate).length,
    };
  }

  /** Datumsangaben mit vorhandener Kurve oder Aggregat (für Datumsauswahl). */
  availableDates(): string[] {
    const set = new Set<string>();
    for (const r of this.history) set.add(r.date);
    try {
      for (const f of readdirSync(this.daysDir)) {
        if (f.endsWith('.json')) set.add(f.slice(0, -5));
      }
    } catch {
      /* Verzeichnis evtl. noch leer */
    }
    set.add(this.currentDate);
    return [...set].sort();
  }

  private aggregateFor(date: string): EnergyTotals | null {
    if (date === this.currentDate) return toReadonly(this.today);
    const rec = this.recordFor(date);
    if (rec) return rec.totals;
    const archived = this.loadDay(date);
    return archived ? archived.totals : null;
  }

  private derive(totals: EnergyTotals): unknown {
    return {
      autarkyPercent: autarkyPercent(totals),
      selfConsumptionPercent: selfConsumptionPercent(totals),
      consumptionSources: consumptionSources(totals),
      productionSinks: productionSinks(totals),
      batteryChargeWh: totalBatteryChargeWh(totals),
      batteryDischargeWh: totalBatteryDischargeWh(totals),
      costs: computeCosts(totals, this.tariff),
    };
  }

  private recordFor(date: string): DailyRecord | null {
    return this.history.find((r) => r.date === date) ?? null;
  }

  // ── Persistenz ────────────────────────────────────────────────────
  private historyPath(): string {
    return resolve(this.dataDir, 'history.json');
  }
  private tariffPath(): string {
    return resolve(this.dataDir, 'tariff.json');
  }
  private todayPath(): string {
    return resolve(this.dataDir, 'today.json');
  }

  private loadDay(date: string): {
    totals: EnergyTotals;
    series: SeriesPoint[];
    batteryNames?: Record<string, string>;
    batteryCaps?: Record<string, number | null>;
    quality?: string;
  } | null {
    const path = resolve(this.daysDir, `${date}.json`);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed?.totals) return null;
      return {
        totals: parsed.totals,
        series: Array.isArray(parsed.series) ? parsed.series : [],
        batteryNames: parsed.batteryNames,
        batteryCaps: parsed.batteryCaps,
        quality: parsed.quality,
      };
    } catch {
      return null;
    }
  }

  private load(): void {
    try {
      if (existsSync(this.historyPath())) {
        const parsed = JSON.parse(readFileSync(this.historyPath(), 'utf8'));
        if (Array.isArray(parsed?.days)) this.history = parsed.days as DailyRecord[];
      }
      if (existsSync(this.tariffPath())) {
        this.tariff = { ...this.tariff, ...JSON.parse(readFileSync(this.tariffPath(), 'utf8')) };
      }
      if (existsSync(this.todayPath())) {
        const parsed = JSON.parse(readFileSync(this.todayPath(), 'utf8'));
        if (parsed?.date === this.currentDate && parsed.totals) {
          this.today = toMutable(parsed.totals as EnergyTotals);
          if (Array.isArray(parsed.series)) {
            this.series = parsed.series as SeriesPoint[];
            // Ohne diese Zeile stand lastSeriesAt nach einem Neustart auf 0:
            // Der erste Messzyklus setzte dann sofort einen weiteren Punkt,
            // wenige Sekunden nach dem zuletzt gespeicherten. Die Kurve bekam
            // bei jedem Start einen Doppelpunkt.
            const last = this.series[this.series.length - 1];
            if (last && Number.isFinite(last.t)) this.lastSeriesAt = last.t;
          }
          if (parsed.batteryNames) this.batteryNames = parsed.batteryNames;
          if (parsed.batteryCaps) this.batteryCaps = parsed.batteryCaps;
        } else if (parsed?.date && parsed.date !== this.currentDate && parsed.totals) {
          // today.json stammt von einem früheren Tag (Server war über Mitternacht
          // aus): diesen Tag noch archivieren, damit seine Kurve nicht verloren geht.
          this.archiveDayFrom(parsed);
          this.history = this.history.filter((r) => r.date !== parsed.date);
          this.history.push({ date: parsed.date, totals: parsed.totals });
          this.history.sort((a, b) => a.date.localeCompare(b.date));
        }
      }
    } catch (error) {
      console.warn('Historie konnte nicht vollständig geladen werden:', error);
    }
  }

  private archiveDayFrom(parsed: {
    date: string;
    totals: EnergyTotals;
    series?: SeriesPoint[];
    batteryNames?: Record<string, string>;
    batteryCaps?: Record<string, number | null>;
  }): void {
    if (existsSync(resolve(this.daysDir, `${parsed.date}.json`))) return;
    if (parsed.batteryNames) this.batteryNames = parsed.batteryNames;
    if (parsed.batteryCaps) this.batteryCaps = parsed.batteryCaps;
    this.archiveDay(parsed.date, parsed.totals, parsed.series ?? []);
  }

  persist(): void {
    try {
      writeJsonAtomic(this.historyPath(), { days: this.history }, 2);
      writeJsonAtomic(this.tariffPath(), this.tariff, 2);
      writeJsonAtomic(this.todayPath(), {
        date: this.currentDate,
        totals: toReadonly(this.today),
        series: this.series,
        batteryNames: this.batteryNames,
        batteryCaps: this.batteryCaps,
      });
      this.dirty = false;
    } catch (error) {
      console.warn('Historie konnte nicht gespeichert werden:', error);
    }
  }

  private persistIfDirty(): void {
    if (this.dirty) this.persist();
  }
}

// ── Hilfen ────────────────────────────────────────────────────────────

function batteryIds(t: EnergyTotals): string[] {
  const set = new Set<string>();
  for (const k of Object.keys(t.batteryChargeWh)) set.add(k);
  for (const k of Object.keys(t.batteryDischargeWh)) set.add(k);
  return [...set];
}

function unionKeys(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function freshTotals(): MutableTotals {
  return {
    productionWh: 0,
    perInverterWh: {},
    houseConsumptionWh: 0,
    gridImportWh: 0,
    gridExportWh: 0,
    batteryChargeWh: {},
    batteryDischargeWh: {},
    evChargeWh: 0,
  };
}

function addEnergy(
  totals: MutableTotals,
  key: 'productionWh' | 'houseConsumptionWh' | 'gridImportWh' | 'gridExportWh',
  watts: number | null,
  hours: number,
): void {
  if (watts === null || !Number.isFinite(watts) || watts < 0) return;
  totals[key] += watts * hours;
}

function toReadonly(t: MutableTotals): EnergyTotals {
  return {
    productionWh: t.productionWh,
    perInverterWh: { ...t.perInverterWh },
    houseConsumptionWh: t.houseConsumptionWh,
    gridImportWh: t.gridImportWh,
    gridExportWh: t.gridExportWh,
    batteryChargeWh: { ...t.batteryChargeWh },
    batteryDischargeWh: { ...t.batteryDischargeWh },
    evChargeWh: t.evChargeWh,
  };
}

function toMutable(t: EnergyTotals): MutableTotals {
  return {
    productionWh: t.productionWh,
    perInverterWh: { ...t.perInverterWh },
    houseConsumptionWh: t.houseConsumptionWh,
    gridImportWh: t.gridImportWh,
    gridExportWh: t.gridExportWh,
    batteryChargeWh: { ...t.batteryChargeWh },
    batteryDischargeWh: { ...t.batteryDischargeWh },
    evChargeWh: t.evChargeWh,
  };
}

export function localDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`); // Mittag: DST-Wechsel verschiebt das Datum nicht
  d.setDate(d.getDate() + days);
  return localDate(d);
}

function aggregateByMonth(records: readonly DailyRecord[]): unknown[] {
  const byMonth = new Map<string, EnergyTotals>();
  for (const record of records) {
    const month = record.date.slice(0, 7);
    byMonth.set(month, addTotals(byMonth.get(month) ?? emptyTotals(), record.totals));
  }
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, totals]) => ({ month, totals }));
}

function sumAll(records: readonly DailyRecord[]): EnergyTotals {
  let acc = emptyTotals();
  for (const record of records) acc = addTotals(acc, record.totals);
  return acc;
}

function addTotals(a: EnergyTotals, b: EnergyTotals): EnergyTotals {
  const mergeRecord = (
    x: Readonly<Record<string, number>>,
    y: Readonly<Record<string, number>>,
  ): Record<string, number> => {
    const out: Record<string, number> = { ...x };
    for (const [k, v] of Object.entries(y)) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  return {
    productionWh: a.productionWh + b.productionWh,
    perInverterWh: mergeRecord(a.perInverterWh, b.perInverterWh),
    houseConsumptionWh: a.houseConsumptionWh + b.houseConsumptionWh,
    gridImportWh: a.gridImportWh + b.gridImportWh,
    gridExportWh: a.gridExportWh + b.gridExportWh,
    batteryChargeWh: mergeRecord(a.batteryChargeWh, b.batteryChargeWh),
    batteryDischargeWh: mergeRecord(a.batteryDischargeWh, b.batteryDischargeWh),
    evChargeWh: a.evChargeWh + b.evChargeWh,
  };
}
