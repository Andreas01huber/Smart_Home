/**
 * Ladeprotokoll des E-Autos.
 *
 * Erkennt Ladevorgänge automatisch aus dem Live-Zustand des Ladegeräts und
 * schreibt sie dauerhaft weg. Nutzt dieselbe Ablage wie die übrige Historie
 * (Dateien unter `data/`) — es kommt bewusst keine zweite Datenbank dazu.
 *
 * ── Session-Erkennung ───────────────────────────────────────────────────────
 * Maßgeblich ist der Anschlusszustand (Control Pilot), nicht die Ladeleistung:
 * Der Wechsel „Fahrzeug angesteckt“ öffnet eine Session, „abgesteckt“ schliesst
 * sie. Das ist der zuverlässigste verfügbare Indikator und vermeidet, dass eine
 * Ladepause (Leistung kurz 0) fälschlich als zwei Sessions gezählt wird.
 *
 * Das allein reichte aber nicht. Die Wallbox hängt an der Tuya-Cloud, und die
 * hat Aussetzer; jeder davon meldete bisher „offline“ und schloss die Session.
 * Ein Ladevorgang zerfiel so in ein Dutzend Einträge. Seit dieser Fassung gilt
 * eine ABKLINGZEIT: Erst wenn das Fahrzeug ABKLINGZEIT_MS lang durchgehend weg
 * ist, wird geschlossen. Ein kurzer Wolkenbruch in der Cloud, ein Neustart des
 * Servers nach einem Deploy oder eine Regelpause laufen durch, ohne die Session
 * zu zerreissen.
 *
 * ── Verlauf ─────────────────────────────────────────────────────────────────
 * Innerhalb einer Session werden Leistungsstufen als Abschnitte mitgeschrieben
 * (`verlauf`). Eine Ampereänderung ist damit ein Abschnitt IN der Session und
 * kein neuer Ladevorgang.
 *
 * Innerhalb der Session wird getrennt gezählt:
 *   - `connectedSeconds`  gesamte Steckzeit
 *   - `chargingSeconds`   nur Zeit mit tatsächlichem Ladefluss
 *
 * ── Energie ─────────────────────────────────────────────────────────────────
 * Die Energie wird aus der Leistung integriert (P·t) und nicht aus dem
 * Gerätezähler übernommen: Das ist unabhängig von unklaren Zählerfeldern und
 * passt exakt zu den Zeitfenstern, in denen die Quellen-Aufteilung erfolgt.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  addSplit,
  attributeEvEnergy,
  emptySplit,
  gemesseneLadeleistungW,
  LADEN_AB_W,
  MAX_INTEGRATIONSSCHRITT_S,
  splitTotalWh,
  type ChargeSession,
  type ChargeSessionEnd,
  type EvEnergySplit,
} from '@energy/core';

import type { EngineState } from './engine.ts';
import { localDate, naechsterTagesbeginn } from './tageszeit.ts';
import { bewahreBeschaedigt, writeJsonAtomic } from './persist.ts';

/** Sessions unterhalb dieser Energie sind Fehlanschlüsse, kein Ladevorgang. */
const MIN_SESSION_WH = 10;
/**
 * So lange darf die Verbindung zur Wallbox abreissen, ohne dass die Session endet.
 *
 * Gilt nur für UNKLARE Zustände: Wallbox offline, Control Pilot ohne Aussage,
 * Störung. Das sind Datenlücken, keine Steckereignisse — ein Cloud-Aussetzer
 * oder ein Neustart des Servers darf einen Ladevorgang nicht zerreissen.
 */
const ABKLINGZEIT_MS = 10 * 60_000;
/**
 * So lange muss ein eindeutig gemeldetes Abstecken anhalten.
 *
 * Deutlich kürzer als die Abklingzeit: Wer absteckt und nach fünf Minuten
 * wieder ansteckt, hat zwei Ladevorgänge — früher verschmolzen die, weil jede
 * Abwesenheit gleich behandelt wurde. Eine Minute filtert ein kurzes Wackeln
 * des Control Pilot heraus.
 */
const ABGESTECKT_BESTAETIGT_MS = 60_000;
/** Ab dieser Leistungsänderung beginnt ein neuer Abschnitt im Verlauf. */
const ABSCHNITT_SCHWELLE_W = 300;
/** Obergrenze für den Verlauf je Session — schützt die Datei vor Wildwuchs. */
const VERLAUF_MAX = 400;
/**
 * Fassung des Dateiformats.
 *   2  Sessions zusammengeführt (Abklingzeit)
 *   3  Energie je Tag (`jeTag`)
 */
