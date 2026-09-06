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
  splitTotalWh,
  type ChargeSession,
  type ChargeSessionEnd,
  type EvEnergySplit,
} from '@energy/core';

import type { EngineState } from './engine.ts';
import { localDate } from './history.ts';
import { writeJsonAtomic } from './persist.ts';

/** Ab dieser Leistung gilt ein Ladevorgang als aktiv (unter 6 A ist nichts). */
const CHARGING_THRESHOLD_W = 50;
/** Längster Zeitschritt, der integriert wird — schützt vor Lücken/Neustarts. */
const MAX_DT_SECONDS = 60;
/** Sessions unterhalb dieser Energie sind Fehlanschlüsse, kein Ladevorgang. */
const MIN_SESSION_WH = 10;
/**
 * So lange darf das Fahrzeug „weg“ sein, ohne dass die Session endet.
 *
 * Deckt Cloud-Aussetzer, kurze Control-Pilot-Wackler, Regelpausen und einen
 * Neustart des Servers ab. Zehn Minuten sind lang genug für all das und kurz
 * genug, dass zwei wirklich getrennte Ladevorgänge nicht verschmelzen — dazu
 * müsste man das Auto binnen zehn Minuten ab- und wieder anstecken.
 */
const ABKLINGZEIT_MS = 10 * 60_000;
/** Ab dieser Leistungsänderung beginnt ein neuer Abschnitt im Verlauf. */
const ABSCHNITT_SCHWELLE_W = 300;
/** Obergrenze für den Verlauf je Session — schützt die Datei vor Wildwuchs. */
const VERLAUF_MAX = 400;
/** Aktuelle Fassung des Dateiformats. */
const FORMAT_VERSION = 2;

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
  /** Zeitpunkt, seit dem das Fahrzeug nicht mehr gemeldet wird. */
  getrenntSeit: number | null;
  verlauf: { ab: string; leistungW: number; stromA: number | null }[];
  /** Aus wie vielen zuvor getrennten Vorgängen zusammengeführt. */
  teile: number;
}

