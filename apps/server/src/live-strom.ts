/**
 * Live-Strom (Server-Sent Events) für alle offenen Browser.
 *
 * Ein Verteiler statt einer Schleife je Verbindung: Der Zustand wird je
 * Messzyklus EINMAL serialisiert und an alle Empfänger geschrieben. Vorher lief
 * `serializeState` für jeden Browser einzeln — fünf offene Dashboards,
 * fünffache Arbeit alle zwei Sekunden auf dem Dauerläufer.
 *
 * Jeder Empfänger wird vor dem Schreiben gefragt, ob er noch angemeldet ist:
 * Der Strom bleibt stundenlang offen, und "Gerät abmelden" soll wirken, nicht
 * nur behaupten.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { EnergyEngine, EngineState } from './engine.ts';

/** Abstand des Pulses; der Browser gilt nach dem Zweieinhalbfachen ohne Nachricht als getrennt. */
export const SSE_PULS_MS = 10_000;

interface Empfaenger {
  readonly response: ServerResponse;
  readonly nochAngemeldet: () => boolean;
}

export class LiveStrom {
  private readonly empfaenger = new Set<Empfaenger>();
  private puls: NodeJS.Timeout | null = null;
  private abmelden: (() => void)[] = [];

  constructor(
    private readonly engine: EnergyEngine,
    /** Serialisiert den Zustand — wird je Ereignis genau einmal gerufen. */
    private readonly serialisiere: (state: EngineState) => unknown,
    /**
     * Meldet Änderungen der Regelung, damit sie sofort ankommen und nicht erst
     * mit der nächsten Messung. Es wird der letzte Messstand mitgeschickt.
     */
    private readonly aufRegelung: ((beobachter: () => void) => () => void) | null = null,
  ) {}

  start(): void {
    if (this.puls !== null) return;
    this.abmelden.push(this.engine.subscribe((state) => this.sende(state)));
    if (this.aufRegelung !== null) {
      this.abmelden.push(this.aufRegelung(() => {
        const zustand = this.engine.current();
        if (zustand !== null) this.sende(zustand);
      }));
    }
    this.puls = setInterval(() => this.schreibeAllen(
      `event: puls\ndata: ${JSON.stringify({ jetzt: new Date().toISOString() })}\n\n`,
    ), SSE_PULS_MS);
    this.puls.unref();
  }

  stop(): void {
    if (this.puls !== null) clearInterval(this.puls);
    this.puls = null;
    for (const ab of this.abmelden) ab();
    this.abmelden = [];
    for (const e of this.empfaenger) e.response.end();
    this.empfaenger.clear();
  }

  anzahl(): number {
    return this.empfaenger.size;
  }

  verbinde(request: IncomingMessage, response: ServerResponse, nochAngemeldet: () => boolean = () => true): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Für Zwischenstationen (Cloudflare-Tunnel, nginx): nicht puffern.
      'x-accel-buffering': 'no',
    });
    const e: Empfaenger = { response, nochAngemeldet };
    this.empfaenger.add(e);
    request.on('close', () => {
      this.empfaenger.delete(e);
      response.end();
    });
    // Sofort den letzten Stand, damit die Seite nicht auf den nächsten Takt wartet.
    const aktuell = this.engine.current();
    if (aktuell !== null) this.schreibe(e, `data: ${JSON.stringify(this.serialisiere(aktuell))}\n\n`);
  }

  private sende(state: EngineState): void {
    if (this.empfaenger.size === 0) return;
    this.schreibeAllen(`data: ${JSON.stringify(this.serialisiere(state))}\n\n`);
  }

  private schreibeAllen(text: string): void {
    for (const e of this.empfaenger) this.schreibe(e, text);
  }

  private schreibe(e: Empfaenger, text: string): void {
    // Ein Handy, das in den Schlaf geht, trennt ohne Abmeldung; der nächste
    // Schreibversuch läuft ins Leere. Das ist der Normalfall.
    if (e.response.writableEnded || e.response.destroyed) {
      this.empfaenger.delete(e);
      return;
    }
    if (!e.nochAngemeldet()) {
      this.empfaenger.delete(e);
      e.response.end();
      return;
    }
    try {
      e.response.write(text);
    } catch {
      this.empfaenger.delete(e);
      e.response.end();
    }
  }
}