const FORMAT_VERSION = 3;

type TagesAnteil = { energyWh: number; chargingSeconds: number; split: EvEnergySplit };

interface OpenSession {
  id: string;
  startedAt: string;
  chargingSeconds: number;
  connectedSeconds: number;
  energyWh: number;
  maxPowerW: number;
  split: EvEnergySplit;
  hasGaps: boolean;
  faultText: string | null;
  lastSeenAt: number;
  /** Seit wann der Zustand unklar ist (offline, Control Pilot ohne Aussage). */
  getrenntSeit: number | null;
  /** Seit wann das Fahrzeug eindeutig als abgesteckt gemeldet wird. */
  abgestecktSeit: number | null;
  verlauf: { ab: string; leistungW: number; stromA: number | null }[];
  /** Aus wie vielen zuvor getrennten Vorgängen zusammengeführt. */
  teile: number;
  jeTag: Record<string, TagesAnteil>;
}

/** Was an einem Messzeitpunkt über das Laden bekannt ist. Gilt bis zum nächsten. */
interface Messpunkt {
  readonly tMs: number;
  /** `nein` nur bei eindeutiger Meldung einer erreichbaren Wallbox. */
  readonly angesteckt: 'ja' | 'nein' | 'unklar';
  readonly stoerung: boolean;
  readonly leistungW: number | null;
  readonly stromA: number | null;
  readonly faultText: string | null;
  readonly pvW: number | null;
  readonly bezugW: number | null;
  readonly einspeisungW: number | null;
  readonly speicherEntladenW: Record<string, number>;
  readonly speicherLadenW: number;
}

