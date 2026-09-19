/**
 * Energie-Akkumulation und Historie (permanentes Energiegedächtnis).
 *
 * Läuft serverseitig, unabhängig vom Browser (Engine ruft integrate() auf).
 * - Integriert Live-Leistungen (W) zu Energiemengen (Wh), je Wechselrichter/Speicher.
 * - Führt die Tageskurve (1-Minuten-Auflösung) mit Werten je Gerät.
 * - Persistiert: Tagesaggregate (history.json), heutiger Zwischenstand (today.json)
 *   und je abgeschlossenem Tag ein Archiv (days/YYYY-MM-DD.json) mit voller Kurve.
 *
 * ── Integrationsregel ───────────────────────────────────────────────────────
 * Ein Messwert gilt vom Zeitpunkt seiner Messung bis zur nächsten Messung
 * (Halteglied). Das Intervall [vorher, jetzt] wird also mit den Werten von
 * VORHER gerechnet — nicht mit dem neuen Momentanwert, der sonst eine Lücke
 * rückwirkend auffüllen würde. Ist das Intervall länger als
 * `MAX_INTEGRATIONSSCHRITT_S`, ist es als Ganzes eine Lücke.
 *
 * Tagesgrenzen: Ein Intervall über lokale Mitternacht wird geteilt; jeder Teil
 * landet in seinem Tag. Grundlage ist die Zeitzone der Anlage (des Servers),
 * nicht die des Browsers — die Tagesansicht liefert deshalb Tagesbeginn und
 * -ende gleich mit.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  addiereZuordnung,
  bilanzwertW,
  computeCosts,
  consumptionSources,
  coverage,
  emptyTotals,
  istAktuell,
  LADEN_AB_W,
  leereZuordnung,
  MAX_INTEGRATIONSSCHRITT_S,
  productionSinks,
  pruefeTotals,
  quoten,
  speicherGesamt,
  totalBatteryChargeWh,
  totalBatteryDischargeWh,
  zuordneIntervall,
  type AbdeckungJeGroesse,
  type EnergyTotals,
  type Tariff,
  type Zuordnung,
} from '@energy/core';

import type { EngineState } from './engine.ts';
import { bewahreBeschaedigt, writeJsonAtomic } from './persist.ts';
import { Tarifverlauf } from './tarife.ts';

export interface DailyRecord {
  readonly date: string; // YYYY-MM-DD (lokale Zeit)
  readonly totals: EnergyTotals;
}

/**
 * Ein Punkt der Tageskurve. Leistungen in W, SOC in %.
 *
 * `null` heisst: an diesem Punkt gab es keine verwertbare Messung. Die Kurve
 * zeichnet dort eine Lücke, statt den letzten Wert fortzuführen.
 */
export interface SeriesPoint {
  readonly t: number; // Unix ms
  readonly pv: number | null;
  /** Hauszähler, Auto inklusive. */
  readonly house: number | null;
  readonly gridImport: number | null;
  readonly gridExport: number | null;
  /** PV je Wechselrichter (Connector-ID -> W). */
  readonly inv: Record<string, number | null>;
  /** Je Speicher: p = Nettoleistung (+ laden, - entladen), soc = %. */
  readonly bat: Record<string, { p: number | null; soc: number | null }>;
  /** Kapazitätsgewichteter Gesamt-SOC — nur wenn alle Speicher melden. */
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
  coveredSeconds: number;
  abdeckungJeGroesseS: { pv: number; haus: number; bezug: number; einspeisung: number };
  erfasstAbMs: number | null;
  zuordnung: Zuordnung;
}

/**
 * Der gehaltene Messwert am Beginn eines Intervalls.
 *
 * Nur verwertbare Werte, alles andere `null` — die Prüfung geschieht einmal,
 * beim Erfassen, und gilt für Summen und Kurve gleichermassen.
 */
interface Stichprobe {
  readonly tMs: number;
  readonly pv: number | null;
  readonly haus: number | null;
  readonly bezug: number | null;
  readonly einspeisung: number | null;
  readonly inv: Readonly<Record<string, number | null>>;
  readonly speicher: Readonly<Record<string, { laden: number; entladen: number } | null>>;
  /** Alle erwarteten Speicher liefern aktuelle Leistungswerte. */
  readonly speicherVollstaendig: boolean;
  readonly socAgg: number | null;
  readonly socJe: Readonly<Record<string, number | null>>;
  readonly ev: number | null;
}

