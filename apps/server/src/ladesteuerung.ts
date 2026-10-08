/**
 * Der Regeldienst für das Überschussladen.
 *
 * Hier läuft zusammen, was in `@energy/core` als reine Rechnung liegt:
 *
 *   Messzyklus → berechneLadeziel → uebersteuere → beruhige → Befehl
 *
 * Die Rechnung (`ueberschuss.ts`), die Übersteuerungen (`ladeentscheidung.ts`)
 * und die Beruhigung (`laderegler.ts`) kennen weder Uhr noch Netzwerk und sind
 * vollständig testbar. Die Ausführung des Befehls samt Wiederholung steht in
 * `ladebefehl.ts`. Hier bleibt, was Zustand über die Zeit braucht: Zeitgeber,
 * Gedächtnis, Abgleich mit der Wirklichkeit, Protokoll.
 *
 * Drei Modi, umschaltbar in config.json:
 *
 *   aus         — nichts geschieht.
 *   beobachten  — es wird gerechnet und angezeigt, aber nichts gesendet.
 *   regeln      — der Ladestrom wird tatsächlich gestellt.
 *
 * ── Zwei Betriebsarten für den Menschen ────────────────────────────────────
 * `intelligent` lädt nur aus eigener Erzeugung, `manuell` mit einem festen
 * Ladestrom, notfalls aus dem Netz. Der Handbetrieb ist kein Schlupfloch in der
 * Autarkieregel, sondern eine ausdrückliche Entscheidung.
 *
 * ── Ausfallverhalten ───────────────────────────────────────────────────────
 * Die Wallbox hängt an der Cloud; stirbt der Server, bleibt ihr letzter Befehl
 * stehen. Deshalb: Beim geordneten Herunterfahren wird im intelligenten
 * Betrieb ein Stopp gesendet (`beimHerunterfahren`), beim Start läuft sofort
 * ein Abgleichzyklus. Ein Absturz ohne Herunterfahren bleibt eine Lücke, die
 * nur ein lokaler Steuerpfad schliessen kann.
 */

import {
  anschlussName,
  anschlussAusPhasenmessung,
  berechneLadeziel,
  beruhige,
  bewaehrtW,
  gedaechtnisAusMesswerten,
  gemessenerAnschluss,
  LADEN_AB_W,
  ladeleistungAusStromW,
  LEERES_GEDAECHTNIS,
  merkeEntladung,
  nachweisZuruecknehmen,
  neueHistorie,
  speicherspielraum,
  uebersteuere,
  begrenzeAufDose,
  type Dosengrenzen,
  type Ladeanschluss,
  type Ladeentscheidung,
  type Ladezustand,
  type Messwerte,
  type Reglerhistorie,
  type Reglerparameter,
  type Reglerwahl,
  type Speichergedaechtnis,
  type SpeicherZustand,
  type Zeitparameter,
} from '@energy/core';
import type { Ladestromgrenzen, SteuerbaresLadegeraet } from '@energy/connectors';

import { ladeanschlussAus, type AppConfig } from './config.ts';
import { ladeDose, merkeDose } from './wallbox-speicher.ts';
import { ladeLademodus, merkeLademodus } from './lademodus-speicher.ts';
import { Befehlsausfuehrung, type Befehlsstand } from './ladebefehl.ts';
import type { EnergyEngine, EngineState } from './engine.ts';
import type { Ereignisprotokoll } from './ereignisse.ts';

export type { Befehlsstand } from './ladebefehl.ts';

/** Wie geladen wird — die Entscheidung des Menschen, nicht der Regelung. */
export type Betriebsart = 'intelligent' | 'manuell';

/** Was die Wallbox zuletzt selbst meldete — nicht, was gesendet wurde. */
export interface Geraetesicht {
  readonly erreichbar: boolean;
  readonly angesteckt: boolean | null;
  readonly schalterAn: boolean | null;
  /** Eingestellte Strombegrenzung laut Gerät. */
  readonly stromA: number | null;
  /** Gemessene Ladeleistung; `null` = unbekannt. */
  readonly leistungW: number | null;
  /** Alter der letzten Gerätemeldung. */
  readonly alterMs: number | null;
}

/** Wie das Auto angesteckt ist, samt Klartext für die Oberfläche. */
export interface Anschlussinfo {
  readonly phasen: 1 | 3;
  readonly spannungV: number;
  readonly name: string;
  /** Was ein Ampere an dieser Dose bedeutet — für Regler und Vorschau. */
  readonly wattProAmpere: number;
}

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
  readonly betriebsart: Betriebsart | null;
  readonly befehl: Befehlsstand | null;
  readonly geraet: Geraetesicht | null;
  readonly manuellA: number;
  /** Nur noch für ältere Oberflächen: Handbetrieb auf dem Höchstwert. */
  readonly volladung: boolean;
  readonly anschluss: Anschlussinfo;
  readonly fordertNicht: boolean;
  readonly gestoppt: boolean;
  readonly haushaltMaxA: number;
  readonly protokoll: readonly Regelschritt[];
}

