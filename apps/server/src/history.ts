/**
 * Energie-Akkumulation und Historie (permanentes Energiegedächtnis).
 *
 * Läuft serverseitig, unabhängig vom Browser (Engine ruft integrate() auf).
 * - Integriert Live-Leistungen (W) zu Energiemengen (Wh), je Wechselrichter/Speicher.
 * - Führt die Tageskurve: je Minute der MITTELWERT über alle Messungen der
 *   Minute (nicht eine Momentaufnahme), damit Kurve und Tagessumme dieselbe
 *   Energie beschreiben und eine kurze Wolke anteilig sichtbar wird.
 * - Führt Zählerstände der Geräte mit und bildet daraus Tagesdifferenzen, die
 *   Ausfälle des Servers überstehen.
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
  addiereZaehlersummen,
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
  type Zaehlersummen,
  type Zuordnung,
} from '@energy/core';

import type { EngineState } from './engine.ts';
import { bewahreBeschaedigt, writeJsonAtomic } from './persist.ts';
import { Tarifverlauf } from './tarife.ts';
import { localDate, naechsterTagesbeginn, shiftDate, tagesgrenzen } from './tageszeit.ts';

// Weiterhin von hier beziehbar — die Tagesrechnung wohnt jetzt in tageszeit.ts.
export { localDate, shiftDate, tagesgrenzen } from './tageszeit.ts';

export interface DailyRecord {
  readonly date: string; // YYYY-MM-DD (lokale Zeit)
  readonly totals: EnergyTotals;
}

/**
 * Ein Punkt der Tageskurve: Mittelwerte der Minute ab `t`. Leistungen in W
 * (ganzzahlig), SOC in % (letzter Wert der Minute).
 *
 * `null` heisst: in dieser Minute gab es keine verwertbare Messung. Die Kurve
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
  /** Zählerstände je Schlüssel (pv, pv:<id>, bezug, einspeisung, auto). */
  zaehlerstaende: Record<string, Zaehlerstand>;
}

/**
 * Ein Zähler über den Tag: Startwert, letzter Wert, und was vor einem
 * Zählerrücksprung bereits aufgelaufen war.
 */
interface Zaehlerstand {
  start: number;
  letzter: number;
  summe: number;
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
  /** Aktuelle Zählerstände der Geräte (nur live), Schlüssel wie in `zaehlerstaende`. */
  readonly zaehler: Readonly<Record<string, number>>;
}

const SERIES_INTERVAL_MS = 60_000;

/** Ab diesem Alter werden Tagesarchive auf 15-Minuten-Mittel verdichtet. */
const VERDICHTEN_AB_TAGEN = 90;
const VERDICHTET_INTERVALL_MS = 15 * 60_000;

/** Eine Minute im Aufbau: Energie und Messdauer je Grösse. */
interface Minutenfenster {
  beginnMs: number;
  endeMs: number;
  wh: { pv: number; haus: number; bezug: number; einspeisung: number };
  s: { pv: number; haus: number; bezug: number; einspeisung: number };
  inv: Record<string, { wh: number; s: number }>;
  bat: Record<string, { wh: number; s: number; soc: number | null }>;
  socAgg: number | null;
}

export interface AccumulatorOptions {
  readonly dataDir: string;
  readonly pvSources: readonly string[];
  readonly names: Readonly<Record<string, string>>;
  /** Vorgabetarif aus config.json, solange kein gespeicherter bekannt ist. */
  readonly tariff: Tariff;
  /** Uhr — für Tests. */
  readonly jetzt?: () => number;
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
  /** Die Minute, die gerade gesammelt wird. */
  private fenster: Minutenfenster | null = null;
  /** Geparste Tagesarchive, damit die Tagesansicht nicht bei jedem Aufruf liest. */
  private readonly archivCache = new Map<string, GeladenerTag | null>();
  private letzteProbe: Stichprobe | null = null;
  /** Letzte Erfassung, auch über einen Neustart hinweg. */
  private letzteErfassungMs: number | null = null;
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
    this.verdichteAlteTage();

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

