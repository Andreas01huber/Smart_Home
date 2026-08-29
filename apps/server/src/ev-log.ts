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

    // Ladegerät nicht erreichbar: laufende Session sauber abschliessen, statt
    // sie mit erfundenen Werten weiterlaufen zu lassen.
    if (ev === null || ev.state === 'offline') {
      if (this.open !== null) this.close('interrupted');
      return;
    }

    const connected = ev.vehicleConnected === true;

    if (connected && this.open === null) this.begin(state.polledAt);
    if (!connected && this.open !== null) {
      this.close(ev.state === 'fault' ? 'fault' : 'unplugged');
    }
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
    };
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      if (Array.isArray(parsed?.sessions)) this.sessions = parsed.sessions as ChargeSession[];
      // Eine beim Herunterfahren offene Session wird als unterbrochen
      // übernommen — ihre Daten gehen nicht verloren.
      if (parsed?.open && typeof parsed.open === 'object') {
        const open = parsed.open as OpenSession;
        if (open.energyWh >= MIN_SESSION_WH) {
          this.sessions.push(this.toSession(open, 'interrupted'));
          this.sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        }
      }
    } catch (error) {
      console.warn('Ladeprotokoll konnte nicht geladen werden:', error);
    }
  }

  persist(): void {
    try {
      writeJsonAtomic(this.path, { sessions: this.sessions, open: this.open });
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