/** Kurzfassung für den Live-Strom — ohne das Protokoll. */
export type Steuerkurz = Omit<
  Steuerzustand,
  'protokoll' | 'aktiv' | 'zielLeistungW' | 'netzW' | 'letzterBefehlAt' | 'naechsteRegelungInS'
>;

/** So viele Regelschritte werden vorgehalten — genug für gut zwei Stunden. */
const PROTOKOLL_MAX = 240;

/** Platzhalter für "wir wissen nicht, was an der Wallbox eingestellt ist". */
const UNBEKANNT_A = -1;

/**
 * So oft wird eingeschaltet, bevor die Regelung aufgibt. Drei Versuche
 * hintereinander ohne einen einzigen Ampere sind eindeutig: Der Akku ist voll,
 * oder die im Auto eingestellte Ladegrenze ist erreicht.
 */
const VERSUCHE_BIS_AUFGABE = 3;

/** Danach wird es noch einmal versucht — ein Fahrzeug darf seine Meinung ändern. */
const NEUER_VERSUCH_MS = 30 * 60_000;

/** Kürzester Abstand zwischen zwei Schnellprüfungen. */
const SCHNELLPRUEFUNG_ABSTAND_MS = 5000;

/** Vorgabe, wenn das Gerät seine Grenzen nicht meldet. */
const GRENZEN_VORGABE: Ladestromgrenzen = { minA: 6, maxA: 16, schrittA: 1 };

/**
 * Ein Befehl ohne Beobachtungszeit — für Vorgaben von Hand. Gesendet wird nur,
 * wenn sich wirklich etwas ändert.
 */
function sofortBefehl(
  stromA: number,
  historie: Reglerhistorie,
  jetztMs: number,
): { senden: boolean; stromA: number; grund: string; historie: Reglerhistorie } {
  const aendert = stromA !== historie.gesetztA;
  return {
    senden: aendert,
    stromA,
    grund: aendert ? `Von Hand auf ${stromA} A.` : 'Sollwert unverändert.',
    historie: aendert
      ? { ...historie, wunschA: stromA, wunschSeitMs: jetztMs }
      : { ...historie, wunschA: stromA },
  };
}

/** Lage des Fahrzeugs — nimmt es Strom an, ist es angesteckt? */
interface Fahrzeuglage {
  warAngesteckt: boolean | null;
  fordertNicht: boolean;
  /** Wie oft hintereinander eingeschaltet wurde, ohne dass Strom floss. */
  angeboteOhneLadung: number;
  /** Wann der nächste Versuch frühestens erlaubt ist, nachdem aufgegeben wurde. */
  naechsterVersuchAt: number;
  /** Höchste je gemessene Ladeleistung an diesem Anschluss. */
  hoechsteLadeleistungW: number;
}

export class Ladesteuerung {
  // ── Zeitgeber ─────────────────────────────────────────────────────────
  private timer: NodeJS.Timeout | null = null;
  private abmelden: (() => void) | null = null;
  private laeuft = false;
  private erneutRegeln = false;
  private naechsteRegelungAt = 0;
  private letzteSchnellpruefungAt = 0;

  // ── Wahl des Menschen (dauerhaft in lademodus.json) ───────────────────
  private betriebsart: Betriebsart | null = null;
  private manuellA = 0;
  private gestoppt = false;

  // ── Regler ────────────────────────────────────────────────────────────
  private historie: Reglerhistorie = neueHistorie(0, 0);
  private initialisiert = false;
  private letzte: Ladeentscheidung | null = null;
  private grenzen: Ladestromgrenzen = GRENZEN_VORGABE;
  private anschluss: Ladeanschluss;
  private gedaechtnis: Speichergedaechtnis = LEERES_GEDAECHTNIS;
  private mitSpeicherGerechnet = false;
  /** Was an der Wallbox zuletzt eingestellt war, laut Gerät. */
  private geraeteStromA: number | null = null;

  // ── Fahrzeug und Gerät ────────────────────────────────────────────────
  private readonly fahrzeug: Fahrzeuglage = {
    warAngesteckt: null,
    fordertNicht: false,
    angeboteOhneLadung: 0,
    naechsterVersuchAt: 0,
    hoechsteLadeleistungW: 0,
  };
  private geraet: Geraetesicht | null = null;
  private readonly befehle: Befehlsausfuehrung | null;

  // ── Protokoll und Beobachter ──────────────────────────────────────────
  private protokoll: Regelschritt[] = [];
  private letzterZustand: Ladezustand | null = null;
  private readonly beobachter = new Set<() => void>();
  private letzteMeldung = '';

