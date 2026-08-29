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

export class ManagedConnector implements EnergyConnector {
  readonly id: string;
  readonly displayName: string;

  private readonly inner: EnergyConnector;
  private readonly backoff: readonly number[];

  private status: ConnectorStatus = 'reconnecting';
  private failures = 0;
  private nextProbeAt = 0;
  private lastReading: ConnectorReading | null = null;
  private probing = false;

  constructor(inner: EnergyConnector, options: { backoffScheduleMs?: readonly number[] } = {}) {
    this.inner = inner;
    this.id = inner.id;
    this.displayName = inner.displayName;
    this.backoff = options.backoffScheduleMs ?? DEFAULT_BACKOFF_MS;
  }

  async read(): Promise<ConnectorReading> {
    const now = Date.now();

    // Erste Messung überhaupt: blockierend, damit sofort Daten da sind.
    if (this.lastReading === null) return this.probe();

    // Gesundes Gerät: normal abfragen (schnell, solange erreichbar).
    if (this.status === 'online' || this.status === 'stale') return this.probe();

    // Offline/reconnecting: sofort letzte Messung zurückgeben, Neuprüfung im
    // Hintergrund — so bremst ein totes Gerät die anderen nicht.
    if (now >= this.nextProbeAt && !this.probing) {
      this.scheduleNext();
      void this.probe().catch(() => undefined);
    }
    return this.lastReading;
  }

  /** Manueller Reconnect: sofortiger Health-Check (STEP 24–29). */
  async reconnect(): Promise<ManagedDiagnostics> {
    if (this.probing) return this.diagnostics();
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
      status: this.status,
      online: this.status === 'online',
      consecutiveFailures: this.failures,
      nextProbeInMs,
    };
  }

  private async probe(): Promise<ConnectorReading> {
    // Die Connectoren fangen ihre Fehler selbst ab und liefern im Fehlerfall
    // eine "offline"-Messung. read() wirft daher nicht.
    this.probing = true;
    try {
      const reading = await this.inner.read();
      this.lastReading = reading;
      if (this.inner.diagnostics().online) {
        this.status = 'online';
        this.failures = 0;
        this.nextProbeAt = 0;
      } else {
        this.registerFailure();
      }
      return reading;
    } finally {
      this.probing = false;
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