export class ChargeSessionLog {
  private readonly path: string;
  private sessions: ChargeSession[] = [];
  private open: OpenSession | null = null;
  private letzter: Messpunkt | null = null;
  private dirty = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = resolve(dataDir, 'ev-sessions.json');
    this.load();
    setInterval(() => this.persistIfDirty(), 60_000).unref();
  }

  /**
   * Wird bei jedem Messzyklus aufgerufen.
   *
   * @param evLeistungW Am Hauszähler geprüfte, gemessene Ladeleistung; `null`
   *   = unbekannt. Fehlt der Parameter, gilt der Wert der Wallbox.
   */
  integrate(state: EngineState, evLeistungW?: number | null): void {
    const p = this.messpunkt(state, evLeistungW);
    const vorher = this.letzter;
    this.letzter = p;

    // Das Intervall bis jetzt gehört dem VORHERIGEN Messpunkt — dieselbe
    // Halteregel wie in der Tagesbilanz.
    if (vorher !== null && this.open !== null && p.tMs > vorher.tMs) {
      this.verbuche(this.open, vorher, p.tMs);
    }
    this.zustand(p, state.polledAt);
  }

  /** Energie, Zeit und Herkunft für [vorher.tMs, bisMs] buchen. */
  private verbuche(session: OpenSession, vorher: Messpunkt, bisMs: number): void {
    this.dirty = true;
    const dauerS = (bisMs - vorher.tMs) / 1000;
    // Ein zu langes Intervall ist eine Lücke. Auch die Steckzeit ist dann
    // unbekannt; sie wird nicht geschätzt.
    if (dauerS > MAX_INTEGRATIONSSCHRITT_S || vorher.angesteckt !== 'ja') {
      session.hasGaps = true;
      return;
    }
    session.connectedSeconds += dauerS;
    session.lastSeenAt = bisMs;
    if (vorher.leistungW === null) {
      // Unbekannt ist ausdrücklich nicht dasselbe wie gemessene null Watt.
      session.hasGaps = true;
      return;
    }
    if (vorher.leistungW <= LADEN_AB_W) return;

    // An lokaler Mitternacht teilen: Die Energie gehört dem Tag, an dem sie floss.
    let start = vorher.tMs;
    while (start < bisMs) {
      const ende = Math.min(bisMs, naechsterTagesbeginn(start));
      const sekunden = (ende - start) / 1000;
      const h = sekunden / 3600;
      const stueck = attributeEvEnergy(
        {
          evW: vorher.leistungW,
          pvW: vorher.pvW,
          gridImportW: vorher.bezugW,
          gridExportW: vorher.einspeisungW,
          batteryDischargeW: vorher.speicherEntladenW,
          batteryChargeW: vorher.speicherLadenW,
        },
        h,
      );
      const energie = vorher.leistungW * h;
      session.chargingSeconds += sekunden;
      session.energyWh += energie;
      session.split = addSplit(session.split, stueck);
      if (stueck.unknownWh > 0) session.hasGaps = true;
      const tag = localDate(new Date(start));
      const bisher = session.jeTag[tag] ?? { energyWh: 0, chargingSeconds: 0, split: emptySplit() };
      session.jeTag[tag] = {
        energyWh: bisher.energyWh + energie,
        chargingSeconds: bisher.chargingSeconds + sekunden,
        split: addSplit(bisher.split, stueck),
      };
      start = ende;
    }
    if (vorher.leistungW > session.maxPowerW) session.maxPowerW = vorher.leistungW;
  }

  /** Sessionbeginn und -ende aus dem neuen Messpunkt. */
  private zustand(p: Messpunkt, at: Date): void {
    if (p.angesteckt === 'ja') {
      if (this.open === null) this.begin(at);
      const s = this.open;
      if (s === null) return;
      s.getrenntSeit = null;
      s.abgestecktSeit = null;
      s.lastSeenAt = p.tMs;
      if (p.faultText !== null) s.faultText = p.faultText;
      if (p.leistungW !== null) this.merkeAbschnitt(s, p.leistungW, p.stromA, at);
      this.dirty = true;
      return;
    }
    const s = this.open;
    if (s === null) return;
    this.dirty = true;
    if (p.angesteckt === 'nein') {
      // Eindeutig abgesteckt. Eine vorherige Unklarheit spielt dafür keine Rolle.
      s.getrenntSeit = null;
      s.abgestecktSeit ??= p.tMs;
      if (p.tMs - s.abgestecktSeit >= ABGESTECKT_BESTAETIGT_MS) this.close('unplugged');
      return;
    }
    // Unklar: Datenlücke, kein Steckereignis. Ein bereits laufendes
    // "abgesteckt" wird davon nicht bestätigt, aber auch nicht aufgehoben.
    s.getrenntSeit ??= p.tMs;
    if (p.tMs - s.getrenntSeit >= ABKLINGZEIT_MS) this.close(p.stoerung ? 'fault' : 'interrupted');
  }

  private messpunkt(state: EngineState, evLeistungW: number | null | undefined): Messpunkt {
    const snap = state.resolution.snapshot;
    const ev = snap.evCharger;
    const erreichbar = ev !== null && ev.state !== 'offline';
    const angesteckt: Messpunkt['angesteckt'] =
      !erreichbar || ev === null || ev.state === 'fault' || ev.vehicleConnected === null
        ? 'unklar'
        : ev.vehicleConnected ? 'ja' : 'nein';
    const dischargeW: Record<string, number> = {};
    let chargeW = 0;
    for (const battery of snap.batteries) {
      if (battery.dischargeW !== null && battery.dischargeW > 0) dischargeW[battery.deviceId] = battery.dischargeW;
      if (battery.chargeW !== null && battery.chargeW > 0) chargeW += battery.chargeW;
    }
    return {
      tMs: state.polledAt.getTime(),
      angesteckt,
      stoerung: ev?.state === 'fault',
      leistungW: erreichbar
        ? gemesseneLadeleistungW(evLeistungW === undefined ? ev?.chargePowerW : evLeistungW)
        : null,
      stromA: ev?.maxCurrentA ?? null,
      faultText: ev?.faultText ?? null,
      pvW: snap.solarProductionW.valueW,
      bezugW: snap.gridImportW.valueW,
      einspeisungW: snap.gridExportW.valueW,
      speicherEntladenW: dischargeW,
      speicherLadenW: chargeW,
    };
  }

  /** Abgeschlossene Sessions, neueste zuerst. */
  list(limit = 50): readonly ChargeSession[] {
    return this.sessions.slice(-Math.max(1, limit)).reverse();
  }

  /** Die gerade laufende Session, falls eine offen ist. */
  current(): ChargeSession | null {
    return this.open === null ? null : this.toSession(this.open, null);
  }

  find(id: string): ChargeSession | null {
    if (this.open?.id === id) return this.current();
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  /**
   * Aggregat über einen Zeitraum. `range`: 'day' | 'week' | 'month' | 'year' | 'total'.
   *
   * Maßgeblich ist, WANN die Energie floss — nicht, wann die Session begann.
   * Laden von 23:30 bis 00:30 zählt je zur Hälfte auf beide Tage und bleibt
   * trotzdem ein Ladevorgang. Ältere Sessions ohne Tagesaufteilung werden ihrem
   * Starttag zugerechnet und als Näherung ausgewiesen (`naeherungWh`).
   */
  stats(range: string, dateStr: string): unknown {
    const all = [...this.sessions, ...(this.open ? [this.toSession(this.open, null)] : [])];

    let split = emptySplit();
    let energyWh = 0;
    let chargingSeconds = 0;
    let naeherungWh = 0;
    let sessionCount = 0;
    const buckets = new Map<string, number>();

    for (const s of all) {
      const anteile: [string, { energyWh: number; chargingSeconds: number; split?: EvEnergySplit }][] =
        s.jeTag !== undefined
          ? Object.entries(s.jeTag)
          : [[localDayOf(s.startedAt), { energyWh: s.energyWh, chargingSeconds: s.chargingSeconds, split: s.split }]];
      let beteiligt = false;
      for (const [tag, anteil] of anteile) {
        if (!matchesRange(tag, range, dateStr)) continue;
        beteiligt = true;
        energyWh += anteil.energyWh;
        chargingSeconds += anteil.chargingSeconds;
        if (anteil.split) split = addSplit(split, anteil.split);
        if (s.jeTag === undefined) naeherungWh += anteil.energyWh;
        const key = range === 'year' || range === 'total' ? tag.slice(0, 7) : tag;
        buckets.set(key, (buckets.get(key) ?? 0) + anteil.energyWh);
      }
      if (beteiligt) sessionCount += 1;
    }

    return {
      range,
      date: dateStr,
      sessionCount,
      energyWh,
      chargingSeconds,
      split,
      attributedWh: splitTotalWh(split) - split.unknownWh,
      naeherungWh,
      buckets: [...buckets.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, wh]) => ({ key, energyWh: wh })),
    };
  }

  // ── intern ────────────────────────────────────────────────────────────

  /** Hält Leistungsstufen fest, statt jeden Messwert zu speichern. */
  private merkeAbschnitt(
    session: OpenSession,
    powerW: number,
    stromA: number | null,
    at: Date,
  ): void {
    const letzter = session.verlauf[session.verlauf.length - 1];
    const stufeNeu =
      letzter === undefined ||
      Math.abs(powerW - letzter.leistungW) >= ABSCHNITT_SCHWELLE_W ||
      (stromA !== null && stromA !== letzter.stromA);
    if (!stufeNeu) return;
    session.verlauf.push({ ab: at.toISOString(), leistungW: Math.round(powerW), stromA });
    // Ältestes verwerfen statt unbegrenzt wachsen. Der Verlauf ist Beiwerk;
    // die Kennzahlen der Session bleiben davon unberührt.
    if (session.verlauf.length > VERLAUF_MAX) session.verlauf.shift();
  }

  private begin(at: Date): void {
    this.open = {
      id: `${at.toISOString()}`,
      startedAt: at.toISOString(),
      chargingSeconds: 0,
      connectedSeconds: 0,
      energyWh: 0,
      maxPowerW: 0,
      split: emptySplit(),
      hasGaps: false,
      faultText: null,
      lastSeenAt: at.getTime(),
      getrenntSeit: null,
      abgestecktSeit: null,
      verlauf: [],
      teile: 1,
      jeTag: {},
    };
    this.dirty = true;
  }

  private close(reason: ChargeSessionEnd): void {
    const open = this.open;
    this.open = null;
    if (open === null) return;
    // Kurz angesteckt ohne nennenswerte Energie ist kein Ladevorgang.
    if (open.energyWh < MIN_SESSION_WH) {
      this.dirty = true;
      return;
    }
    this.sessions.push(this.toSession(open, reason));
    this.sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    this.persist();
  }

  private toSession(open: OpenSession, reason: ChargeSessionEnd): ChargeSession {
    return {
      id: open.id,
      startedAt: open.startedAt,
      endedAt: reason === null ? null : new Date(open.lastSeenAt).toISOString(),
      chargingSeconds: Math.round(open.chargingSeconds),
      connectedSeconds: Math.round(open.connectedSeconds),
      energyWh: open.energyWh,
      maxPowerW: open.maxPowerW,
      avgPowerW:
        open.chargingSeconds > 0 ? (open.energyWh * 3600) / open.chargingSeconds : null,
      // Das Ladegerät überträgt keinen Fahrzeug-Ladestand (IEC 61851).
      socStartPercent: null,
      socEndPercent: null,
      split: open.split,
      endReason: reason,
      faultText: open.faultText,
      hasGaps: open.hasGaps,
      verlauf: open.verlauf,
      teile: open.teile,
      jeTag: open.jeTag,
    };
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>;
    } catch {
      // Ein unlesbares Ladeprotokoll wird beiseitegelegt statt überschrieben —
      // sonst wäre die gesamte Ladehistorie mit dem nächsten Speichern weg.
      bewahreBeschaedigt(this.path);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed['sessions'])) {
      console.warn(`${this.path}: unerwarteter Inhalt, Datei wird aufbewahrt.`);
      bewahreBeschaedigt(this.path);
      return;
    }

    let verworfen = 0;
    for (const roh of parsed['sessions'] as unknown[]) {
      if (istSession(roh)) this.sessions.push(roh);
      else verworfen += 1;
    }

    // Eine beim Herunterfahren offene Session wird fortgesetzt, sofern sie
    // frisch genug ist — sonst zerschnitte jeder Deploy den Ladevorgang.
    const offen = parsed['open'] as Partial<OpenSession> | null | undefined;
    if (offen && typeof offen === 'object' && typeof offen.startedAt === 'string'
      && nichtnegativ(offen.energyWh) && nichtnegativ(offen.lastSeenAt)) {
      const alterMs = Date.now() - (offen.lastSeenAt ?? 0);
      const wieder: OpenSession = {
        ...(offen as OpenSession),
        getrenntSeit: offen.lastSeenAt ?? Date.now(),
        abgestecktSeit: null,
        verlauf: Array.isArray(offen.verlauf) ? offen.verlauf : [],
        teile: typeof offen.teile === 'number' ? offen.teile : 1,
        jeTag: typeof offen.jeTag === 'object' && offen.jeTag !== null ? offen.jeTag : {},
        // Die Zeit, in der der Server nicht lief, ist nicht gemessen.
        hasGaps: true,
      };
      if (alterMs < ABKLINGZEIT_MS) this.open = wieder;
      else if ((offen.energyWh ?? 0) >= MIN_SESSION_WH) this.sessions.push(this.toSession(wieder, 'interrupted'));
    }

    this.sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    const version = typeof parsed['version'] === 'number' ? parsed['version'] : 1;
    // Migration auf Fassung 2: Was früher als eigener Ladevorgang gezählt
    // wurde, aber nur ein Aussetzer war, wird zusammengeführt. Nur für Altdaten —
    // neuere Sessions sind bereits richtig getrennt.
    if (version < 2) {
      const vorher = this.sessions.length;
      this.sessions = fuehreZusammen(this.sessions);
      const zusammengefuehrt = vorher - this.sessions.length;
      if (zusammengefuehrt > 0) {
        console.log(
          `Ladeprotokoll: ${vorher} Einträge zu ${this.sessions.length} echten `
            + `Ladevorgängen zusammengefasst (${zusammengefuehrt} Fragmente).`,
        );
      }
    }
    if (verworfen > 0) {
      console.warn(`Ladeprotokoll: ${verworfen} ungültige Einträge — Originaldatei wird aufbewahrt.`);
      bewahreBeschaedigt(this.path);
    }
    if (version < FORMAT_VERSION || verworfen > 0) this.persist();
  }

  persist(): void {
    try {
      writeJsonAtomic(this.path, {
        version: FORMAT_VERSION,
        sessions: this.sessions,
        open: this.open,
      });
      this.dirty = false;
    } catch (error) {
      console.warn('Ladeprotokoll konnte nicht gespeichert werden:', error instanceof Error ? error.message : error);
    }
  }

  private persistIfDirty(): void {
    if (this.dirty) this.persist();
  }
}