  constructor(
    private readonly engine: EnergyEngine,
    private readonly wallbox: SteuerbaresLadegeraet | null,
    private readonly config: AppConfig,
    private readonly datenverzeichnis: string | null = null,
    private readonly ereignisse: Ereignisprotokoll | null = null,
  ) {
    this.befehle = wallbox === null ? null : new Befehlsausfuehrung(wallbox, () => this.melde());

    const gemerkt = datenverzeichnis === null ? null : ladeDose(datenverzeichnis);
    this.anschluss = gemerkt === null
      ? ladeanschlussAus(config)
      : { phasen: gemerkt.phasen, spannungV: gemerkt.spannungV };
    if (gemerkt !== null) {
      console.log(
        `[Laderegelung] Zuletzt erkannte Dose: ${anschlussName(this.anschluss)} `
          + `(${Math.round(this.anschluss.spannungV)} V).`,
      );
    }
    const modus = datenverzeichnis === null ? null : ladeLademodus(datenverzeichnis);
    if (modus !== null) {
      this.betriebsart = modus.betriebsart;
      this.manuellA = modus.manuellA;
      this.gestoppt = modus.pausiert;
    }
  }

  // ── Lebenszyklus ──────────────────────────────────────────────────────

  lerneAus(
    punkte: readonly { readonly id: string; readonly entladenW: number; readonly tMs: number }[],
  ): void {
    this.gedaechtnis = gedaechtnisAusMesswerten(punkte, Date.now());
    const zeilen = Object.entries(this.gedaechtnis)
      .map(([id, n]) => `${id} ${Math.round(n.bewaehrtW)} W`)
      .join(', ');
    console.log(
      zeilen === ''
        ? '[Laderegelung] Keine Speichererfahrung im Verlauf — wird im Betrieb gelernt.'
        : `[Laderegelung] Nachgewiesene Entladeleistung: ${zeilen}.`,
    );
  }

  start(): void {
    if (this.timer !== null) return;
    if (this.config.ueberschuss.modus === 'aus' || this.wallbox === null) return;
    const wallbox = this.wallbox;

    const intervallMs = this.config.ueberschuss.intervallSekunden * 1000;
    void wallbox.ladestromGrenzen().then((g) => {
      if (g !== null) this.grenzen = g;
      console.log(
        `[Laderegelung] Ladestrom ${this.grenzen.minA}-${this.grenzen.maxA} A `
          + `in Schritten von ${this.grenzen.schrittA} A `
          + `(${g === null ? 'Vorgabe — Gerät hat keine Grenzen gemeldet' : 'vom Gerät gemeldet'}).`,
      );
    });
    void wallbox.steuerfunktionen().then((f) => {
      console.log(
        f.length === 0
          ? '[Laderegelung] Steuerfunktionen nicht abrufbar — möglicherweise hat das '
              + 'Cloud-Projekt nur Leserechte.'
          : `[Laderegelung] Steuerbar laut Gerät: ${f.map((x) => x.code).join(', ')}`,
      );
    });

    this.naechsteRegelungAt = Date.now() + intervallMs;
    this.timer = setInterval(() => void this.zyklus(), intervallMs);
    this.timer.unref();
    // Sofort abgleichen, nicht erst in 30 s: Nach einem Neustart weiss niemand,
    // was die Wallbox gerade tut. Ohne Messwerte kehrt der Zyklus still zurück.
    void this.zyklus();

    // Schnellpfad am Messtakt der Engine: Zieht eine Wolke vor die Sonne, wird
    // sofort gesenkt statt erst im nächsten Zyklus.
    this.abmelden = this.engine.subscribe((state) => this.beimMesstakt(state));
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.abmelden?.();
    this.abmelden = null;
  }

  /**
   * Geordnetes Herunterfahren.
   *
   * Im intelligenten Betrieb wird ein Stopp gesendet, falls die Wallbox
   * freigegeben ist: Ohne laufenden Regler kann niemand mehr senken, und das
   * Auto lüde aus dem Netz weiter. Im Handbetrieb hat der Mensch Netzbezug
   * ausdrücklich erlaubt — da bleibt alles, wie es ist.
   */
  async beimHerunterfahren(): Promise<void> {
    this.stop();
    if (this.befehle === null || this.config.ueberschuss.modus !== 'regeln') return;
    if (this.betriebsart !== 'intelligent') return;
    const freigegeben = this.befehle.ladenAn === true || this.historie.gesetztA > 0;
    if (!freigegeben) return;
    console.log('[Laderegelung] Herunterfahren — Wallbox wird abgeschaltet, damit ohne Regler kein Netzbezug entsteht.');
    this.ereignisse?.notiere('laden.stopp-beim-herunterfahren', 'Wallbox beim Herunterfahren abgeschaltet.');
    const ergebnis = await this.befehle.sende(0);
    if (!ergebnis.ok) {
      console.warn(`[Laderegelung] Stopp beim Herunterfahren fehlgeschlagen: ${ergebnis.fehler}`);
    }
  }

  // ── Bedienung ─────────────────────────────────────────────────────────