    // Ohne gültiges Intervall davor (Start, Neustart, zu langer Abstand) war
    // dazwischen keine Messung — die Kurve bekommt eine sichtbare Lücke.
    const gueltig = vorher !== null && probe.tMs > vorher.tMs
      && (probe.tMs - vorher.tMs) / 1000 <= MAX_INTEGRATIONSSCHRITT_S;
    if (!gueltig) this.markiereLuecke(probe.tMs);

    if (vorher !== null && probe.tMs > vorher.tMs) {
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
    this.merkeZaehler(probe);
  }

  /**
   * Zählerstände fortschreiben.
   *
   * Springt ein Zähler zurück (Gerätetausch, Rücksetzung), wird das bis dahin
   * Aufgelaufene gesichert und neu begonnen — die Tagessumme bleibt stetig.
   */
  private merkeZaehler(p: Stichprobe): void {
    for (const [key, wert] of Object.entries(p.zaehler)) {
      const z = this.today.zaehlerstaende[key];
      if (z === undefined) {
        this.today.zaehlerstaende[key] = { start: wert, letzter: wert, summe: 0 };
      } else if (wert < z.letzter - 1) {
        z.summe += z.letzter - z.start;
        z.start = wert;
        z.letzter = wert;
      } else {
        z.letzter = wert;
      }
    }
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

    // Zählerstände: nur frische, endliche, nicht-negative Werte.
    const zaehler: Record<string, number> = {};
    const z = snap.counters;
    const nimm = (key: string, m: { valueWh: number | null; provenance: { quality: string } } | null | undefined): void => {
      if (m && m.provenance.quality === 'live' && m.valueWh !== null && Number.isFinite(m.valueWh) && m.valueWh >= 0) {
        zaehler[key] = m.valueWh;
      }
    };
    if (z !== undefined) {
      nimm('pv', z.solarWh);
      nimm('bezug', z.gridImportWh);
      nimm('einspeisung', z.gridExportWh);
      for (const [id, wh] of Object.entries(z.solarByConnectorWh)) {
        if (wh !== null && Number.isFinite(wh) && wh >= 0) zaehler[`pv:${id}`] = wh;
      }
    }
    const evz = snap.evCharger;
    if (evz && evz.state !== 'offline' && istAktuell(evz.provenance) && evz.totalEnergyWh !== null && evz.totalEnergyWh >= 0) {
      zaehler['auto'] = evz.totalEnergyWh;
    }

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
      zaehler,
    };
  }

  /**
   * Ein gültiges Intervall mit dem gehaltenen Wert `p` verbuchen — in die
   * Tagessummen und, minutenweise geteilt, in die Kurve.
   */
  private integriere(p: Stichprobe, startMs: number, sekunden: number): void {
    if (sekunden <= 0) return;
    this.summiere(p, startMs, sekunden);
    // Dieselbe Energie in Minutenfenster — die Kurve zeigt dann Mittelwerte,
    // deren Summe die Tagessumme ist, statt zufälliger Momentaufnahmen.
    let start = startMs;
    const ende = startMs + sekunden * 1000;
    while (start < ende) {
      const fensterEnde = Math.floor(start / SERIES_INTERVAL_MS) * SERIES_INTERVAL_MS + SERIES_INTERVAL_MS;
      const bis = Math.min(ende, fensterEnde);
      this.sammle(p, start, (bis - start) / 1000);
      if (bis === fensterEnde) this.schliesseFenster();
      start = bis;
    }
  }

  /** Energie der Stichprobe in das laufende Minutenfenster legen. */
  private sammle(p: Stichprobe, startMs: number, sekunden: number): void {
    if (sekunden <= 0) return;
    const beginn = Math.floor(startMs / SERIES_INTERVAL_MS) * SERIES_INTERVAL_MS;
    if (this.fenster !== null && this.fenster.beginnMs !== beginn) this.schliesseFenster();
    if (this.fenster === null) {
      this.fenster = {
        beginnMs: beginn, endeMs: beginn + SERIES_INTERVAL_MS,
        wh: { pv: 0, haus: 0, bezug: 0, einspeisung: 0 },
        s: { pv: 0, haus: 0, bezug: 0, einspeisung: 0 },
        inv: {}, bat: {}, socAgg: null,
      };
    }
    const f = this.fenster;
    const h = sekunden / 3600;
    if (p.pv !== null) { f.wh.pv += p.pv * h; f.s.pv += sekunden; }
    if (p.haus !== null) { f.wh.haus += p.haus * h; f.s.haus += sekunden; }
    if (p.bezug !== null) { f.wh.bezug += p.bezug * h; f.s.bezug += sekunden; }
    if (p.einspeisung !== null) { f.wh.einspeisung += p.einspeisung * h; f.s.einspeisung += sekunden; }
    for (const [id, w] of Object.entries(p.inv)) {
      const e = (f.inv[id] ??= { wh: 0, s: 0 });
      if (w !== null) { e.wh += w * h; e.s += sekunden; }
    }
    for (const [id, s] of Object.entries(p.speicher)) {
      const e = (f.bat[id] ??= { wh: 0, s: 0, soc: null });
      if (s !== null) { e.wh += (s.laden - s.entladen) * h; e.s += sekunden; }
      const soc = p.socJe[id];
      if (soc !== null && soc !== undefined) e.soc = soc;
    }
    if (p.socAgg !== null) f.socAgg = p.socAgg;
  }

  /** Das laufende Fenster als Kurvenpunkt ablegen. */
  private schliesseFenster(): void {
    const f = this.fenster;
    this.fenster = null;
    if (f === null) return;
    const letzter = this.series[this.series.length - 1];
    if (letzter !== undefined && f.beginnMs <= letzter.t) return; // schon da (Neustart)
    // Lag seit dem letzten Punkt mehr als eine Minute, war dazwischen keine
    // Aufzeichnung. Ein leerer Punkt trennt die Linie — sonst zöge die Kurve
    // eine Gerade durch eine Stunde, in der niemand gemessen hat.
    if (letzter !== undefined && f.beginnMs - letzter.t > SERIES_INTERVAL_MS && !istLeer(letzter)) {
      this.series.push(leererPunkt(letzter.t + SERIES_INTERVAL_MS));
    }
    this.series.push(punktAus(f));
  }

  /**
   * Eine Lücke in der Aufzeichnung festhalten: das angefangene Fenster
   * abschliessen und, wenn seit dem letzten Punkt mehr als zwei Minuten
   * vergangen sind, einen leeren Punkt setzen, der die Linie trennt.
   */
  private markiereLuecke(jetztMs: number): void {
    this.schliesseFenster();
    const letzter = this.series[this.series.length - 1];
    if (letzter !== undefined && jetztMs - letzter.t > 2 * SERIES_INTERVAL_MS && !istLeer(letzter)) {
      this.series.push(leererPunkt(letzter.t + SERIES_INTERVAL_MS));
    }
  }

  /**
   * Die Kurve samt der angefangenen Minute. Für die Live-Ansicht: Wer um
   * 12:00:40 schaut, soll die Minute 12:00 schon sehen — als Mittel über die
   * bisherigen 40 Sekunden, nicht erst um 12:01.
   */
  private serieMitOffenemFenster(): readonly SeriesPoint[] {
    const f = this.fenster;
    if (f === null) return this.series;
    const letzter = this.series[this.series.length - 1];
    if (letzter !== undefined && f.beginnMs <= letzter.t) return this.series;
    return [...this.series, punktAus(f)];
  }

  /** Ein gültiges Intervall in die Tagessummen verbuchen. */
  private summiere(p: Stichprobe, startMs: number, sekunden: number): void {
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

  private rollover(newDate: string): void {
    // Die angefangene Minute gehört noch zum alten Tag.
    this.schliesseFenster();
    // Vollständige Tageskurve + Aggregat des abgeschlossenen Tages archivieren.
    this.archiveDay(this.currentDate, toReadonly(this.today), this.series);

    this.history = this.history.filter((r) => r.date !== this.currentDate);
    this.history.push({ date: this.currentDate, totals: toReadonly(this.today) });
    this.history.sort((a, b) => a.date.localeCompare(b.date));

    // Zähler laufen weiter: Der letzte Stand des alten Tages ist der Anfang des
    // neuen. Was während eines Ausfalls über Mitternacht zählt, landet im neuen Tag.
    const uebertrag: Record<string, Zaehlerstand> = {};
    for (const [k, z] of Object.entries(this.today.zaehlerstaende)) {
      uebertrag[k] = { start: z.letzter, letzter: z.letzter, summe: 0 };
    }
    this.today = freshTotals();
    this.today.zaehlerstaende = uebertrag;
    this.series = [];
    this.currentDate = newDate;
    this.persist();
  }

  private archiveDay(
    date: string,
    totals: EnergyTotals,
    series: readonly SeriesPoint[],
    intervallMs = SERIES_INTERVAL_MS,
  ): void {
    try {
      writeJsonAtomic(resolve(this.daysDir, `${date}.json`), {
        version: 3,
        date,
        totals,
        series,
        seriesIntervalSeconds: intervallMs / 1000,
        batteryNames: this.batteryNames,
        batteryCaps: this.batteryCaps,
        quality: 'local_live',
      });
      this.archivCache.delete(date);
    } catch (error) {
      console.warn(`Tag ${date} konnte nicht archiviert werden:`, error);
    }
  }

  /**
   * Alte Tagesarchive auf 15-Minuten-Mittel verdichten.
   *
   * Nach drei Monaten braucht niemand mehr die Minute; ein Tag schrumpft so von
   * ~150 KB auf ~10 KB, und das Verzeichnis wächst nicht mehr unbegrenzt. Die
   * Mittelwerte entstehen aus den Minutenmitteln — die Energie bleibt gleich.
   * Läuft einmal beim Start; ein einzelner unlesbarer Tag bricht nichts ab.
   */
  private verdichteAlteTage(): void {
    const grenze = shiftDate(this.currentDate, -VERDICHTEN_AB_TAGEN);
    let verdichtet = 0;
    for (const date of this.availableDates()) {
      if (date >= grenze || date === this.currentDate) continue;
      const geladen = this.loadDay(date);
      if (geladen === null || geladen.intervallMs >= VERDICHTET_INTERVALL_MS || geladen.series.length === 0) continue;
      const serie = verdichteSerie(geladen.series, VERDICHTET_INTERVALL_MS);
      this.archiveDay(date, geladen.totals, serie, VERDICHTET_INTERVALL_MS);
      verdichtet += 1;
    }
    if (verdichtet > 0) console.log(`[Historie] ${verdichtet} Tagesarchiv(e) älter als ${VERDICHTEN_AB_TAGEN} Tage auf 15-Minuten-Mittel verdichtet.`);
  }

  todayView(): unknown {
    return this.dayView(this.currentDate);
  }
  todaySeries(): readonly SeriesPoint[] {
    return this.serieMitOffenemFenster();
  }

  /** Vollständige Tagesansicht für ein beliebiges Datum (heute = live). */
  dayView(date: string): unknown {
    const isToday = date === this.currentDate;
    let totals: EnergyTotals | null = null;
    let series: readonly SeriesPoint[] = [];
    let names = this.batteryNames;
    let caps = this.batteryCaps;
    let quality = 'local_live';
    let intervallMs = SERIES_INTERVAL_MS;

    if (isToday) {
      totals = toReadonly(this.today);
      series = this.serieMitOffenemFenster();
    } else {
      const archived = this.loadDay(date);
      if (archived) {
        totals = archived.totals;
        series = archived.series;
        names = archived.batteryNames ?? this.batteryNames;
        caps = archived.batteryCaps ?? this.batteryCaps;
        quality = archived.quality ?? 'local_live';
        intervallMs = archived.intervallMs;
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
      seriesIntervalSeconds: intervallMs / 1000,
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

  private loadDay(date: string): GeladenerTag | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const imCache = this.archivCache.get(date);
    if (imCache !== undefined) return imCache;
    const geladen = this.leseTag(date);
    // Kleiner Cache: Wer durch die Tage blättert, trifft dieselben wieder.
    if (this.archivCache.size >= 16) {
      const aeltester = this.archivCache.keys().next().value;
      if (aeltester !== undefined) this.archivCache.delete(aeltester);
    }
    this.archivCache.set(date, geladen);
    return geladen;
  }

  private leseTag(date: string): GeladenerTag | null {
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
    const intervallS = zahlOderNull(parsed['seriesIntervalSeconds']);
    return {
      totals,
      series: pruefeSerie(parsed['series']),
      intervallMs: intervallS !== null && intervallS > 0 ? intervallS * 1000 : SERIES_INTERVAL_MS,
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
      this.today.zaehlerstaende = pruefeZaehlerstaende(parsed?.['zaehlerstaende']);
      this.series = series;
      this.fenster = pruefeFenster(parsed?.['fenster']);
    } else {
      // today.json stammt von einem früheren Tag (Server war über Mitternacht
      // aus): diesen Tag noch archivieren, damit seine Kurve nicht verloren geht.
      if (!existsSync(resolve(this.daysDir, `${date}.json`))) this.archiveDay(date, totals, series);
      this.history = this.history.filter((r) => r.date !== date);
      this.history.push({ date, totals });
      this.history.sort((a, b) => a.date.localeCompare(b.date));
      // Die Zähler laufen über den Neustart hinweg weiter — der letzte Stand
      // von damals ist der Anfang von heute.
      const alt = pruefeZaehlerstaende(parsed?.['zaehlerstaende']);
      for (const [k, z] of Object.entries(alt)) {
        this.today.zaehlerstaende[k] = { start: z.letzter, letzter: z.letzter, summe: 0 };
      }
    }
  }

  persist(): void {
    try {
      writeJsonAtomic(this.historyPath(), { version: 3, days: this.history }, 2);
      writeJsonAtomic(this.todayPath(), {
        version: 2,
        date: this.currentDate,
        totals: toReadonly(this.today),
        series: this.series,
        seriesIntervalSeconds: SERIES_INTERVAL_MS / 1000,
        batteryNames: this.batteryNames,
        batteryCaps: this.batteryCaps,
        // Damit nach einem Neustart klar ist, seit wann nicht erfasst wurde.
        letzteErfassungMs: this.letzteErfassungMs,
        zaehlerstaende: this.today.zaehlerstaende,
        // Die angefangene Minute, damit ein Neustart sie nicht verschluckt.
        fenster: this.fenster,
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

function istLeer(p: SeriesPoint): boolean {
  return p.pv === null && p.house === null && p.gridImport === null && p.gridExport === null
    && Object.keys(p.inv).length === 0 && Object.keys(p.bat).length === 0;
}

/** Mittelwerte eines Minutenfensters als Kurvenpunkt. */
function punktAus(f: Minutenfenster): SeriesPoint {
  const mittel = (wh: number, s: number): number | null => (s > 0 ? Math.round(wh / (s / 3600)) : null);
  const inv: Record<string, number | null> = {};
  for (const [id, e] of Object.entries(f.inv)) inv[id] = mittel(e.wh, e.s);
  const bat: Record<string, { p: number | null; soc: number | null }> = {};
  for (const [id, e] of Object.entries(f.bat)) {
    bat[id] = { p: mittel(e.wh, e.s), soc: e.soc === null ? null : Math.round(e.soc * 10) / 10 };
  }
  return {
    t: f.beginnMs,
    pv: mittel(f.wh.pv, f.s.pv),
    house: mittel(f.wh.haus, f.s.haus),
    gridImport: mittel(f.wh.bezug, f.s.bezug),
    gridExport: mittel(f.wh.einspeisung, f.s.einspeisung),
    inv,
    bat,
    socAgg: f.socAgg === null ? null : Math.round(f.socAgg * 10) / 10,
  };
}

/** Ein gespeichertes Minutenfenster zurücklesen; Unbrauchbares wird verworfen. */
function pruefeFenster(roh: unknown): Minutenfenster | null {
  if (typeof roh !== 'object' || roh === null) return null;
  const r = roh as Record<string, unknown>;
  const beginn = zahlOderNull(r['beginnMs']);
  const ende = zahlOderNull(r['endeMs']);
  const wh = r['wh'] as Record<string, unknown> | undefined;
  const s = r['s'] as Record<string, unknown> | undefined;
  if (beginn === null || ende === null || !wh || !s) return null;
  const vier = (o: Record<string, unknown>): { pv: number; haus: number; bezug: number; einspeisung: number } | null => {
    const pv = zahlOderNull(o['pv']); const haus = zahlOderNull(o['haus']);
    const bezug = zahlOderNull(o['bezug']); const einspeisung = zahlOderNull(o['einspeisung']);
    return pv === null || haus === null || bezug === null || einspeisung === null ? null : { pv, haus, bezug, einspeisung };
  };
  const whV = vier(wh); const sV = vier(s);
  if (whV === null || sV === null) return null;
  const inv: Record<string, { wh: number; s: number }> = {};
  for (const [k, v] of Object.entries((r['inv'] ?? {}) as Record<string, Record<string, unknown>>)) {
    const a = zahlOderNull(v?.['wh']); const b = zahlOderNull(v?.['s']);
    if (a !== null && b !== null) inv[k] = { wh: a, s: b };
  }
  const bat: Record<string, { wh: number; s: number; soc: number | null }> = {};
  for (const [k, v] of Object.entries((r['bat'] ?? {}) as Record<string, Record<string, unknown>>)) {
    const a = zahlOderNull(v?.['wh']); const b = zahlOderNull(v?.['s']);
    if (a !== null && b !== null) bat[k] = { wh: a, s: b, soc: zahlOderNull(v?.['soc']) };
  }
  return { beginnMs: beginn, endeMs: ende, wh: whV, s: sV, inv, bat, socAgg: zahlOderNull(r['socAgg']) };
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

/** Ein geladenes Tagesarchiv. */
interface GeladenerTag {
  totals: EnergyTotals;
  series: SeriesPoint[];
  intervallMs: number;
  batteryNames?: Record<string, string>;
  batteryCaps?: Record<string, number | null>;
  quality?: string;
}

function pruefeZaehlerstaende(roh: unknown): Record<string, Zaehlerstand> {
  const aus: Record<string, Zaehlerstand> = {};
  if (typeof roh !== 'object' || roh === null || Array.isArray(roh)) return aus;
  for (const [k, v] of Object.entries(roh as Record<string, unknown>)) {
    const z = v as Record<string, unknown> | null;
    const start = zahlOderNull(z?.['start']);
    const letzter = zahlOderNull(z?.['letzter']);
    const summe = zahlOderNull(z?.['summe']);
    if (start === null || letzter === null || summe === null || start < 0 || letzter < 0 || summe < 0) continue;
    aus[k] = { start, letzter, summe };
  }
  return aus;
}

/** Tagesdifferenzen aus den Zählerständen. */
function zaehlersummen(staende: Readonly<Record<string, Zaehlerstand>>): Zaehlersummen {
  const delta = (key: string): number | null => {
    const z = staende[key];
    return z === undefined ? null : Math.max(0, z.summe + (z.letzter - z.start));
  };
  const je: Record<string, number> = {};
  for (const key of Object.keys(staende)) {
    if (key.startsWith('pv:')) {
      const d = delta(key);
      if (d !== null) je[key.slice(3)] = d;
    }
  }
  return {
    pvWh: delta('pv'),
    pvJeWechselrichterWh: je,
    bezugWh: delta('bezug'),
    einspeisungWh: delta('einspeisung'),
    autoWh: delta('auto'),
  };
}

/**
 * Minutenpunkte zu gröberen Mitteln zusammenfassen. Ein Punkt je Fenster,
 * Mittel nur über vorhandene Werte; ein Fenster ohne einen einzigen Wert bleibt
 * eine Lücke (`null`) — Lücken werden nicht glattgezogen.
 */
export function verdichteSerie(serie: readonly SeriesPoint[], intervallMs: number): SeriesPoint[] {
  const fenster = new Map<number, SeriesPoint[]>();
  for (const p of serie) {
    const t = Math.floor(p.t / intervallMs) * intervallMs;
    const liste = fenster.get(t);
    if (liste) liste.push(p);
    else fenster.set(t, [p]);
  }
  const mittel = (werte: (number | null)[]): number | null => {
    const da = werte.filter((w): w is number => w !== null);
    return da.length === 0 ? null : Math.round(da.reduce((a, b) => a + b, 0) / da.length);
  };
  const letzterWert = (werte: (number | null)[]): number | null => {
    for (let i = werte.length - 1; i >= 0; i--) if (werte[i] !== null) return werte[i] as number;
    return null;
  };
  return [...fenster.entries()].sort((a, b) => a[0] - b[0]).map(([t, punkte]) => {
    const invIds = new Set(punkte.flatMap((p) => Object.keys(p.inv)));
    const batIds = new Set(punkte.flatMap((p) => Object.keys(p.bat)));
    const inv: Record<string, number | null> = {};
    for (const id of invIds) inv[id] = mittel(punkte.map((p) => p.inv[id] ?? null));
    const bat: Record<string, { p: number | null; soc: number | null }> = {};
    for (const id of batIds) {
      bat[id] = {
        p: mittel(punkte.map((p) => p.bat[id]?.p ?? null)),
        soc: letzterWert(punkte.map((p) => p.bat[id]?.soc ?? null)),
      };
    }
    return {
      t,
      pv: mittel(punkte.map((p) => p.pv)),
      house: mittel(punkte.map((p) => p.house)),
      gridImport: mittel(punkte.map((p) => p.gridImport)),
      gridExport: mittel(punkte.map((p) => p.gridExport)),
      inv,
      bat,
      socAgg: letzterWert(punkte.map((p) => p.socAgg)),
    };
  });
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
    zaehler: zaehlersummen(t.zaehlerstaende),
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
    zaehlerstaende: {},
  };
}



function aggregateByMonth(records: readonly DailyRecord[]): unknown[] {
  const byMonth = new Map<string, EnergyTotals>();
  for (const record of records) {
    const month = record.date.slice(0, 7);
    const bisher = byMonth.get(month);
    // Ohne Startwert: Ein leerer Startwert hätte keine Zähler, und "Zähler nur,
    // wenn alle Tage welche haben" ergäbe dann nie welche.
    byMonth.set(month, bisher === undefined ? record.totals : addTotals(bisher, record.totals));
  }
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, totals]) => ({ month, totals }));
}

function sumAll(records: readonly DailyRecord[]): EnergyTotals {
  const [erster, ...rest] = records;
  if (erster === undefined) return emptyTotals();
  let acc = erster.totals;
  for (const record of rest) acc = addTotals(acc, record.totals);
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
  const zaehler = beide(a.zaehler, b.zaehler, addiereZaehlersummen);
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
    ...(zaehler !== undefined ? { zaehler } : {}),
  };
}