export class ChargeSessionLog {
  private readonly path: string;
  private sessions: ChargeSession[] = [];
  private open: OpenSession | null = null;
  private lastAt: number | null = null;
  private dirty = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = resolve(dataDir, 'ev-sessions.json');
    this.load();
    setInterval(() => this.persistIfDirty(), 60_000).unref();
  }

  /** Wird bei jedem Messzyklus aufgerufen. */
  integrate(state: EngineState): void {
    const snap = state.resolution.snapshot;
    const ev = snap.evCharger;
    const now = state.polledAt.getTime();
    const previous = this.lastAt;
    this.lastAt = now;

    // Ladegerät nicht erreichbar. Früher wurde hier sofort geschlossen — das
    // war der Grund für die vielen zerstückelten Ladevorgänge: Jeder Aussetzer
    // der Tuya-Cloud beendete den Vorgang. Jetzt läuft die Abklingzeit.
    if (ev === null || ev.state === 'offline') {
      this.abwesend(now, 'interrupted');
      return;
    }

    const connected = ev.vehicleConnected === true;

    if (!connected) {
      // `null` heisst "Control Pilot unklar", nicht "abgesteckt". Auch das
      // läuft über die Abklingzeit, statt sofort zu schliessen.
      this.abwesend(now, ev.state === 'fault' ? 'fault' : 'unplugged');
      return;
    }

    // Fahrzeug ist (wieder) da.
    if (this.open === null) this.begin(state.polledAt);
    else this.open.getrenntSeit = null;

    const session = this.open;
    if (session === null || previous === null) return;

    const dtSeconds = Math.min(MAX_DT_SECONDS, (now - previous) / 1000);
    if (dtSeconds <= 0) return;
    const hours = dtSeconds / 3600;

    session.connectedSeconds += dtSeconds;
    session.lastSeenAt = now;
    if (ev.faultText !== null) session.faultText = ev.faultText;

    const powerW = ev.chargePowerW;
    if (powerW === null || !Number.isFinite(powerW)) {
      // Ladegerät liefert die Leistung gerade nicht — Lücke offen ausweisen.
      session.hasGaps = true;
      this.dirty = true;
      return;
    }

    // Verlauf mitschreiben: Stufen, nicht jeder Messwert. Ein neuer Abschnitt
    // beginnt, wenn sich die Leistung deutlich ändert oder der eingestellte
    // Strom wechselt — also genau bei den Ereignissen, die früher fälschlich
    // wie ein neuer Ladevorgang aussahen.
    this.merkeAbschnitt(session, powerW, ev.maxCurrentA, state.polledAt);

    if (powerW > CHARGING_THRESHOLD_W) {
      session.chargingSeconds += dtSeconds;
      session.energyWh += powerW * hours;
      if (powerW > session.maxPowerW) session.maxPowerW = powerW;

      // Herkunft dieses Intervalls bestimmen — nur aus echten Messwerten.
      const dischargeW: Record<string, number> = {};
      let chargeW = 0;
      for (const battery of snap.batteries) {
        if (battery.dischargeW !== null && battery.dischargeW > 0) {
          dischargeW[battery.deviceId] = battery.dischargeW;
        }
        if (battery.chargeW !== null && battery.chargeW > 0) chargeW += battery.chargeW;
      }
      const piece = attributeEvEnergy(
        {
          evW: powerW,
          pvW: snap.solarProductionW.valueW,
          gridImportW: snap.gridImportW.valueW,
          gridExportW: snap.gridExportW.valueW,
          batteryDischargeW: dischargeW,
          batteryChargeW: chargeW,
        },
        hours,
      );
      session.split = addSplit(session.split, piece);
      if (piece.unknownWh > 0) session.hasGaps = true;
    }
    this.dirty = true;
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
   * Aggregat über einen Zeitraum. Bezugspunkt ist der Beginn des Ladevorgangs.
   * `range`: 'day' | 'week' | 'month' | 'year' | 'total'.
   */
  stats(range: string, dateStr: string): unknown {
    const all = [...this.sessions, ...(this.open ? [this.toSession(this.open, null)] : [])];
    const inRange = all.filter((s) => matchesRange(s.startedAt, range, dateStr));

    let split = emptySplit();
    let energyWh = 0;
    let chargingSeconds = 0;
    for (const s of inRange) {
      split = addSplit(split, s.split);
      energyWh += s.energyWh;
      chargingSeconds += s.chargingSeconds;
    }

    // Verlauf für die Grafik: je Tag (bzw. je Monat im Jahres-/Gesamtmodus).
    const buckets = new Map<string, number>();
    for (const s of inRange) {
      const day = localDayOf(s.startedAt);
      const key = range === 'year' || range === 'total' ? day.slice(0, 7) : day;
      buckets.set(key, (buckets.get(key) ?? 0) + s.energyWh);
    }

    return {
      range,
      date: dateStr,
      sessionCount: inRange.length,
      energyWh,
      chargingSeconds,
      split,
      attributedWh: splitTotalWh(split) - split.unknownWh,
      buckets: [...buckets.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, wh]) => ({ key, energyWh: wh })),
    };
  }

  // ── intern ────────────────────────────────────────────────────────────

  /**
   * Das Fahrzeug meldet sich gerade nicht.
   *
   * Schliesst die Session NICHT sofort, sondern merkt sich den Zeitpunkt und
   * wartet die Abklingzeit ab. Kommt das Fahrzeug vorher zurück, läuft dieselbe
   * Session weiter — das ist der ganze Unterschied zwischen einem Ladevorgang
   * und fünfzehn Einträgen in der Historie.
   */
  private abwesend(now: number, grund: ChargeSessionEnd): void {
    const session = this.open;
    if (session === null) return;
    if (session.getrenntSeit === null) {
      session.getrenntSeit = now;
      this.dirty = true;
      return;
    }
    if (now - session.getrenntSeit >= ABKLINGZEIT_MS) this.close(grund);
  }

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
    session.verlauf.push({
      ab: at.toISOString(),
      leistungW: Math.round(powerW),
      stromA,
    });
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
      verlauf: [],
      teile: 1,
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
    };
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      if (Array.isArray(parsed?.sessions)) this.sessions = parsed.sessions as ChargeSession[];

      // Eine beim Herunterfahren offene Session wird fortgesetzt, sofern sie
      // frisch genug ist. Vorher wurde sie hier abgeschlossen — mit der Folge,
      // dass jeder Deploy mitten im Laden den Vorgang in zwei zerschnitt.
      if (parsed?.open && typeof parsed.open === 'object') {
        const open = parsed.open as Partial<OpenSession> & { lastSeenAt?: number };
        const alterMs = Date.now() - (open.lastSeenAt ?? 0);
        if (alterMs < ABKLINGZEIT_MS) {
          this.open = {
            ...(open as OpenSession),
            getrenntSeit: open.lastSeenAt ?? Date.now(),
            verlauf: Array.isArray(open.verlauf) ? open.verlauf : [],
            teile: typeof open.teile === 'number' ? open.teile : 1,
          };
        } else if ((open.energyWh ?? 0) >= MIN_SESSION_WH) {
          this.sessions.push(this.toSession(open as OpenSession, 'interrupted'));
        }
      }

      this.sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

      // Migration auf Fassung 2: Was früher als eigener Ladevorgang gezählt
      // wurde, aber nur ein Aussetzer war, wird jetzt zusammengeführt.
      if (parsed?.version !== FORMAT_VERSION) {
        const vorher = this.sessions.length;
        this.sessions = fuehreZusammen(this.sessions);
        const zusammengefuehrt = vorher - this.sessions.length;
        if (zusammengefuehrt > 0) {
          console.log(
            `Ladeprotokoll: ${vorher} Einträge zu ${this.sessions.length} echten `
              + `Ladevorgängen zusammengefasst (${zusammengefuehrt} Fragmente).`,
          );
        }
        this.persist();
      }
    } catch (error) {
      console.warn('Ladeprotokoll konnte nicht geladen werden:', error);
    }
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
      console.warn('Ladeprotokoll konnte nicht gespeichert werden:', error);
    }
  }

  private persistIfDirty(): void {
    if (this.dirty) this.persist();
  }
}

