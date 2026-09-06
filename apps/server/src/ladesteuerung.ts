/**
 * Der Regeldienst für das Überschussladen.
 *
 * Hier läuft zusammen, was in `@energy/core` als reine Rechnung liegt:
 *
 *   Messzyklus  →  berechneLadeziel  →  beruhige  →  Tuya-Befehl
 *
 * Die Rechnung (`ueberschuss.ts`) und die Beruhigung (`laderegler.ts`) kennen
 * weder Uhr noch Netzwerk und sind deshalb vollständig testbar. Hier steht das,
 * was sich nicht testen lässt, ohne eine echte Wallbox anzufassen: Zeitgeber,
 * Wiederholversuche, Protokoll.
 *
 * Drei Betriebsarten, umschaltbar in config.json:
 *
 *   aus         — nichts geschieht.
 *   beobachten  — es wird gerechnet und angezeigt, aber nichts gesendet.
 *                 Der Vorgabewert: Wer die Wallbox zum ersten Mal automatisch
 *                 stellen lässt, will vorher sehen, was passieren würde.
 *   regeln      — der Ladestrom wird tatsächlich gestellt.
 *
 * Es wird ausschliesslich der Ladestrom gestellt. Der Hauptschalter der Wallbox
 * bleibt unangetastet: "Pause" heisst hier, den Strom auf das Minimum zu senken
 * und den Ladevorgang über die Wallbox-eigene Logik auslaufen zu lassen — nicht,
 * dem Fahrzeug die Versorgung abzuschalten.
 */

import {
  berechneLadeziel,
  beruhige,
  neueHistorie,
  type Ladeentscheidung,
  type Ladezustand,
  type Messwerte,
  type Reglerhistorie,
  type Reglerparameter,
  type SpeicherZustand,
  type Zeitparameter,
} from '@energy/core';
import type { TuyaEvseConnector } from '@energy/connectors';

import { ladeanschlussAus, type AppConfig } from './config.ts';
import type { EnergyEngine, EngineState } from './engine.ts';

/** Ein Eintrag im Regelprotokoll. Bewusst flach — das liest ein Mensch. */
export interface Regelschritt {
  readonly zeit: string;
  readonly zustand: Ladezustand;
  readonly pvW: number | null;
  readonly hausOhneAutoW: number | null;
  readonly evLeistungW: number | null;
  readonly netzW: number;
  readonly speicher: readonly {
    readonly name: string;
    readonly socPercent: number | null;
    readonly entladenW: number | null;
  }[];
  readonly verfuegbarW: number;
  readonly wunschA: number;
  readonly gesetztA: number;
  readonly gesendet: boolean;
  readonly grund: string;
  readonly fehler: string | null;
}

/** Was die Oberfläche über die Regelung wissen muss. */
export interface Steuerzustand {
  readonly modus: 'aus' | 'beobachten' | 'regeln';
  readonly aktiv: boolean;
  readonly zustand: Ladezustand;
  readonly grund: string;
  readonly zielA: number;
  readonly zielLeistungW: number;
  readonly gesetztA: number;
  readonly verfuegbarW: number;
  readonly hausOhneAutoW: number | null;
  readonly speicherbeitragW: number;
  readonly netzW: number;
  readonly minA: number;
  readonly maxA: number;
  readonly letzterBefehlAt: string | null;
  readonly letzterFehler: string | null;
  readonly naechsteRegelungInS: number;
  readonly protokoll: readonly Regelschritt[];
}

/** So viele Regelschritte werden vorgehalten — genug für gut zwei Stunden. */
const PROTOKOLL_MAX = 240;

/** Obergrenze für den Wiederholabstand nach Tuya-Fehlern. */
const BACKOFF_MAX_MS = 5 * 60_000;

export class Ladesteuerung {
  private timer: NodeJS.Timeout | null = null;
  private historie: Reglerhistorie = neueHistorie(0, 0);
  private letzte: Ladeentscheidung | null = null;
  private protokoll: Regelschritt[] = [];
  private letzterBefehlAt: number | null = null;
  private letzterFehler: string | null = null;
  private fehlerzahl = 0;
  private gesperrtBis = 0;
  private laeuft = false;
  private grenzen = { minA: 6, maxA: 16, schrittA: 1 };
  private letzterZustand: Ladezustand | null = null;
  private naechsteRegelungAt = 0;