function nichtnegativ(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

/** Eine gespeicherte Session prüfen, bevor ihr geglaubt wird. */
function istSession(roh: unknown): roh is ChargeSession {
  if (typeof roh !== 'object' || roh === null) return false;
  const s = roh as Record<string, unknown>;
  if (typeof s['id'] !== 'string' || typeof s['startedAt'] !== 'string') return false;
  if (Number.isNaN(new Date(s['startedAt']).getTime())) return false;
  if (s['endedAt'] !== null && typeof s['endedAt'] !== 'string') return false;
  if (!['energyWh', 'chargingSeconds', 'connectedSeconds', 'maxPowerW'].every((k) => nichtnegativ(s[k]))) {
    return false;
  }
  const split = s['split'] as Record<string, unknown> | undefined;
  if (typeof split !== 'object' || split === null) return false;
  if (!nichtnegativ(split['pvWh']) || !nichtnegativ(split['gridWh']) || !nichtnegativ(split['unknownWh'])) {
    return false;
  }
  if (s['jeTag'] !== undefined) {
    if (typeof s['jeTag'] !== 'object' || s['jeTag'] === null) return false;
    for (const [tag, a] of Object.entries(s['jeTag'] as Record<string, unknown>)) {
      const anteil = a as Record<string, unknown>;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(tag) || !nichtnegativ(anteil?.['energyWh'])
        || !nichtnegativ(anteil['chargingSeconds'])) return false;
    }
  }
  return true;
}

