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
 * Gestellt werden zwei Dinge: der Ladestrom (`charge_cur_set`) und der
 * Hauptschalter (`switch`). Der Schalter musste dazu, weil "Pause" sonst gar
 * keine Pause ist: Der kleinste Ladestrom sind gut 4 kW, und wenn die Sonne die
 * nicht hergibt, kommen sie aus dem Netz — genau das, was diese Regelung
 * verhindern soll. `work_mode` bleibt unangetastet.
 *
 * ── Volladung ───────────────────────────────────────────────────────────────
 * Daneben gibt es den bewussten Übersteuerungsfall: Wer morgen früh voll
 * losfahren muss, drückt "Volladung" und nimmt den Netzbezug in Kauf. Das ist
 * kein Schlupfloch in der Autarkieregel, sondern eine ausdrückliche Entscheidung
 * des Menschen — sie wird deshalb auch deutlich angezeigt und endet von selbst,
 * sobald das Fahrzeug abgesteckt wird.
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
  /** Erzwungene Volladung aus dem Netz — vom Menschen eingeschaltet. */
  readonly volladung: boolean;
  readonly protokoll: readonly Regelschritt[];
}

/** So viele Regelschritte werden vorgehalten — genug für gut zwei Stunden. */
const PROTOKOLL_MAX = 240;

/** Obergrenze für den Wiederholabstand nach Tuya-Fehlern. */
const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Kürzere Obergrenze, wenn ein STOPP nicht durchkam.
 *
 * Fünf Minuten zu warten ist richtig, wenn eine Erhöhung scheitert — dann lädt
 * das Auto eben etwas langsamer. Bei einem misslungenen Stopp sind fünf Minuten
 * fünf Minuten Netzbezug. Deshalb wird hier deutlich schneller nachgefasst.
 */
const BACKOFF_STOPP_MAX_MS = 60_000;

/**
 * Ab dieser gemessenen Leistung gilt das Fahrzeug als ladend.
 *
 * Deutlich unter dem kleinsten Ladestrom (6 A sind gut 4 kW) und deutlich über
 * dem Grundrauschen der Wallbox-Elektronik.
 */
const LAEDT_AB_W = 200;

/** Platzhalter für "wir wissen nicht, was an der Wallbox eingestellt ist". */
const UNBEKANNT_A = -1;

/**
 * Kürzester Abstand zwischen zwei Schnellprüfungen.
 *
 * Die Engine misst alle zwei Sekunden. Jedes Mal einen vollen Zyklus samt
 * Tuya-Aufruf zu starten waere Unfug; fuenf Sekunden sind schnell genug, um
 * eine Wolke abzufangen, und langsam genug, um die Cloud nicht zu ueberrennen.
 */