  setzeBetriebsart(art: Betriebsart, ampere?: number): void {
    const anfang =
      ampere
      ?? (this.manuellA >= this.grenzen.minA
        ? this.manuellA
        : this.historie.gesetztA >= this.grenzen.minA
          ? this.historie.gesetztA
          : (this.geraeteStromA ?? this.grenzen.minA));
    const gewuenschtA =
      art === 'manuell'
        ? Math.min(this.grenzen.maxA, Math.max(this.grenzen.minA, Math.round(anfang)))
        : this.manuellA;
    if (this.betriebsart === art && gewuenschtA === this.manuellA) return;
    this.speichereWahl({ betriebsart: art, manuellA: gewuenschtA });
    this.betriebsart = art;
    this.manuellA = gewuenschtA;
    this.fahrzeug.fordertNicht = false;
    this.fahrzeug.angeboteOhneLadung = 0;
    this.fahrzeug.naechsterVersuchAt = 0;
    console.log(
      art === 'intelligent'
        ? '[Laderegelung] Intelligentes Laden — nur, was Sonne und Speicher hergeben.'
        : `[Laderegelung] Handbetrieb mit ${gewuenschtA} A — feste Vorgabe, auch aus dem Netz.`,
    );
    this.ereignisse?.notiere(
      'laden.betriebsart',
      art === 'intelligent' ? 'Betriebsart: intelligent' : `Betriebsart: manuell, ${gewuenschtA} A`,
    );
    this.melde();
    if (this.laeuft) this.erneutRegeln = true;
    void this.zyklus();
  }

  setzeGestoppt(an: boolean): void {
    if (this.gestoppt === an) return;
    if (this.betriebsart !== null) this.speichereWahl({ pausiert: an });
    this.gestoppt = an;
    this.melde();
    if (this.laeuft) this.erneutRegeln = true;
    console.log(an ? '[Laderegelung] Laden pausiert.' : '[Laderegelung] Laden fortgesetzt.');
    this.ereignisse?.notiere('laden.stopp', an ? 'Laden vom Benutzer gestoppt.' : 'Laden vom Benutzer fortgesetzt.');
    void this.zyklus();
  }

  /** Alte Schnittstelle: "Volladung" heisst Handbetrieb auf dem Höchstwert. */
  setzeVolladung(an: boolean): void {
    if (an) this.setzeBetriebsart('manuell', this.grenzen.maxA);
    else this.setzeBetriebsart('intelligent');
  }

  abonniere(beobachter: () => void): () => void {
    this.beobachter.add(beobachter);
    return () => this.beobachter.delete(beobachter);
  }

  // ── Auskunft ──────────────────────────────────────────────────────────

  zustand(): Steuerzustand {
    const e = this.letzte;
    return {
      ...this.kurz(),
      aktiv: this.timer !== null,
      zielLeistungW: e?.zielLeistungW ?? 0,
      netzW: this.protokoll[this.protokoll.length - 1]?.netzW ?? 0,
      letzterBefehlAt:
        this.befehle?.letzterBefehlAt == null ? null : new Date(this.befehle.letzterBefehlAt).toISOString(),
      naechsteRegelungInS: Math.max(0, Math.round((this.naechsteRegelungAt - Date.now()) / 1000)),
      // Neueste zuerst — so liest man ein Protokoll.
      protokoll: [...this.protokoll].reverse(),
    };
  }