/**
 * Lokales Datum eines gespeicherten Zeitstempels.
 *
 * `startedAt` ist eine ISO-Zeichenkette in UTC. Die ersten zehn Zeichen daraus
 * zu schneiden ergäbe den UTC-Tag — und der stimmt bei uns (UTC+1 bzw. UTC+2)
 * nachts nicht mit dem Kalendertag überein.
 */
function localDayOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso.slice(0, 10) : localDate(date);
}

/** Ob ein lokaler Kalendertag in den gewählten Zeitraum fällt. */
function matchesRange(day: string, range: string, dateStr: string): boolean {
  if (range === 'total') return true;
  if (range === 'day') return day === dateStr;
  if (range === 'month') return day.slice(0, 7) === dateStr.slice(0, 7);
  if (range === 'year') return day.slice(0, 4) === dateStr.slice(0, 4);
  if (range === 'week') {
    const start = new Date(`${dateStr}T12:00:00`);
    // Montag als Wochenbeginn.
    const weekday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - weekday);
    const from = localDate(start);
    start.setDate(start.getDate() + 6);
    return day >= from && day <= localDate(start);
  }
  return true;
}

/**
 * Führt Bruchstücke eines Ladevorgangs wieder zu einer Session zusammen.
 *
 * Nur für Altbestand der Fassung 1, der bei jedem Cloud-Aussetzer geschlossen
 * hat. Zusammengeführt wird nur, was zeitlich unmittelbar aneinander
 * anschliesst (Lücke kleiner als die Abklingzeit).
 */