const SCHNELLPRUEFUNG_ABSTAND_MS = 5000;

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
  /** Vom Benutzer erzwungene Volladung; Netzbezug ausdrücklich in Kauf genommen. */
  private volladung = false;
  /** Zuletzt an die Wallbox gesendeter Schalterzustand; null = unbekannt. */
  private ladenAn: boolean | null = null;
  /** Ob der Startwert schon aus dem Gerät übernommen wurde. */
  private initialisiert = false;
  private letzteSchnellpruefungAt = 0;
  private abmelden: (() => void) | null = null;

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
      console.log(
        `[Laderegelung] Ladestrom ${this.grenzen.minA}-${this.grenzen.maxA} A `
          + `in Schritten von ${this.grenzen.schrittA} A `
          + `(${g === null ? 'Vorgabe — Geraet hat keine Grenzen gemeldet' : 'vom Geraet gemeldet'}).`,
      );
    });
    // Einmalig auflisten, was das Geraet an Steuerpunkten anbietet. Steht hier,
    // weil sich sonst nur durch Ausprobieren klaeren laesst, ob das
    // Cloud-Projekt ueberhaupt schreiben darf.
    void this.wallbox.steuerfunktionen().then((f) => {
      console.log(
        f.length === 0
          ? '[Laderegelung] Steuerfunktionen nicht abrufbar — moeglicherweise hat das '
              + 'Tuya-Projekt nur Leserechte.'
          : `[Laderegelung] Steuerbar laut Geraet: ${f.map((x) => x.code).join(', ')}`,
      );
    });

    this.naechsteRegelungAt = Date.now() + intervallMs;
    this.timer = setInterval(() => void this.zyklus(), intervallMs);
    this.timer.unref();

    // ── Schnellpfad ─────────────────────────────────────────────────────────
    // Der 30-Sekunden-Takt ist richtig für das gemächliche Nachführen, aber zu
    // träge für den einen Fall, der wirklich zählt: Eine Wolke zieht vor die
    // Sonne, acht Kilowatt fehlen schlagartig, und bis zum nächsten Zyklus
    // holt sich das Auto die Differenz aus dem Netz.
    //
    // Vorhersehen lässt sich das nicht — eine Wolke kündigt sich nicht an. Was
    // sich verkürzen lässt, ist die Zeit bis zur Reaktion. Deshalb hängt sich
    // die Regelung zusätzlich an den Messtakt der Engine (alle zwei Sekunden)
    // und greift sofort ein, sobald wirklich Strom aus dem Netz fliesst,
    // während das Auto lädt. Aus einem halben Minutchen werden zwei Sekunden.
    this.abmelden = this.engine.subscribe((state) => {
      if (this.config.ueberschuss.modus !== 'regeln' || this.laeuft) return;
      if (Date.now() - this.letzteSchnellpruefungAt < SCHNELLPRUEFUNG_ABSTAND_MS) return;

      const snap = state.resolution.snapshot;
      const netzbezug = snap.gridImportW.valueW ?? 0;
      const evLeistung = snap.evCharger?.chargePowerW ?? 0;
      if (evLeistung <= LAEDT_AB_W) return;
      if (netzbezug <= this.config.ueberschuss.notbremseAbW) return;

      this.letzteSchnellpruefungAt = Date.now();
      void this.zyklus();
    });
  }

  /**
   * Volladung ein- oder ausschalten.
   *
   * Bewusst ohne Zeitbegrenzung: Wer sie einschaltet, will sein Auto voll haben.
   * Sie endet, wenn sie ausgeschaltet wird oder das Fahrzeug abgesteckt wird —
   * so gilt sie nicht versehentlich für den nächsten Ladevorgang mit.
   */
  setzeVolladung(an: boolean): void {
    if (this.volladung === an) return;
    this.setzeVolladungStill(an);
    // Nicht bis zum nächsten Zyklus warten: Wer den Knopf drückt, will es sehen.
    void this.zyklus();
  }

  /** Wie `setzeVolladung`, aber ohne sofortigen Zyklus — für Aufrufe von innen. */
  private setzeVolladungStill(an: boolean): void {
    this.volladung = an;
    console.log(
      an
        ? '[Laderegelung] Volladung eingeschaltet — es wird bis zur Obergrenze geladen, '
            + 'auch aus dem Netz.'
        : '[Laderegelung] Volladung beendet — zurück zur Überschussregelung.',
    );
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.abmelden?.();
    this.abmelden = null;
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
      volladung: this.volladung,
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
    volladung: boolean;
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
      volladung: this.volladung,
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
      netzImportTotzoneW: u.netzImportTotzoneW,
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

      // Beim ersten Zyklus weiss die Regelung nicht, was an der Wallbox
      // eingestellt ist — und sie darf es auch nicht annehmen. Tat sie bisher:
      // Die Historie startete mit "0 A gesetzt", ein gewünschter Stopp galt
      // damit als bereits erledigt ("Sollwert unverändert") und es ging nie ein
      // Befehl hinaus. UNBEKANNT ist die einzige ehrliche Aussage, und sie
      // sorgt dafür, dass der erste Zyklus in jedem Fall einen Befehl schickt.
      if (!this.initialisiert) {
        this.initialisiert = true;
        this.historie = neueHistorie(UNBEKANNT_A, Date.now());
      }

      // ── Abgleich mit der Wirklichkeit ───────────────────────────────────
      // Der wichtigste Sicherheitsnetz-Griff dieser Datei. Bisher glaubte die
      // Regelung ihrem eigenen Gedächtnis: Stand dort "abgeschaltet", wurde
      // nichts mehr gesendet. Schaltet die Wallbox aber von sich aus wieder ein
      // — neu angesteckt, eigener Zeitplan, verlorener Befehl —, lädt das Auto
      // munter aus dem Netz weiter, und niemand merkt es.
      //
      // Deshalb entscheidet hier der Messwert, nicht die Erinnerung: Fliesst
      // Strom, obwohl wir pausiert zu haben glauben, wird das Gedächtnis
      // verworfen und der Stopp erneut geschickt.
      const laedtWirklich = (messwerte.evLeistungW ?? 0) > LAEDT_AB_W;
      if (laedtWirklich && this.historie.gesetztA === 0) {
        console.warn(
          `[Laderegelung] Die Wallbox lädt mit ${Math.round(messwerte.evLeistungW ?? 0)} W, `
            + 'obwohl sie abgeschaltet sein sollte — Stopp wird erneut gesendet.',
        );
        this.historie = { ...this.historie, gesetztA: messwerte.evStromA ?? UNBEKANNT_A };
        this.ladenAn = null;
      }

      let entscheidung = berechneLadeziel(messwerte, this.parameter());

      // Volladung endet, sobald das Fahrzeug weg ist — sonst gälte sie
      // stillschweigend auch für den nächsten Ladevorgang.
      if (this.volladung && messwerte.evAngesteckt === false) this.setzeVolladungStill(false);

      // Übersteuerung durch den Menschen: bis zur Obergrenze laden, Netzbezug
      // ausdrücklich in Kauf genommen. Die Gerätegrenzen gelten weiterhin.
      if (this.volladung && messwerte.evAngesteckt === true && messwerte.wallboxErreichbar) {
        entscheidung = {
          ...entscheidung,
          zustand: 'laedt',
          zielA: this.grenzen.maxA,
          zielLeistungW: 0,
          grund: `Volladung erzwungen — lädt mit ${this.grenzen.maxA} A, auch aus dem Netz.`,
        };
      }
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

      try {
        // Pause heisst abschalten, nicht "auf 6 A herunter". Der kleinste
        // Ladestrom sind gut 4 kW — ohne Sonne kämen die aus dem Netz, und
        // genau das ist der Fall, den diese Regelung ausschliessen soll.
        let gesetzt: number;
        if (ergebnis.stromA === 0) {
          await this.wallbox.setzeLaden(false);
          this.ladenAn = false;
          gesetzt = 0;
        } else {
          gesetzt = await this.wallbox.setzeLadestrom(ergebnis.stromA);
          // Nach einer Pause muss erst wieder eingeschaltet werden. Der Strom
          // zuerst, damit das Fahrzeug nicht kurz mit dem alten Wert anläuft.
          if (this.ladenAn !== true) {
            await this.wallbox.setzeLaden(true);
            this.ladenAn = true;
          }
        }
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
          `${ergebnis.grund} Gesendet: ${gesetzt === 0 ? 'Ladung abgeschaltet' : `${gesetzt} A`}.`,
          null,
        );
      } catch (error) {
        // Historie NICHT fortschreiben: Der Sollwert gilt erst als gesetzt,
        // wenn die Wallbox ihn angenommen hat. Sonst glaubt die Regelung an
        // einen Wert, den das Gerät nie gesehen hat.
        this.fehlerzahl += 1;
        this.letzterFehler = error instanceof Error ? error.message : String(error);
        // Ein misslungener Stopp wird schneller wiederholt als eine misslungene
        // Erhöhung — die eine Richtung kostet Netzstrom, die andere nur Zeit.
        const obergrenze =
          ergebnis.stromA === 0 ? BACKOFF_STOPP_MAX_MS : BACKOFF_MAX_MS;
        const wartenMs = Math.min(obergrenze, 30_000 * 2 ** (this.fehlerzahl - 1));
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