  kurz(): Steuerkurz {
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
      betriebsart: this.betriebsart,
      befehl: this.befehle?.befehl ?? null,
      geraet: this.geraet,
      manuellA: this.manuellA,
      minA: this.grenzen.minA,
      maxA: this.grenzen.maxA,
      volladung: this.betriebsart === 'manuell' && this.manuellA >= this.grenzen.maxA,
      anschluss: this.anschlussInfo(),
      fordertNicht: this.fahrzeug.fordertNicht,
      gestoppt: this.gestoppt,
      letzterFehler: this.befehle?.letzterFehler ?? null,
      haushaltMaxA: this.config.ueberschuss.haushaltMaxA,
    };
  }

  // ── Messtakt (alle 2 s) ───────────────────────────────────────────────

  private beimMesstakt(state: EngineState): void {
    const snap = state.resolution.snapshot;
    const speicher = this.speicherzustand(state);
    const netzbezug = snap.gridImportW.valueW ?? 0;
    const evLeistung = snap.evCharger?.chargePowerW ?? 0;
    const jetzt = Date.now();

    // Zusehen und lernen, in jeder Betriebsart.
    this.gedaechtnis = merkeEntladung(this.gedaechtnis, speicher, jetzt);
    this.merkeNachfrage(evLeistung, snap.evCharger?.vehicleConnected ?? null,
      snap.evCharger !== null && snap.evCharger.state !== 'offline');
    this.merkeGeraet(snap.evCharger);

    if (this.config.ueberschuss.modus !== 'regeln' || this.laeuft) return;
    if (evLeistung <= LADEN_AB_W) return;
    if (netzbezug <= this.config.ueberschuss.notbremseAbW) return;
    if (jetzt - this.letzteSchnellpruefungAt < SCHNELLPRUEFUNG_ABSTAND_MS) return;

    // Netzbezug, obwohl mit Speicherleistung gerechnet wurde: Die Annahme war
    // zu gross. Vor dem Nachregeln den Nachweis zurücknehmen.
    if (this.mitSpeicherGerechnet) {
      this.gedaechtnis = nachweisZuruecknehmen(this.gedaechtnis, speicher, jetzt);
    }
    this.letzteSchnellpruefungAt = jetzt;
    void this.zyklus();
  }

  /**
   * Mitschreiben, ob das Fahrzeug die Freigabe annimmt. Zwei Beweise setzen
   * alle Zweifel zurück: Es fliesst Strom, oder es wurde abgesteckt.
   */
  private merkeNachfrage(leistungW: number, angesteckt: boolean | null, erreichbar: boolean): void {
    const f = this.fahrzeug;
    // Nur eine erreichbare Wallbox kann ein Abstecken bezeugen.
    const abgesteckt = erreichbar && angesteckt === false;
    if (abgesteckt && f.warAngesteckt === true && this.laeuft) this.erneutRegeln = true;
    if (erreichbar && angesteckt !== null) {
      if (f.warAngesteckt !== angesteckt && f.warAngesteckt !== null) {
        this.ereignisse?.notiere('fahrzeug.' + (angesteckt ? 'angesteckt' : 'abgesteckt'),
          angesteckt ? 'Fahrzeug angesteckt.' : 'Fahrzeug abgesteckt.');
      }
      f.warAngesteckt = angesteckt;
    }
    if (leistungW > LADEN_AB_W) {
      f.angeboteOhneLadung = 0;
      f.fordertNicht = false;
    }
    if (abgesteckt) {
      f.angeboteOhneLadung = 0;
      f.fordertNicht = false;
      f.naechsterVersuchAt = 0;
      // Beim nächsten Mal kann eine andere Dose dran sein.
      f.hoechsteLadeleistungW = 0;
      // Die Pause gilt für diesen Steckvorgang. Betriebsart bleibt.
      if (this.gestoppt) {
        this.gestoppt = false;
        this.speichereWahl();
        this.melde();
      }
    }
  }

  /** Gerätesicht fortschreiben und einen ausstehenden Befehl ggf. bestätigen. */
  private merkeGeraet(ev: EngineState['resolution']['snapshot']['evCharger']): void {
    const erreichbar = ev !== null && ev.state !== 'offline';
    const vorher = this.geraet?.erreichbar ?? null;
    this.geraet = {
      erreichbar,
      angesteckt: erreichbar ? ev.vehicleConnected : null,
      schalterAn: erreichbar ? ev.schalterAn : null,
      stromA: erreichbar ? ev.maxCurrentA : null,
      leistungW: erreichbar ? ev.chargePowerW : null,
      alterMs: ev !== null && Number.isFinite(ev.provenance.ageMs) ? ev.provenance.ageMs : null,
    };
    if (vorher !== null && vorher !== erreichbar) {
      this.ereignisse?.notiere('wallbox.' + (erreichbar ? 'erreichbar' : 'offline'),
        erreichbar ? 'Wallbox wieder erreichbar.' : 'Wallbox nicht erreichbar.');
    }
    if (this.befehle?.bestaetigeAus(ev)) this.melde();
  }

  // ── Regelzyklus ───────────────────────────────────────────────────────

  private async zyklus(): Promise<void> {
    // Ein hängender Cloud-Aufruf darf nicht dazu führen, dass sich Zyklen
    // überholen und zwei Befehle gleichzeitig unterwegs sind.
    if (this.laeuft) return;
    this.laeuft = true;
    this.naechsteRegelungAt = Date.now() + this.config.ueberschuss.intervallSekunden * 1000;

    try {
      const state = this.engine.current();
      if (state === null || this.befehle === null) return;

      const messwerte = this.messwerte(state);
      if (messwerte.evStromA !== null) this.geraeteStromA = messwerte.evStromA;
      this.mitSpeicherGerechnet =
        speicherspielraum(messwerte.speicher, this.parameter()).entladespielraumW > 0;

      // Beim ersten Zyklus weiss die Regelung nicht, was an der Wallbox
      // eingestellt ist — UNBEKANNT ist die einzige ehrliche Aussage, und sie
      // sorgt dafür, dass der erste Zyklus in jedem Fall einen Befehl schickt.
      if (!this.initialisiert) {
        this.initialisiert = true;
        this.historie = neueHistorie(UNBEKANNT_A, Date.now());
      }

      const laedtWirklich = (messwerte.evLeistungW ?? 0) > LADEN_AB_W;
      this.merkeNachfrage(messwerte.evLeistungW ?? 0, messwerte.evAngesteckt, messwerte.wallboxErreichbar);
      this.merkeGeraet(state.resolution.snapshot.evCharger);
      this.erkenneDose(messwerte, laedtWirklich);
      this.gleicheMitWirklichkeitAb(messwerte, laedtWirklich);
      this.pruefeFahrzeugnachfrage();

      const { entscheidung, sofort, regelbar } = uebersteuere(
        berechneLadeziel(messwerte, this.parameter()),
        messwerte,
        this.wahl(),
        this.dosengrenzen(),
      );
      this.letzte = entscheidung;
      const netzW = (messwerte.netzbezugW ?? 0) - (messwerte.netzeinspeisungW ?? 0);

      if (!regelbar) {
        this.notiere(messwerte, entscheidung, netzW, false, entscheidung.grund, null);
        return;
      }

      // Beruhigung nur im Autarkbetrieb — nicht, um einen Menschen warten zu lassen.
      const ergebnis = sofort
        ? sofortBefehl(entscheidung.zielA, this.historie, Date.now())
        : beruhige({
            wunschA: entscheidung.zielA,
            netzbezugW: messwerte.netzbezugW ?? 0,
            jetztMs: Date.now(),
            historie: this.historie,
            zeit: this.zeitparameter(),
          });

      // Beobachten: rechnen, protokollieren, aber nichts senden. `gesetztA`
      // bleibt unangetastet — ein nie abgeschickter Sollwert ist keiner.
      if (this.config.ueberschuss.modus !== 'regeln') {
        this.historie = { ...ergebnis.historie, gesetztA: this.historie.gesetztA };
        this.notiere(messwerte, entscheidung, netzW, false,
          ergebnis.senden ? `${ergebnis.grund} (nur beobachtet)` : ergebnis.grund, null);
        return;
      }

      if (!ergebnis.senden) {
        this.historie = ergebnis.historie;
        this.notiere(messwerte, entscheidung, netzW, false, ergebnis.grund, null);
        return;
      }

      if (this.befehle.gesperrt(ergebnis.stromA)) {
        this.notiere(messwerte, entscheidung, netzW, false,
          `${ergebnis.grund} — wartet nach Fehler.`, this.befehle.letzterFehler);
        return;
      }

      const gesendet = await this.befehle.sende(ergebnis.stromA, () => this.erneutRegeln);
      if (!gesendet.ok) {
        // Historie NICHT fortschreiben: Der Sollwert gilt erst als gesetzt,
        // wenn die Wallbox ihn angenommen hat.
        this.ereignisse?.notiere('laden.befehl-fehlgeschlagen',
          `Befehl ${ergebnis.stromA === 0 ? 'Abschalten' : `${ergebnis.stromA} A`} fehlgeschlagen: ${gesendet.fehler}`);
        this.notiere(messwerte, entscheidung, netzW, false, ergebnis.grund, gesendet.fehler);
        return;
      }
      if ('abgebrochen' in gesendet) {
        this.historie = { ...this.historie, gesetztA: UNBEKANNT_A };
        return;
      }
      // Jede Freigabe zählt, bis wirklich Strom fliesst.
      if (gesendet.eingeschaltet) this.fahrzeug.angeboteOhneLadung += 1;
      this.historie = { ...ergebnis.historie, gesetztA: ergebnis.stromA };
      this.ereignisse?.notiere('laden.befehl',
        gesendet.gesetztA === 0 ? 'Wallbox abgeschaltet.' : `Ladestrom auf ${gesendet.gesetztA} A gesetzt.`,
        { zustand: entscheidung.zustand, grund: ergebnis.grund });
      this.notiere(messwerte, entscheidung, netzW, true,
        `${ergebnis.grund} Gesendet: ${gesendet.gesetztA === 0 ? 'Ladung abgeschaltet' : `${gesendet.gesetztA} A`}.`,
        null);
    } catch (error) {
      // Sicherheitsnetz: Der Dienst läuft rund um die Uhr und darf an keinem
      // unerwarteten Fehler sterben.
      console.warn('[Laderegelung] Zyklus übersprungen:', error instanceof Error ? error.message : error);
    } finally {
      this.laeuft = false;
      this.melde();
      if (this.erneutRegeln) {
        this.erneutRegeln = false;
        await this.zyklus();
      }
    }
  }

  /**
   * An welcher Dose hängt das Auto? Erste Wahl ist die Messung (`phase_a`),
   * sonst die Herleitung aus Leistung und eingestelltem Strom — nur solange
   * wirklich Strom fliesst.
   */
  private erkenneDose(messwerte: Messwerte, laedtWirklich: boolean): void {
    const f = this.fahrzeug;
    if (laedtWirklich) {
      f.hoechsteLadeleistungW = Math.max(f.hoechsteLadeleistungW, messwerte.evLeistungW ?? 0);
    }
    const erkannt =
      anschlussAusPhasenmessung(messwerte.evSpannungV, messwerte.evPhasen)
        ?? (laedtWirklich
          ? gemessenerAnschluss(messwerte.evLeistungW, messwerte.evStromA, this.anschluss, f.hoechsteLadeleistungW)
          : this.anschluss);
    if (erkannt.phasen !== this.anschluss.phasen) {
      if (this.datenverzeichnis !== null) {
        merkeDose(this.datenverzeichnis, {
          phasen: erkannt.phasen,
          spannungV: erkannt.spannungV,
          erkanntAm: new Date().toISOString(),
        });
      }
      console.log(
        `[Laderegelung] Anschluss erkannt: ${anschlussName(erkannt)} `
          + `(${Math.round(erkannt.spannungV)} V, ${erkannt.phasen === 3 ? 'dreiphasig' : 'einphasig'}). `
          + `Ein Ampere sind hier ${Math.round(ladeleistungAusStromW(1, erkannt) ?? 0)} W.`,
      );
      this.ereignisse?.notiere('wallbox.dose', `Anschluss erkannt: ${anschlussName(erkannt)}.`);
    }
    this.anschluss = erkannt;
  }

  /**
   * Der wichtigste Sicherheitsnetz-Griff: Es entscheidet der Messwert, nicht
   * die Erinnerung — in beide Richtungen.
   *
   * Fliesst Strom, obwohl wir pausiert zu haben glauben (neu angesteckt,
   * eigener Zeitplan, verlorener Befehl), wird das Gedächtnis verworfen und der
   * Stopp erneut geschickt. Ist das Gerät aus, obwohl ein Strom gesetzt sein
   * sollte, wird das Gedächtnis auf "pausiert" gestellt und der Startweg läuft
   * von vorn. Der Abstand zum letzten Befehl muss sein: Direkt nach dem
   * Einschalten meldet die Cloud den alten Schalterzustand noch eine Weile.
   */
  private gleicheMitWirklichkeitAb(messwerte: Messwerte, laedtWirklich: boolean): void {
    if (this.befehle === null) return;
    if (laedtWirklich && this.historie.gesetztA === 0) {
      console.warn(
        `[Laderegelung] Die Wallbox lädt mit ${Math.round(messwerte.evLeistungW ?? 0)} W, `
          + 'obwohl sie abgeschaltet sein sollte — Stopp wird erneut gesendet.',
      );
      this.ereignisse?.notiere('laden.abweichung', 'Wallbox lädt, obwohl abgeschaltet — Stopp wird wiederholt.');
      this.historie = { ...this.historie, gesetztA: messwerte.evStromA ?? UNBEKANNT_A };
      this.befehle.ladenAn = null;
    }
    const schalterAusMs = Date.now() - (this.befehle.letzterBefehlAt ?? 0);
    if (
      messwerte.evSchalterAn === false
      && this.historie.gesetztA > 0
      && schalterAusMs > this.config.ueberschuss.intervallSekunden * 1000
    ) {
      console.warn(
        `[Laderegelung] Wallbox ist abgeschaltet, obwohl ${this.historie.gesetztA} A `
          + 'gesetzt sein sollten — wird neu gestartet.',
      );
      this.ereignisse?.notiere('laden.abweichung', 'Wallbox ist aus, obwohl Strom gesetzt sein sollte — Neustart.');
      this.historie = { ...this.historie, gesetztA: 0 };
      this.befehle.ladenAn = false;
    }
  }

  /** Nach drei Freigaben ohne ein einziges Ampere gilt: voll oder Ladegrenze. */
  private pruefeFahrzeugnachfrage(): void {
    const f = this.fahrzeug;
    if (f.angeboteOhneLadung >= VERSUCHE_BIS_AUFGABE && !f.fordertNicht) {
      f.fordertNicht = true;
      f.naechsterVersuchAt = Date.now() + NEUER_VERSUCH_MS;
      console.log(
        `[Laderegelung] Fahrzeug hat ${VERSUCHE_BIS_AUFGABE} Freigaben nicht angenommen — `
          + `vermutlich voll. Laden wird beendet, neuer Versuch in ${Math.round(NEUER_VERSUCH_MS / 60_000)} Minuten.`,
      );
      this.ereignisse?.notiere('fahrzeug.fordert-nicht', 'Fahrzeug nimmt keinen Strom an — Laden beendet, neuer Versuch später.');
    }
    if (f.fordertNicht && Date.now() >= f.naechsterVersuchAt) {
      f.fordertNicht = false;
      f.angeboteOhneLadung = 0;
    }
  }

  // ── Hilfen ────────────────────────────────────────────────────────────

  private wahl(): Reglerwahl {
    return {
      betriebsart: this.betriebsart,
      manuellA: this.manuellA,
      gestoppt: this.gestoppt,
      fordertNicht: this.fahrzeug.fordertNicht,
    };
  }

  private dosengrenzen(): Dosengrenzen {
    return {
      minA: this.grenzen.minA,
      maxA: this.grenzen.maxA,
      anschluss: this.anschluss,
      haushaltMaxA: this.config.ueberschuss.haushaltMaxA,
    };
  }

  private anschlussInfo(): Anschlussinfo {
    return {
      phasen: this.anschluss.phasen,
      spannungV: Math.round(this.anschluss.spannungV),
      name: anschlussName(this.anschluss),
      wattProAmpere: Math.round(ladeleistungAusStromW(1, this.anschluss) ?? 0),
    };
  }

  private speichereWahl(
    aenderung: Partial<{ betriebsart: Betriebsart; manuellA: number; pausiert: boolean }> = {},
  ): void {
    if (this.datenverzeichnis === null) return;
    const betriebsart = aenderung.betriebsart ?? this.betriebsart;
    if (betriebsart === null) return;
    try {
      merkeLademodus(this.datenverzeichnis, {
        betriebsart,
        manuellA: aenderung.manuellA ?? this.manuellA,
        pausiert: aenderung.pausiert ?? this.gestoppt,
        geaendertAm: new Date().toISOString(),
      });
    } catch (error) {
      throw new Error(
        `Lade-Einstellung konnte nicht gespeichert werden: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Beobachter benachrichtigen — aber nur, wenn sich für sie etwas geändert
   * hat. Der Zyklus ruft nach jedem Durchlauf hierher; ohne diesen Vergleich
   * ginge alle 30 s ein voller Zustand über den Ereignisstrom, auch wenn
   * nichts passiert ist.
   */
  private melde(): void {
    const { geraet, ...rest } = this.kurz();
    // Das Alter der Ger�temeldung tickt bei jeder Messung � es z�hlt hier nicht.
    const jetzt = JSON.stringify({ ...rest, geraet: geraet === null ? null : { ...geraet, alterMs: null } });
    if (jetzt === this.letzteMeldung) return;
    this.letzteMeldung = jetzt;
    for (const b of this.beobachter) {
      try { b(); } catch { /* ein toter Empfänger stört die übrigen nicht */ }
    }
  }

  private parameter(): Reglerparameter {
    const u = this.config.ueberschuss;
    return {
      anschluss: this.anschluss,
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
      senkenBeiBezugNachMs: u.senkenBeiBezugSekunden * 1000,
      pausierenNachMs: u.pausierenNachSekunden * 1000,
      startenNachMs: u.startenNachSekunden * 1000,
      notbremseAbW: u.notbremseAbW,
      netzTotzoneW: u.netzTotzoneW,
      netzImportTotzoneW: u.netzImportTotzoneW,
    };
  }

  /** Die Speicher, wie die Regelung sie sieht — samt Nachweis. */
  private speicherzustand(state: EngineState): SpeicherZustand[] {
    return state.resolution.snapshot.batteries.map((b) => {
      const frisch = b.provenance.quality === 'live'
        && b.provenance.ageMs + Math.max(0, Date.now() - state.polledAt.getTime())
          <= this.config.ueberschuss.maxMessalterSekunden * 1000;
      return {
        id: b.deviceId,
        name: b.displayName,
        socPercent: frisch ? b.socPercent : null,
        ladenW: frisch ? b.chargeW : null,
        entladenW: frisch ? b.dischargeW : null,
        bewaehrtEntladenW: bewaehrtW(this.gedaechtnis, b.deviceId),
      };
    });
  }

  /**
   * Messwerte aus dem Zustand der Engine. `hausMitAutoW` wird hier bewusst
   * NICHT um das Auto bereinigt — das macht `berechneLadeziel` selbst.
   */
  private messwerte(state: EngineState): Messwerte {
    const snap = state.resolution.snapshot;
    const ev = snap.evCharger;
    const speicher = this.speicherzustand(state);

    // Das Alter der Wallbox zählt nur mit, solange tatsächlich Strom fliesst:
    // Tuya meldet nur bei Wertänderung, ein "0 W" im Ruhezustand ist alt und
    // trotzdem richtig.
    const wallboxLaeuft = (ev?.chargePowerW ?? 0) > LADEN_AB_W;
    const benoetigt = [
      snap.gridImportW.provenance, snap.gridExportW.provenance,
      snap.solarProductionW.provenance, snap.houseConsumptionW.provenance,
      ...snap.batteries.map((b) => b.provenance),
      ...(wallboxLaeuft && ev ? [ev.provenance] : []),
    ];
    const seitPollMs = Math.max(0, Date.now() - state.polledAt.getTime());
    const unbrauchbar = state.resolution.unavailable.length > 0
      || benoetigt.some((p) => p.quality !== 'live' || !Number.isFinite(p.ageMs));
    const messalterMs = unbrauchbar ? Number.POSITIVE_INFINITY
      : Math.max(...benoetigt.map((p) => p.ageMs)) + seitPollMs;

    return {
      pvW: snap.solarProductionW.valueW,
      hausMitAutoW: snap.houseConsumptionW.valueW,
      netzbezugW: snap.gridImportW.valueW,
      netzeinspeisungW: snap.gridExportW.valueW,
      evLeistungW: ev?.chargePowerW ?? null,
      evAngesteckt: ev?.vehicleConnected ?? null,
      evStromA: ev?.maxCurrentA ?? null,
      evSchalterAn: ev?.schalterAn ?? null,
      evSpannungV: ev?.spannungV ?? null,
      evPhasen: ev?.phasen ?? null,
      speicher,
      messalterMs,
      wallboxErreichbar: ev !== null && ev.state !== 'offline',
      ...(ev?.state === 'finished' ? { ladungBeendet: true } : {}),
    };
  }

  /** Schreibt einen Schritt ins Protokoll; auf die Konsole nur Änderungen. */
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
      if (entscheidung.zustand !== this.letzterZustand) {
        this.ereignisse?.notiere('laden.zustand', `${entscheidung.zustand}: ${grund}`);
      }
      this.letzterZustand = entscheidung.zustand;
    }
  }
}

// Für Aufrufer, die nur die Grenzlogik brauchen (z. B. Oberflächen-Vorschau).
export { begrenzeAufDose };