  constructor(
    private readonly engine: EnergyEngine,
    private readonly wallbox: TuyaEvseConnector | null,
    private readonly config: AppConfig,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    if (this.config.ueberschuss.modus === 'aus' || this.wallbox === null) return;

    const intervallMs = this.config.ueberschuss.intervallSekunden * 1000;
    // Die Gerätegrenzen einmal vom Gerät holen. Scheitert das, bleibt es bei
    // den konservativen Vorgabewerten - niemals bei erfundenen.
    void this.wallbox.ladestromGrenzen().then((g) => {
      if (g !== null) this.grenzen = g;
    });

    this.naechsteRegelungAt = Date.now() + intervallMs;
    this.timer = setInterval(() => void this.zyklus(), intervallMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  zustand(): Steuerzustand {
    const e = this.letzte;
    const netzW = this.protokoll[this.protokoll.length - 1]?.netzW ?? 0;
    return {
      modus: this.config.ueberschuss.modus,
      aktiv: this.timer !== null,
      zustand: e?.zustand ?? (this.config.ueberschuss.modus === 'aus' ? 'aus' : 'wartet'),
      grund: e?.grund ?? 'Noch kein Regelzyklus gelaufen.',
      zielA: e?.zielA ?? 0,
      zielLeistungW: e?.zielLeistungW ?? 0,
      gesetztA: this.historie.gesetztA,
      verfuegbarW: e?.verfuegbarW ?? 0,
      hausOhneAutoW: e?.hausOhneAutoW ?? null,
      speicherbeitragW: e?.speicherbeitragW ?? 0,
      netzW,
      minA: this.grenzen.minA,
      maxA: this.grenzen.maxA,
      letzterBefehlAt:
        this.letzterBefehlAt === null ? null : new Date(this.letzterBefehlAt).toISOString(),
      letzterFehler: this.letzterFehler,
      naechsteRegelungInS: Math.max(
        0,
        Math.round((this.naechsteRegelungAt - Date.now()) / 1000),
      ),
      // Neueste zuerst — so liest man ein Protokoll.
      protokoll: [...this.protokoll].reverse(),
    };
  }

  /**
   * Kurzfassung für den Live-Strom.
   *
   * `zustand()` baut das ganze Protokoll auf — das alle zwei Sekunden über den
   * Ereignisstrom zu schicken wäre Verschwendung. Hier steht nur, was die Karte
   * braucht.
   */
  kurz(): {
    modus: string;
    zustand: Ladezustand;
    grund: string;
    zielA: number;
    gesetztA: number;
    verfuegbarW: number;
    hausOhneAutoW: number | null;
    speicherbeitragW: number;
  } {
    const e = this.letzte;
    return {
      modus: this.config.ueberschuss.modus,
      zustand: e?.zustand ?? (this.config.ueberschuss.modus === 'aus' ? 'aus' : 'wartet'),
      grund: e?.grund ?? 'Noch kein Regelzyklus gelaufen.',
      zielA: e?.zielA ?? 0,
      gesetztA: this.historie.gesetztA,
      verfuegbarW: Math.round(e?.verfuegbarW ?? 0),
      hausOhneAutoW: e?.hausOhneAutoW ?? null,
      speicherbeitragW: Math.round(e?.speicherbeitragW ?? 0),
    };
  }

  // ── intern ──────────────────────────────────────────────────────────────

  private parameter(): Reglerparameter {
    const u = this.config.ueberschuss;
    return {
      anschluss: ladeanschlussAus(this.config),
      minA: this.grenzen.minA,
      maxA: this.grenzen.maxA,
      schrittA: this.grenzen.schrittA,
      reserveW: u.reserveW,
      netzTotzoneW: u.netzTotzoneW,
      speicher: u.speicher,
      speicherStandard: u.speicherStandard,
      speicherEntladenErlaubt: u.speicherEntladenErlaubt,
      maxMessalterMs: u.maxMessalterSekunden * 1000,
    };
  }

  private zeitparameter(): Zeitparameter {
    const u = this.config.ueberschuss;
    return {
      mindestabstandMs: u.mindestabstandSekunden * 1000,
      erhoehenNachMs: u.erhoehenNachSekunden * 1000,
      senkenNachMs: u.senkenNachSekunden * 1000,
      pausierenNachMs: u.pausierenNachSekunden * 1000,
      startenNachMs: u.startenNachSekunden * 1000,
      notbremseAbW: u.notbremseAbW,
      netzTotzoneW: u.netzTotzoneW,
    };
  }

  /**
   * Messwerte aus dem Zustand der Engine.
   *
   * `hausMitAutoW` wird hier bewusst NICHT um das Auto bereinigt — das macht
   * `berechneLadeziel` selbst und nur an dieser einen Stelle. Zweimal abziehen
   * wäre der klassische Fehler jeder Überschussregelung.
   */
  private messwerte(state: EngineState): Messwerte {
    const snap = state.resolution.snapshot;
    const ev = snap.evCharger;

    const speicher: SpeicherZustand[] = snap.batteries.map((b) => ({
      id: b.deviceId,
      name: b.displayName,
      socPercent: b.socPercent,
      ladenW: b.chargeW,
      entladenW: b.dischargeW,
    }));

    // Ältester Messwert, der in die Entscheidung eingeht. Der Netzzähler ist
    // das Rückführsignal - ist der alt, ist die ganze Regelung blind.
    const alter = [
      snap.gridImportW.provenance.ageMs,
      snap.solarProductionW.provenance.ageMs,
      ev?.provenance.ageMs ?? 0,
    ].filter((a) => Number.isFinite(a));
    const messalterMs = alter.length > 0 ? Math.max(...alter) : Number.POSITIVE_INFINITY;

    return {
      pvW: snap.solarProductionW.valueW,
      hausMitAutoW: snap.houseConsumptionW.valueW,
      netzbezugW: snap.gridImportW.valueW,
      netzeinspeisungW: snap.gridExportW.valueW,
      evLeistungW: ev?.chargePowerW ?? null,
      evAngesteckt: ev?.vehicleConnected ?? null,
      evStromA: ev?.maxCurrentA ?? null,
      speicher,
      messalterMs,
      wallboxErreichbar: ev !== null && ev.state !== 'offline',
      ...(ev?.state === 'finished' ? { ladungBeendet: true } : {}),
    };
  }

  private async zyklus(): Promise<void> {
    // Ein hängender Tuya-Aufruf darf nicht dazu führen, dass sich Zyklen
    // überholen und zwei Befehle gleichzeitig unterwegs sind.
    if (this.laeuft) return;
    this.laeuft = true;
    this.naechsteRegelungAt = Date.now() + this.config.ueberschuss.intervallSekunden * 1000;

    try {
      const state = this.engine.current();
      if (state === null || this.wallbox === null) return;

      const messwerte = this.messwerte(state);
      const entscheidung = berechneLadeziel(messwerte, this.parameter());
      this.letzte = entscheidung;

      const netzW =
        (messwerte.netzbezugW ?? 0) - (messwerte.netzeinspeisungW ?? 0);

      // In Zuständen ohne Regelbedarf wird nichts gesendet, aber protokolliert:
      // "nicht verbunden" oder "gestört" sind Auskünfte, keine Ereignisse.
      const regelbar = entscheidung.zustand === 'laedt' || entscheidung.zustand.startsWith('pausiert');
      if (!regelbar) {
        this.notiere(messwerte, entscheidung, netzW, false, entscheidung.grund, null);
        return;
      }

      const ergebnis = beruhige({
        wunschA: entscheidung.zielA,
        netzbezugW: messwerte.netzbezugW ?? 0,
        jetztMs: Date.now(),
        historie: this.historie,
        zeit: this.zeitparameter(),
      });

      // Beobachten: rechnen, protokollieren, aber nichts an die Wallbox senden.
      if (this.config.ueberschuss.modus !== 'regeln') {
        this.historie = ergebnis.historie;
        this.notiere(
          messwerte,
          entscheidung,
          netzW,
          false,
          ergebnis.senden ? `${ergebnis.grund} (nur beobachtet)` : ergebnis.grund,
          null,
        );
        return;
      }

      if (!ergebnis.senden) {
        this.historie = ergebnis.historie;
        this.notiere(messwerte, entscheidung, netzW, false, ergebnis.grund, null);
        return;
      }

      // Nach einem Tuya-Fehler wird nicht sofort weitergehämmert.
      if (Date.now() < this.gesperrtBis) {
        this.notiere(
          messwerte,
          entscheidung,
          netzW,
          false,
          `${ergebnis.grund} — wartet nach Tuya-Fehler.`,
          this.letzterFehler,
        );
        return;
      }

      // Pause bedeutet: auf den kleinsten zulässigen Strom herunter. Der
      // Hauptschalter wird nicht angefasst.
      const zuSenden = ergebnis.stromA === 0 ? this.grenzen.minA : ergebnis.stromA;
      try {
        const gesetzt = await this.wallbox.setzeLadestrom(zuSenden);
        this.historie = { ...ergebnis.historie, gesetztA: ergebnis.stromA };
        this.letzterBefehlAt = Date.now();
        this.letzterFehler = null;
        this.fehlerzahl = 0;
        this.gesperrtBis = 0;
        this.notiere(
          messwerte,
          entscheidung,
          netzW,
          true,
          `${ergebnis.grund} Gesendet: ${gesetzt} A.`,
          null,
        );
      } catch (error) {
        // Historie NICHT fortschreiben: Der Sollwert gilt erst als gesetzt,
        // wenn die Wallbox ihn angenommen hat. Sonst glaubt die Regelung an
        // einen Wert, den das Gerät nie gesehen hat.
        this.fehlerzahl += 1;
        this.letzterFehler = error instanceof Error ? error.message : String(error);
        const wartenMs = Math.min(BACKOFF_MAX_MS, 30_000 * 2 ** (this.fehlerzahl - 1));
        this.gesperrtBis = Date.now() + wartenMs;
        console.warn(
          `[Laderegelung] Tuya-Befehl fehlgeschlagen (${this.fehlerzahl}. Mal): `
            + `${this.letzterFehler} — nächster Versuch in ${Math.round(wartenMs / 1000)} s.`,
        );
        this.notiere(messwerte, entscheidung, netzW, false, ergebnis.grund, this.letzterFehler);
      }
    } catch (error) {
      // Sicherheitsnetz: Der Dienst läuft rund um die Uhr und darf an keinem
      // unerwarteten Fehler sterben.
      console.warn(
        '[Laderegelung] Zyklus übersprungen:',
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.laeuft = false;
    }
  }

  /**
   * Schreibt einen Schritt ins Protokoll.
   *
   * Auf die Konsole geht nur, was sich geändert hat — ein Regelzyklus alle
   * 30 Sekunden ergäbe sonst 2880 Zeilen am Tag, in denen niemand mehr etwas
   * findet. Das vollständige Protokoll steht in der Oberfläche.
   */
  private notiere(
    messwerte: Messwerte,
    entscheidung: Ladeentscheidung,
    netzW: number,
    gesendet: boolean,
    grund: string,
    fehler: string | null,
  ): void {
    const schritt: Regelschritt = {
      zeit: new Date().toISOString(),
      zustand: entscheidung.zustand,
      pvW: messwerte.pvW,
      hausOhneAutoW: entscheidung.hausOhneAutoW,
      evLeistungW: messwerte.evLeistungW,
      netzW,
      speicher: messwerte.speicher.map((s) => ({
        name: s.name,
        socPercent: s.socPercent,
        entladenW: s.entladenW,
      })),
      verfuegbarW: Math.round(entscheidung.verfuegbarW),
      wunschA: entscheidung.zielA,
      gesetztA: this.historie.gesetztA,
      gesendet,
      grund,
      fehler,
    };

    this.protokoll.push(schritt);
    if (this.protokoll.length > PROTOKOLL_MAX) this.protokoll.shift();

    if (gesendet || entscheidung.zustand !== this.letzterZustand) {
      console.log(
        `[Laderegelung] ${entscheidung.zustand} · PV ${Math.round(messwerte.pvW ?? 0)} W · `
          + `Haus ohne Auto ${Math.round(entscheidung.hausOhneAutoW ?? 0)} W · `
          + `Netz ${Math.round(netzW)} W · verfügbar ${Math.round(entscheidung.verfuegbarW)} W · `
          + `Ziel ${entscheidung.zielA} A · ${grund}`,
      );
      this.letzterZustand = entscheidung.zustand;
    }
  }
}
