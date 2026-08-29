/**
 * Energy Data Engine: fragt alle Connectoren ab, löst die maßgebliche Quelle
 * je Messgröße auf und stellt das Ergebnis als Snapshot bereit.
 */

import { resolveSnapshot, type ConnectorReading, type ResolutionResult } from '@energy/core';
import type { EnergyConnector, ConnectorDiagnostics } from '@energy/connectors';

import type { AppConfig } from './config.ts';

export interface EngineState {
  readonly resolution: ResolutionResult;
  readonly readings: readonly ConnectorReading[];
  readonly diagnostics: readonly ConnectorDiagnostics[];
  readonly polledAt: Date;
  readonly pollDurationMs: number;
}

export class EnergyEngine {
  private state: EngineState | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(state: EngineState) => void>();

  constructor(
    private readonly connectors: readonly EnergyConnector[],
    private readonly config: AppConfig,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  current(): EngineState | null {
    return this.state;
  }

  subscribe(listener: (state: EngineState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async poll(): Promise<void> {
    const startedAt = Date.now();

    try {
      // Eine ausgefallene Quelle darf die übrigen nicht mitreissen: mit
      // Promise.all hätte eine einzige abgelehnte Zusage den ganzen Messzyklus
      // verworfen — auch die Werte der Geräte, die einwandfrei geantwortet
      // haben. Deshalb allSettled: Was da ist, wird verwendet, der Rest fehlt
      // und wird als fehlend ausgewiesen.
      const settled = await Promise.allSettled(
        this.connectors.map((connector) => connector.read()),
      );
      const readings: ConnectorReading[] = [];
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          readings.push(result.value);
          return;
        }
        console.warn(
          `Quelle ${this.connectors[index]?.id ?? 'unbekannt'} übersprungen:`,
          result.reason instanceof Error ? result.reason.message : result.reason,
        );
      });

      const resolution = resolveSnapshot(readings, this.config.sourceMapping);

      this.state = {
        resolution,
        readings,
        diagnostics: this.connectors.map((connector) => connector.diagnostics()),
        polledAt: new Date(),
        pollDurationMs: Date.now() - startedAt,
      };

      // Jeder Empfänger für sich: Ein abgebrochener Event-Stream (Browser
      // geschlossen, Handy im Schlaf) darf die Energie-Buchhaltung und die
      // übrigen offenen Dashboards nicht um ihren Messwert bringen.
      for (const listener of this.listeners) {
        try {
          listener(this.state);
        } catch (error) {
          console.warn(
            'Empfänger eines Messwerts hat einen Fehler gemeldet:',
            error instanceof Error ? error.message : error,
          );
        }
      }
    } catch (error) {
      // Sicherheitsnetz für den Dauerbetrieb (24/7): Die Connectoren fangen ihre
      // Fehler bereits selbst ab, ein Poll wirft also normalerweise nie. Sollte
      // dennoch etwas Unerwartetes durchkommen (künftiger Connector, ungültige
      // Daten), darf das den Sammler nicht beenden — der letzte gültige Zustand
      // bleibt erhalten, der nächste Poll versucht es erneut.
      console.warn(
        'Messzyklus übersprungen (unerwarteter Fehler):',
        error instanceof Error ? error.message : error,
      );
    }
  }
}