/**
 * Lokales Datum eines gespeicherten Zeitstempels.
 *
 * `startedAt` ist eine ISO-Zeichenkette in UTC. Die ersten zehn Zeichen daraus
 * zu schneiden ergäbe den UTC-Tag — und der stimmt bei uns (UTC+1 bzw. UTC+2)
 * nachts nicht mit dem Kalendertag überein: Ein Ladevorgang, der um 01:00 Uhr
 * beginnt, steht in UTC noch auf dem Vortag. Gezählt wird aber nach dem Tag,
 * den die Uhr im Haus zeigt — sonst landen genau die nächtlichen Ladevorgänge,
 * also der Normalfall, im falschen Zeitraum.
 */
function localDayOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso.slice(0, 10) : localDate(date);
}

/** Ob ein Zeitpunkt in den gewählten Zeitraum fällt. */
function matchesRange(iso: string, range: string, dateStr: string): boolean {
  const day = localDayOf(iso);
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
 * Nötig, weil die frühere Fassung bei jedem Cloud-Aussetzer und bei jedem
 * Neustart des Servers geschlossen hat. In der Historie stehen dadurch
 * Ladevorgänge, die in Wahrheit einer waren — genau die "vielen einzelnen
 * Ladevorgänge", über die man in der Oberfläche stolpert.
 *
 * Zusammengeführt wird nur, was zeitlich unmittelbar aneinander anschliesst
 * (Lücke kleiner als die Abklingzeit). Zwei Ladevorgänge mit einer echten Pause
 * dazwischen bleiben zwei — dafür müsste man das Auto binnen zehn Minuten ab-
 * und wieder anstecken.
 *
 * Läuft einmalig beim Laden; danach steht Fassung 2 in der Datei.
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