export function fuehreZusammen(
  sessions: readonly ChargeSession[],
  abklingzeitMs = ABKLINGZEIT_MS,
): ChargeSession[] {
  const sortiert = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const ergebnis: ChargeSession[] = [];

  for (const s of sortiert) {
    const vorher = ergebnis[ergebnis.length - 1];
    const endeVorher = vorher?.endedAt ?? vorher?.startedAt ?? null;
    const luecke =
      vorher === undefined || endeVorher === null
        ? Number.POSITIVE_INFINITY
        : new Date(s.startedAt).getTime() - new Date(endeVorher).getTime();

    if (vorher === undefined || !Number.isFinite(luecke) || luecke > abklingzeitMs || luecke < 0) {
      ergebnis.push(s);
      continue;
    }

    ergebnis[ergebnis.length - 1] = {
      ...vorher,
      endedAt: s.endedAt,
      chargingSeconds: vorher.chargingSeconds + s.chargingSeconds,
      // Die Lücke zählt als Steckzeit: Das Auto hing dran, nur die Cloud nicht.
      connectedSeconds:
        vorher.connectedSeconds + s.connectedSeconds + Math.round(luecke / 1000),
      energyWh: vorher.energyWh + s.energyWh,
      maxPowerW: Math.max(vorher.maxPowerW, s.maxPowerW),
      avgPowerW:
        vorher.chargingSeconds + s.chargingSeconds > 0
          ? ((vorher.energyWh + s.energyWh) * 3600) /
            (vorher.chargingSeconds + s.chargingSeconds)
          : null,
      split: addSplit(vorher.split, s.split),
      endReason: s.endReason,
      faultText: s.faultText ?? vorher.faultText,
      // Eine zusammengeführte Session hatte per Definition eine Lücke.
      hasGaps: true,
      verlauf: [...(vorher.verlauf ?? []), ...(s.verlauf ?? [])],
      teile: (vorher.teile ?? 1) + (s.teile ?? 1),
    };
  }

  return ergebnis;
}
