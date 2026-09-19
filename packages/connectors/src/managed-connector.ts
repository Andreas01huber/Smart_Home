/**
 * Health-Gate um einen Connector (Anforderungen 24–39, 63, 65).
 *
 * Aufgaben:
 * - klares Statusmodell statt nur "online/offline",
 * - Auto-Reconnect mit Exponential Backoff (kein Hämmern schlafender Geräte),
 * - manueller Reconnect (sofortiger Health-Check),
 * - ein ausgefallenes Gerät blockiert NIE den Poll-Zyklus der anderen: solange
 *   es offline ist, wird die letzte Messung sofort zurückgegeben und die
 *   Neuprüfung läuft im Hintergrund.
 */

import type { ConnectorReading } from '@energy/core';
import type { ConnectorDiagnostics, EnergyConnector } from './types.ts';

export type ConnectorStatus =
  | 'online'
  | 'stale'
  | 'reconnecting'
  | 'offline'
  | 'error'
  | 'not_configured'
  | 'disabled';

export interface ManagedDiagnostics extends ConnectorDiagnostics {
  readonly status: ConnectorStatus;
  readonly consecutiveFailures: number;
  /** Millisekunden bis zur nächsten automatischen Prüfung (null = sofort/online). */
  readonly nextProbeInMs: number | null;
}

/** Backoff nach STEP 31: 5 s, 10 s, 30 s, 60 s, danach 60 s. */
const DEFAULT_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000];
/** Ab so vielen Fehlversuchen gilt ein Gerät als offline (davor nur "stale"). */
const OFFLINE_AFTER_FAILURES = 3;
/**
 * Absolute Frist für eine einzelne Abfrage.
 *
 * Eine Quelle, deren Zusage nie endet, darf den Messzyklus nicht festhalten.
 * Die Connectoren haben eigene Zeitgrenzen; diese hier ist das Netz darunter.
 */
const DEFAULT_DEADLINE_MS = 20_000;

export class ManagedConnector implements EnergyConnector {
  readonly id: string;
  readonly displayName: string;

  private readonly inner: EnergyConnector;
  private readonly backoff: readonly number[];

  private status: ConnectorStatus = 'reconnecting';
  private failures = 0;
  private nextProbeAt = 0;
  private lastReading: ConnectorReading | null = null;
  /**
   * Die gerade laufende Abfrage. Poll und Reconnect teilen sie sich — vorher
   * konnten beide gleichzeitig an dasselbe Gerät gehen.
   */
  private laufend: Promise<ConnectorReading> | null = null;
  /** Letzter selbst beobachteter Fehler (geworfen oder Frist). */
  private eigenerFehler: string | null = null;
  private readonly deadlineMs: number;

  constructor(
    inner: EnergyConnector,
    options: { backoffScheduleMs?: readonly number[]; deadlineMs?: number } = {},
  ) {
    this.inner = inner;
    this.id = inner.id;
    this.displayName = inner.displayName;
    this.backoff = options.backoffScheduleMs ?? DEFAULT_BACKOFF_MS;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  async read(): Promise<ConnectorReading> {
    const now = Date.now();

    // Erste Messung überhaupt: blockierend, damit sofort Daten da sind.
    if (this.lastReading === null) return this.probe();

    // Gesundes Gerät: normal abfragen (schnell, solange erreichbar).
    if (this.status === 'online' || this.status === 'stale') return this.probe();

    // Offline/reconnecting: sofort letzte Messung zurückgeben, Neuprüfung im
    // Hintergrund — so bremst ein totes Gerät die anderen nicht.
    if (now >= this.nextProbeAt && this.laufend === null) {
      this.scheduleNext();
      void this.probe().catch(() => undefined);
    }
    return this.lastReading;
  }

  /** Manueller Reconnect: sofortiger Health-Check (STEP 24–29). */
  async reconnect(): Promise<ManagedDiagnostics> {
    if (this.laufend !== null) {
      // Läuft schon eine Abfrage, wird auf sie gewartet statt eine zweite zu starten.
      await this.laufend.catch(() => undefined);
      return this.diagnostics();
    }
    this.status = 'reconnecting';
    this.nextProbeAt = 0;
    // Zwischenspeichernde Quellen (Cloud) müssen wirklich neu abfragen —
    // sonst prüft der Knopf nur den alten Zustand.
    this.inner.invalidateCache?.();
    await this.probe().catch(() => undefined);
    return this.diagnostics();
  }

  diagnostics(): ManagedDiagnostics {
    const inner = this.inner.diagnostics();
    const nextProbeInMs =
      this.status === 'offline' || this.status === 'error'
        ? Math.max(0, this.nextProbeAt - Date.now())
        : null;
    return {
      ...inner,
      lastError: this.eigenerFehler ?? inner.lastError,
      status: this.status,
      online: this.status === 'online',
      consecutiveFailures: this.failures,
      nextProbeInMs,
    };
  }

  private probe(): Promise<ConnectorReading> {
    this.laufend ??= this.pruefe().finally(() => {
      this.laufend = null;
    });
    return this.laufend;
  }

  /**
   * Eine Abfrage mit Frist.
   *
   * Die meisten Connectoren melden Fehler als "offline"-Messung. Wirft einer
   * trotzdem — oder antwortet gar nicht —, zählt das ebenso als Fehlversuch:
   * Status, Backoff und Diagnose werden fortgeschrieben, statt dass der
   * Fehler nur durchgereicht wird. Gibt es eine frühere Messung, kommt sie mit
   * ihrem echten Alter zurück; die Qualitätsprüfung weist sie als veraltet aus.
   */
  private async pruefe(): Promise<ConnectorReading> {
    let frist: ReturnType<typeof setTimeout> | undefined;
    try {
      const reading = await Promise.race([
        this.inner.read(),
        new Promise<never>((_, nein) => {
          frist = setTimeout(
            () => nein(new Error(`${this.displayName}: keine Antwort binnen ${this.deadlineMs} ms`)),
            this.deadlineMs,
          );
        }),
      ]);
      this.lastReading = reading;
      if (this.inner.diagnostics().online) {
        this.status = 'online';
        this.failures = 0;
        this.nextProbeAt = 0;
        this.eigenerFehler = null;
      } else {
        this.registerFailure();
      }
      return reading;
    } catch (error) {
      this.eigenerFehler = error instanceof Error ? error.message : String(error);
      this.registerFailure();
      if (this.lastReading !== null) return this.lastReading;
      throw error;
    } finally {
      clearTimeout(frist);
    }
  }

  private registerFailure(): void {
    this.failures++;
    this.status = this.failures >= OFFLINE_AFTER_FAILURES ? 'offline' : 'stale';
    this.scheduleNext();
  }

  private scheduleNext(): void {
    const index = Math.min(this.failures, this.backoff.length) - 1;
    const delay = this.backoff[Math.max(0, index)] ?? this.backoff[this.backoff.length - 1] ?? 60_000;
    this.nextProbeAt = Date.now() + delay;
  }
}