const SERIES_INTERVAL_MS = 60_000;

export interface AccumulatorOptions {
  readonly dataDir: string;
  readonly pvSources: readonly string[];
  readonly names: Readonly<Record<string, string>>;
  /** Vorgabetarif aus config.json, solange kein gespeicherter bekannt ist. */
  readonly tariff: Tariff;
  /** Uhr — für Tests. */
  readonly jetzt?: () => number;
}

/** Lokaler Tagesbeginn und -ende eines Kalendertags, in ms. DST-fest. */
export function tagesgrenzen(date: string): { beginnMs: number; endeMs: number } {
  const [j, m, t] = date.split('-').map(Number) as [number, number, number];
  return {
    beginnMs: new Date(j, m - 1, t, 0, 0, 0, 0).getTime(),
    endeMs: new Date(j, m - 1, t + 1, 0, 0, 0, 0).getTime(),
  };
}

/** Der nächste lokale Tagesbeginn nach `ms`. */
function naechsterTagesbeginn(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

export class EnergyAccumulator {
  private readonly dataDir: string;
  private readonly daysDir: string;
  private readonly pvSources: readonly string[];
  private readonly names: Readonly<Record<string, string>>;
  private readonly jetzt: () => number;
  readonly tarife: Tarifverlauf;

  private history: DailyRecord[] = [];
  private today: MutableTotals = freshTotals();
  private currentDate: string;
  private series: SeriesPoint[] = [];
  private letzteProbe: Stichprobe | null = null;
  /** Letzte Erfassung, auch über einen Neustart hinweg. */
  private letzteErfassungMs: number | null = null;
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
    this.jetzt = options.jetzt ?? Date.now;
    this.currentDate = localDate(new Date(this.jetzt()));

    mkdirSync(this.daysDir, { recursive: true });
    this.tarife = new Tarifverlauf(
      resolve(this.dataDir, 'tariff.json'),
      options.tariff,
      () => localDate(new Date(this.jetzt())),
    );
    this.load();

    setInterval(() => this.persistIfDirty(), 120_000).unref();
  }

  /**
   * @param evLeistungW Am Hauszähler geprüfte, GEMESSENE Ladeleistung; `null`
   *   = unbekannt. Fehlt der Parameter, gilt der Wert der Wallbox.
   */
  integrate(state: EngineState, evLeistungW?: number | null): void {
    const probe = this.erfasse(state, evLeistungW);
    const vorher = this.letzteProbe;
    this.letzteProbe = probe;
    this.letzteErfassungMs = probe.tMs;
    this.dirty = true;

    if (vorher !== null && probe.tMs > vorher.tMs) {
      const gueltig = (probe.tMs - vorher.tMs) / 1000 <= MAX_INTEGRATIONSSCHRITT_S;
      let start = vorher.tMs;
      while (start < probe.tMs) {
        const tag = localDate(new Date(start));
        if (tag !== this.currentDate) this.rollover(tag);
        const ende = Math.min(probe.tMs, naechsterTagesbeginn(start));
        if (gueltig) this.integriere(vorher, start, (ende - start) / 1000);
        start = ende;
      }
    }

    const tag = localDate(new Date(probe.tMs));
    if (tag !== this.currentDate) this.rollover(tag);
    if (this.today.erfasstAbMs === null) this.today.erfasstAbMs = probe.tMs;
    this.maybeAppendSeries(probe);
  }

  /** Macht aus dem Engine-Zustand eine geprüfte Stichprobe. */
  private erfasse(state: EngineState, evLeistungW: number | null | undefined): Stichprobe {
    const snap = state.resolution.snapshot;
    const inv: Record<string, number | null> = {};
    for (const reading of state.readings) {
      if (!this.pvSources.includes(reading.connectorId)) continue;
      const w = bilanzwertW(reading.solarProductionW);
      inv[reading.connectorId] = w !== null && w >= 0 ? w : null;
    }

    const speicher: Record<string, { laden: number; entladen: number } | null> = {};
    const socJe: Record<string, number | null> = {};
    let alleLeistungen = true;
    for (const b of snap.batteries) {
      this.batteryNames[b.deviceId] = b.displayName;
      this.batteryCaps[b.deviceId] = b.usableCapacityWh;
      const aktuell = istAktuell(b.provenance);
      const laden = aktuell && Number.isFinite(b.chargeW) ? b.chargeW : null;
      const entladen = aktuell && Number.isFinite(b.dischargeW) ? b.dischargeW : null;
      if (!aktuell || (laden === null && entladen === null)) {
        speicher[b.deviceId] = null;
        alleLeistungen = false;
      } else {
        speicher[b.deviceId] = { laden: Math.max(0, laden ?? 0), entladen: Math.max(0, entladen ?? 0) };
      }
      socJe[b.deviceId] = aktuell ? b.socPercent : null;
    }
    const fehlend = state.resolution.unavailable.filter((u) => u.startsWith('battery:')).length;
    const gesamt = speicherGesamt(
      snap.batteries.map((b) => ({
        usableCapacityWh: b.usableCapacityWh,
        socPercent: b.socPercent,
        erreichbar: istAktuell(b.provenance),
      })),
      snap.batteries.length + fehlend,
    );

    const evRoh = evLeistungW === undefined ? (snap.evCharger?.chargePowerW ?? null) : evLeistungW;
    const ev = evRoh !== null && Number.isFinite(evRoh) && evRoh >= 0 ? evRoh : null;

    return {
      tMs: state.polledAt.getTime(),
      pv: nichtnegativOderNull(bilanzwertW(snap.solarProductionW)),
      haus: nichtnegativOderNull(bilanzwertW(snap.houseConsumptionW)),
      bezug: nichtnegativOderNull(bilanzwertW(snap.gridImportW)),
      einspeisung: nichtnegativOderNull(bilanzwertW(snap.gridExportW)),
      inv,
      speicher,
      speicherVollstaendig: fehlend === 0 && alleLeistungen,
      socAgg: gesamt.socPercent,
      socJe,
      ev,
    };
  }

  /** Ein gültiges Intervall mit dem gehaltenen Wert `p` verbuchen. */
  private integriere(p: Stichprobe, startMs: number, sekunden: number): void {
    if (sekunden <= 0) return;
    const h = sekunden / 3600;
    const t = this.today;
    if (t.erfasstAbMs === null) t.erfasstAbMs = startMs;

    // Jede Grundgrösse zählt für sich, samt eigener Messdauer.
    if (p.pv !== null) { t.productionWh += p.pv * h; t.abdeckungJeGroesseS.pv += sekunden; }
    if (p.haus !== null) { t.houseConsumptionWh += p.haus * h; t.abdeckungJeGroesseS.haus += sekunden; }
    if (p.bezug !== null) { t.gridImportWh += p.bezug * h; t.abdeckungJeGroesseS.bezug += sekunden; }
    if (p.einspeisung !== null) {
      t.gridExportWh += p.einspeisung * h;
      t.abdeckungJeGroesseS.einspeisung += sekunden;
    }
    const vollstaendig = p.pv !== null && p.haus !== null && p.bezug !== null && p.einspeisung !== null;
    if (vollstaendig) t.coveredSeconds += sekunden;

    for (const [id, w] of Object.entries(p.inv)) {
      if (w !== null) t.perInverterWh[id] = (t.perInverterWh[id] ?? 0) + w * h;
    }
    let ladenW = 0;
    let entladenW = 0;
    for (const [id, s] of Object.entries(p.speicher)) {
      if (s === null) continue;
      if (s.laden > 0) t.batteryChargeWh[id] = (t.batteryChargeWh[id] ?? 0) + s.laden * h;
      if (s.entladen > 0) t.batteryDischargeWh[id] = (t.batteryDischargeWh[id] ?? 0) + s.entladen * h;
      ladenW += s.laden;
      entladenW += s.entladen;
    }

    // Die Wallbox: dieselbe Schwelle wie im Ladeprotokoll. Eine unbekannte
    // Leistung wird nicht als 0 W verbucht, sondern gar nicht.
    if (p.ev !== null && p.ev > LADEN_AB_W) t.evChargeWh += p.ev * h;

    // Herkunftsmodell nur, wenn wirklich alle Flüsse gemessen sind.
    if (vollstaendig && p.speicherVollstaendig) {
      t.zuordnung = addiereZuordnung(
        t.zuordnung,
        zuordneIntervall({
          pv: (p.pv ?? 0) * h,
          haus: (p.haus ?? 0) * h,
          bezug: (p.bezug ?? 0) * h,
          einspeisung: (p.einspeisung ?? 0) * h,
          laden: ladenW * h,
          entladen: entladenW * h,
        }),
      );
    }
  }

  private maybeAppendSeries(p: Stichprobe): void {
    if (p.tMs - this.lastSeriesAt < SERIES_INTERVAL_MS) return;
    const letzter = this.series[this.series.length - 1];
    // Lag seit dem letzten Punkt mehr als ein doppelter Abstand, war dazwischen
    // keine Aufzeichnung. Ein leerer Punkt trennt die Linie — sonst zöge die
    // Kurve eine Gerade durch eine Stunde, in der niemand gemessen hat.
    if (letzter !== undefined && p.tMs - letzter.t > 2 * SERIES_INTERVAL_MS) {
      this.series.push(leererPunkt(letzter.t + SERIES_INTERVAL_MS));
    }
    this.lastSeriesAt = p.tMs;

    const bat: Record<string, { p: number | null; soc: number | null }> = {};
    for (const [id, s] of Object.entries(p.speicher)) {
      bat[id] = { p: s === null ? null : s.laden - s.entladen, soc: p.socJe[id] ?? null };
    }
    this.series.push({
      t: p.tMs,
      pv: p.pv,
      house: p.haus,
      gridImport: p.bezug,
      gridExport: p.einspeisung,
      inv: { ...p.inv },
      bat,
      socAgg: p.socAgg,
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
        version: 2,
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

    const grenzen = tagesgrenzen(date);
    if (totals === null) {
      return {
        date, isToday, hasData: false, hasSeries: false,
        tagBeginnMs: grenzen.beginnMs, tagEndeMs: grenzen.endeMs,
        zeitzone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    }

    const bisMs = isToday ? Math.min(this.jetzt(), grenzen.endeMs) : grenzen.endeMs;
    const abdeckung = coverage(totals, (bisMs - grenzen.beginnMs) / 1000);
    const prev = this.aggregateFor(shiftDate(date, -1));
    return {
      date,
      isToday,
      hasData: true,
      hasSeries: series.length > 1,
      quality,
      // Tagesgrenzen der Anlage. Der Browser rechnet sie nicht selbst — in einer
      // anderen Zeitzone ergäbe das einen anderen Tag.
      tagBeginnMs: grenzen.beginnMs,
      tagEndeMs: grenzen.endeMs,
      zeitzone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      coverage: abdeckung,
      letzteErfassung: isToday && this.letzteErfassungMs !== null
        ? new Date(this.letzteErfassungMs).toISOString()
        : null,
      totals,
      derived: this.derive(totals, date, abdeckung.bekannt && (abdeckung.percent ?? 0) >= 99),
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
      comparison: prev
        ? { previous: this.derive(prev, shiftDate(date, -1), false), previousTotals: prev }
        : null,
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
    const grenzen = tagesgrenzen(this.currentDate);
    const bisMs = Math.min(this.jetzt(), grenzen.endeMs);
    return {
      running: true,
      startedAt: this.startedAt.toISOString(),
      lastMeasurementAt: this.letzteErfassungMs ? new Date(this.letzteErfassungMs).toISOString() : null,
      currentDate: this.currentDate,
      coverageToday: coverage(toReadonly(this.today), (bisMs - grenzen.beginnMs) / 1000),
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
        if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) set.add(f.slice(0, -5));
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

  /**
   * Kennzahlen eines Tages, mit dem Tarif dieses Tages.
   *
   * @param vollstaendig Ob der Tag lückenlos gemessen wurde. Sonst tragen die
   *   Kosten den Vermerk "unvollständig" — sie sind dann eine Untergrenze.
   */
  private derive(totals: EnergyTotals, date: string, vollstaendig: boolean): unknown {
    const q = quoten(totals);
    const tarif = this.tarife.fuerTag(date);
    return {
      autarkyPercent: q.autarkie.percent,
      autarkyStatus: q.autarkie.status,
      selfConsumptionPercent: q.eigenverbrauch.percent,
      selfConsumptionStatus: q.eigenverbrauch.status,
      consumptionSources: consumptionSources(totals),
      productionSinks: productionSinks(totals),
      batteryChargeWh: totalBatteryChargeWh(totals),
      batteryDischargeWh: totalBatteryDischargeWh(totals),
      costs: {
        ...computeCosts(totals, tarif.tarif),
        vollstaendig: vollstaendig && q.autarkie.status === 'vergleichbar',
        tarif: {
          importPricePerKWh: tarif.tarif.importPricePerKWh,
          exportPricePerKWh: tarif.tarif.exportPricePerKWh,
          gueltigAb: tarif.gueltigAb,
          grundlage: tarif.grundlage,
        },
      },
    };
  }

  private recordFor(date: string): DailyRecord | null {
    return this.history.find((r) => r.date === date) ?? null;
  }

  // ── Persistenz ────────────────────────────────────────────────────
  private historyPath(): string {
    return resolve(this.dataDir, 'history.json');
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const path = resolve(this.daysDir, `${date}.json`);
    if (!existsSync(path)) return null;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      // Ein beschädigtes Tagesarchiv bleibt liegen: Der Tag ist damit zwar
      // nicht abrufbar, aber auch nicht verloren.
      bewahreBeschaedigt(path);
      return null;
    }
    const totals = pruefeTotals(parsed?.['totals']);
    if (totals === null || parsed['date'] !== date) {
      console.warn(`${path}: Inhalt ungültig, Tag wird nicht angezeigt.`);
      return null;
    }
    return {
      totals,
      series: pruefeSerie(parsed['series']),
      ...(isStringRecord(parsed['batteryNames']) ? { batteryNames: parsed['batteryNames'] } : {}),
      ...(isCapRecord(parsed['batteryCaps']) ? { batteryCaps: parsed['batteryCaps'] } : {}),
      ...(typeof parsed['quality'] === 'string' ? { quality: parsed['quality'] } : {}),
    };
  }

  /**
   * Jede Datei für sich.
   *
   * Eine beschädigte history.json darf den heutigen Zwischenstand nicht
   * mitreissen. Und gültiges JSON ist noch kein gültiger Inhalt: Jede Summe
   * wird mit `pruefeTotals` geprüft, bevor ihr geglaubt wird.
   */
  private load(): void {
    this.leseDatei(this.historyPath(), (parsed) => {
      const days = (parsed as { days?: unknown } | null)?.days;
      if (!Array.isArray(days)) throw new Error('days fehlt');
      let verworfen = 0;
      for (const d of days) {
        const rec = d as { date?: unknown; totals?: unknown };
        const totals = pruefeTotals(rec?.totals);
        if (typeof rec?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rec.date) || totals === null) {
          console.warn(`history.json: ungültiger Tag übersprungen (${String(rec?.date)}).`);
          verworfen += 1;
          continue;
        }
        this.history.push({ date: rec.date, totals });
      }
      // Ein einzelner kaputter Tag darf nicht mit dem nächsten Speichern
      // verschwinden: Die ganze Datei wird beiseitegelegt, die gültigen Tage
      // werden neu geschrieben.
      if (verworfen > 0) bewahreBeschaedigt(this.historyPath());
    });
    this.leseDatei(this.todayPath(), (parsed) => this.uebernehmeHeute(parsed));
  }

  /** Liest eine JSON-Datei; bei Beschädigung bleibt sie erhalten. */
  private leseDatei(pfad: string, uebernehmen: (parsed: unknown) => void): void {
    if (!existsSync(pfad)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(pfad, 'utf8'));
    } catch {
      bewahreBeschaedigt(pfad);
      return;
    }
    try {
      uebernehmen(parsed);
    } catch (error) {
      console.warn(`${pfad} hat einen unerwarteten Inhalt:`, error instanceof Error ? error.message : error);
      // Lesbar, aber fachlich falsch: ebenso aufbewahren statt überschreiben.
      bewahreBeschaedigt(pfad);
    }
  }

  private uebernehmeHeute(roh: unknown): void {
    const parsed = roh as Record<string, unknown> | null;
    const totals = pruefeTotals(parsed?.['totals']);
    const date = parsed?.['date'];
    if (totals === null || typeof date !== 'string') throw new Error('Summen oder Datum ungültig');
    if (typeof parsed?.['letzteErfassungMs'] === 'number') {
      this.letzteErfassungMs = parsed['letzteErfassungMs'];
    }
    const series = pruefeSerie(parsed?.['series']);
    if (isStringRecord(parsed?.['batteryNames'])) this.batteryNames = parsed['batteryNames'];
    if (isCapRecord(parsed?.['batteryCaps'])) this.batteryCaps = parsed['batteryCaps'];

    if (date === this.currentDate) {
      this.today = toMutable(totals);
      this.series = series;
      // Ohne diese Zeile stand lastSeriesAt nach einem Neustart auf 0: Der
      // erste Messzyklus setzte sofort einen weiteren Punkt, wenige Sekunden
      // nach dem zuletzt gespeicherten.
      const last = this.series[this.series.length - 1];
      if (last && Number.isFinite(last.t)) this.lastSeriesAt = last.t;
    } else {
      // today.json stammt von einem früheren Tag (Server war über Mitternacht
      // aus): diesen Tag noch archivieren, damit seine Kurve nicht verloren geht.
      if (!existsSync(resolve(this.daysDir, `${date}.json`))) this.archiveDay(date, totals, series);
      this.history = this.history.filter((r) => r.date !== date);
      this.history.push({ date, totals });
      this.history.sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  persist(): void {
    try {
      writeJsonAtomic(this.historyPath(), { version: 2, days: this.history }, 2);
      writeJsonAtomic(this.todayPath(), {
        version: 2,
        date: this.currentDate,
        totals: toReadonly(this.today),
        series: this.series,
        batteryNames: this.batteryNames,
        batteryCaps: this.batteryCaps,
        // Damit nach einem Neustart klar ist, seit wann nicht erfasst wurde.
        letzteErfassungMs: this.letzteErfassungMs,
      });
      this.dirty = false;
    } catch (error) {
      console.warn('Historie konnte nicht gespeichert werden:', error instanceof Error ? error.message : error);
    }
  }

  private persistIfDirty(): void {
    if (this.dirty) this.persist();
  }
}

// ── Hilfen ────────────────────────────────────────────────────────────

function nichtnegativOderNull(w: number | null): number | null {
  return w !== null && w >= 0 ? w : null;
}

function leererPunkt(t: number): SeriesPoint {
  return { t, pv: null, house: null, gridImport: null, gridExport: null, inv: {}, bat: {}, socAgg: null };
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && Object.values(v).every((x) => typeof x === 'string');
}

function isCapRecord(v: unknown): v is Record<string, number | null> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && Object.values(v).every((x) => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0));
}

const zahlOderNull = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? x : null;

/** Kurvenpunkte prüfen; unbrauchbare Punkte fallen weg, statt Nonsens zu zeichnen. */
function pruefeSerie(roh: unknown): SeriesPoint[] {
  if (!Array.isArray(roh)) return [];
  const aus: SeriesPoint[] = [];
  for (const p of roh as Record<string, unknown>[]) {
    if (typeof p !== 'object' || p === null) continue;
    const t = zahlOderNull(p['t']);
    if (t === null) continue;
    const inv: Record<string, number | null> = {};
    if (typeof p['inv'] === 'object' && p['inv'] !== null) {
      for (const [k, v] of Object.entries(p['inv'] as Record<string, unknown>)) inv[k] = zahlOderNull(v);
    }
    const bat: Record<string, { p: number | null; soc: number | null }> = {};
    if (typeof p['bat'] === 'object' && p['bat'] !== null) {
      for (const [k, v] of Object.entries(p['bat'] as Record<string, unknown>)) {
        const b = (v ?? {}) as Record<string, unknown>;
        bat[k] = { p: zahlOderNull(b['p']), soc: zahlOderNull(b['soc']) };
      }
    }
    aus.push({
      t,
      pv: zahlOderNull(p['pv']),
      house: zahlOderNull(p['house']),
      gridImport: zahlOderNull(p['gridImport']),
      gridExport: zahlOderNull(p['gridExport']),
      inv,
      bat,
      socAgg: zahlOderNull(p['socAgg']),
    });
  }
  return aus;
}

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
  return toMutable(emptyTotals());
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
    coveredSeconds: t.coveredSeconds,
    abdeckungJeGroesseS: { ...t.abdeckungJeGroesseS },
    erfasstAbMs: t.erfasstAbMs,
    zuordnung: { ...t.zuordnung },
  };
}

/**
 * Für den heutigen Zwischenstand aus today.json.
 *
 * Ein Stand aus der Zeit vor der Abdeckungsrechnung hat keine Abdeckung und
 * keine Zuordnung. Ab jetzt wird beides gezählt — aber nur ab jetzt: Die
 * Abdeckung beginnt bei 0, und die Zuordnung deckt nur den Rest des Tages ab.
 */
function toMutable(t: EnergyTotals): MutableTotals {
  const je: AbdeckungJeGroesse = t.abdeckungJeGroesseS ?? { pv: 0, haus: 0, bezug: 0, einspeisung: 0 };
  return {
    productionWh: t.productionWh,
    perInverterWh: { ...t.perInverterWh },
    houseConsumptionWh: t.houseConsumptionWh,
    gridImportWh: t.gridImportWh,
    gridExportWh: t.gridExportWh,
    batteryChargeWh: { ...t.batteryChargeWh },
    batteryDischargeWh: { ...t.batteryDischargeWh },
    evChargeWh: t.evChargeWh,
    coveredSeconds: t.coveredSeconds ?? 0,
    abdeckungJeGroesseS: { ...je },
    erfasstAbMs: t.erfasstAbMs ?? null,
    zuordnung: { ...(t.zuordnung ?? leereZuordnung()) },
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

/**
 * Summen zusammenzählen.
 *
 * Abdeckung und Zuordnung werden nur zusammengezählt, wenn BEIDE Seiten sie
 * haben. Ein Monat aus alten und neuen Tagen hätte sonst eine Abdeckung, die
 * nur einen Teil seiner Tage beschreibt — und sähe trotzdem vollständig aus.
 */
function addTotals(a: EnergyTotals, b: EnergyTotals): EnergyTotals {
  const mergeRecord = (
    x: Readonly<Record<string, number>>,
    y: Readonly<Record<string, number>>,
  ): Record<string, number> => {
    const out: Record<string, number> = { ...x };
    for (const [k, v] of Object.entries(y)) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const beide = <T>(x: T | undefined, y: T | undefined, f: (x: T, y: T) => T): T | undefined =>
    x === undefined || y === undefined ? undefined : f(x, y);
  const covered = beide(a.coveredSeconds, b.coveredSeconds, (x, y) => x + y);
  const je = beide(a.abdeckungJeGroesseS, b.abdeckungJeGroesseS, (x, y) => ({
    pv: x.pv + y.pv, haus: x.haus + y.haus, bezug: x.bezug + y.bezug, einspeisung: x.einspeisung + y.einspeisung,
  }));
  const zuordnung = beide(a.zuordnung, b.zuordnung, addiereZuordnung);
  return {
    productionWh: a.productionWh + b.productionWh,
    perInverterWh: mergeRecord(a.perInverterWh, b.perInverterWh),
    houseConsumptionWh: a.houseConsumptionWh + b.houseConsumptionWh,
    gridImportWh: a.gridImportWh + b.gridImportWh,
    gridExportWh: a.gridExportWh + b.gridExportWh,
    batteryChargeWh: mergeRecord(a.batteryChargeWh, b.batteryChargeWh),
    batteryDischargeWh: mergeRecord(a.batteryDischargeWh, b.batteryDischargeWh),
    evChargeWh: a.evChargeWh + b.evChargeWh,
    ...(covered !== undefined ? { coveredSeconds: covered } : {}),
    ...(je !== undefined ? { abdeckungJeGroesseS: je } : {}),
    ...(zuordnung !== undefined ? { zuordnung } : {}),
  };
}
