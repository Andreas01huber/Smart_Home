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
 * Drei Modi, umschaltbar in config.json:
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
 * ── Zwei Betriebsarten für den Menschen ────────────────────────────────────
 * Davon zu trennen ist, was der Benutzer wählt: `intelligent` lädt nur aus
 * eigener Erzeugung, `manuell` mit einem festen Ladestrom, notfalls aus dem
 * Netz. Der Handbetrieb ist kein Schlupfloch in der Autarkieregel, sondern eine
 * ausdrückliche Entscheidung — er wird deutlich angezeigt und endet von selbst,
 * sobald das Fahrzeug abgesteckt wird oder der Server neu startet.
 */

import {
  anschlussName,
  berechneLadeziel,
  beruhige,
  bewaehrtW,
  gedaechtnisAusMesswerten,
  gemessenerAnschluss,
  ladeleistungAusStromW,
  LEERES_GEDAECHTNIS,
  merkeEntladung,
  nachweisZuruecknehmen,
  neueHistorie,
  speicherspielraum,
  type Ladeanschluss,
  type Ladeentscheidung,
  type Ladezustand,
  type Messwerte,
  type Reglerhistorie,
  type Reglerparameter,
  type Speichergedaechtnis,
  type SpeicherZustand,
  type Zeitparameter,
} from '@energy/core';
import type { TuyaEvseConnector } from '@energy/connectors';

import { ladeanschlussAus, type AppConfig } from './config.ts';
import type { EnergyEngine, EngineState } from './engine.ts';

/**
 * Wie geladen wird — die Entscheidung des Menschen, nicht der Regelung.
 *
 * `intelligent`  Nur, was Sonne und freigegebene Speicherleistung hergeben.
 *                Die Vorgabe, und der einzige Zustand, in dem die Regel "das
 *                Auto verursacht keinen Netzbezug" gilt.
 * `manuell`      Ein fester Ladestrom, den ein Mensch eingestellt hat. Reicht
 *                die eigene Erzeugung nicht, kommt der Rest aus dem Netz.
 *
 * Eine eigene Art "Volladung" gab es einmal und ist entfallen: Sie war nichts
 * anderes als Handbetrieb auf dem Höchstwert. Ein Knopf weniger, der dasselbe
 * kann wie der Schieberegler ganz rechts.
 */
export type Betriebsart = 'intelligent' | 'manuell';

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
  /** Gewaehlte Betriebsart — die Entscheidung des Menschen. */
  readonly betriebsart: Betriebsart;
  /** Eingestellter Ladestrom im Handbetrieb, in Ampere. */
  readonly manuellA: number;
  /** Nur noch für ältere Oberflächen: Handbetrieb auf dem Höchstwert. */
  readonly volladung: boolean;
  /** Wie das Auto angesteckt ist — erkannt, nicht konfiguriert. */
  readonly anschluss: Anschlussinfo;
  /** Angesteckt, fordert aber keinen Strom mehr (voll oder eigene Grenze). */
  readonly fordertNicht: boolean;
  /** Vom Menschen angehalten. */
  readonly gestoppt: boolean;
  /** Höchster Ladestrom an einer Haushaltssteckdose. */
  readonly haushaltMaxA: number;
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
 * So oft wird eingeschaltet, bevor die Regelung aufgibt.
 *
 * Ein Fahrzeug braucht nach dem Einschalten ein paar Sekunden, bis es Strom
 * zieht — der erste Versuch beweist also nichts. Drei Versuche hintereinander
 * ohne einen einzigen Ampere sind dagegen eindeutig: Der Akku ist voll, oder
 * die im Auto eingestellte Ladegrenze ist erreicht.
 */
const VERSUCHE_BIS_AUFGABE = 3;

/**
 * Danach wird es noch einmal versucht.
 *
 * Nicht endgültig aufgeben: Ein Fahrzeug kann seine Meinung ändern — eine
 * Abfahrtszeit rückt näher, die Klimatisierung springt an, der Ladestand fällt
 * wieder unter die Grenze. Eine halbe Stunde ist selten genug, um die Wallbox
 * in Ruhe zu lassen, und oft genug, um es nicht zu verpassen.
 */
const NEUER_VERSUCH_MS = 30 * 60_000;

/**
 * Ein Befehl ohne Beobachtungszeit — für Vorgaben von Hand.
 *
 * Gleiche Form wie das Ergebnis der Beruhigung, damit der Zyklus dahinter
 * nichts unterscheiden muss. Gesendet wird nur, wenn sich wirklich etwas
 * ändert; sonst liefe bei jedem Zyklus ein Tuya-Befehl hinaus.
 */
function sofort(
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
  /** Gewählte Betriebsart. Vorgabe ist `intelligent` — siehe `setzeBetriebsart`. */
  private betriebsart: Betriebsart = 'intelligent';
  /** Ladestrom im Handbetrieb. Erst gültig, wenn `betriebsart === 'manuell'`. */
  private manuellA = 0;
  /**
   * Wie das Auto angesteckt ist — aus der Messung erkannt, nicht konfiguriert.
   *
   * Startet mit dem Wert aus config.json und wird korrigiert, sobald eine
   * Messung eine andere Dose beweist. Bleibt danach stehen: Wenn das Fahrzeug
   * gerade nichts zieht, gibt es nichts zu messen, und die zuletzt erkannte
   * Dose ist immer noch die richtige Auskunft.
   */
  private anschluss: Ladeanschluss;
  /**
   * Fahrzeug ist angesteckt, will aber nicht laden.
   *
   * Das kommt vor, wenn der Akku voll ist oder die im Auto eingestellte
   * Ladegrenze erreicht wurde. Ohne diese Erkennung böte die Regelung endlos
   * weiter an, die Wallbox liesse den Schuetz jedes Mal nach einer Minute
   * wieder fallen, und in der App stünde die ganze Zeit "lädt".
   */
  private fordertNicht = false;
  /** Wie oft hintereinander eingeschaltet wurde, ohne dass Strom floss. */
  private angeboteOhneLadung = 0;
  /**
   * Höchste je gemessene Ladeleistung an diesem Anschluss.
   *
   * Der Beweis gegen eine Fehlerkennung: Was einmal geflossen ist, kann eine
   * Haushaltssteckdose nicht hergeben, wenn es über ihrer Grenze lag. Wird beim
   * Abstecken zurückgesetzt — danach kann eine andere Dose dran sein.
   */
  private hoechsteLadeleistungW = 0;
  /**
   * Vom Menschen angehaltenes Laden.
   *
   * Eigener Zustand und keine Betriebsart: Wer "Laden beenden" drückt, will
   * genau das — und beim Fortsetzen dieselbe Betriebsart zurück, nicht die
   * Vorgabe. Endet beim Abstecken.
   */
  private gestoppt = false;
  /** Wann der nächste Versuch frühestens erlaubt ist, nachdem aufgegeben wurde. */
  private naechsterVersuchAt = 0;
  /** Zuletzt an die Wallbox gesendeter Schalterzustand; null = unbekannt. */
  private ladenAn: boolean | null = null;
  /** Ob der Startwert schon aus dem Gerät übernommen wurde. */
  private initialisiert = false;
  private letzteSchnellpruefungAt = 0;
  private abmelden: (() => void) | null = null;
  /**
   * Was die Speicher nachweislich liefern.
   *
   * Wächst bei jedem Messtakt mit dem, was wirklich fliesst, und schrumpft,
   * sobald trotz eingeplanter Speicherleistung Netzbezug auftritt. Ohne dieses
   * Gedächtnis müsste die Regelung der Konfiguration glauben — und die kann
   * keine Anlage kennen.
   */
  private gedaechtnis: Speichergedaechtnis = LEERES_GEDAECHTNIS;
  /** Wurde im letzten Zyklus mit ungenutzter Speicherleistung gerechnet? */
  private mitSpeicherGerechnet = false;
  /**
   * Was an der Wallbox zuletzt eingestellt war, laut Geraet.
   *
   * Gebraucht beim Wechsel in den Handbetrieb: Die eigene Historie kennt nur,
   * was DIESE Regelung gesendet hat — im Beobachtungsmodus also nichts. Das
   * Geraet weiss es besser.
   */
  private geraeteStromA: number | null = null;

  constructor(
    private readonly engine: EnergyEngine,
    private readonly wallbox: TuyaEvseConnector | null,
    private readonly config: AppConfig,
  ) {
    this.anschluss = ladeanschlussAus(config);
  }

  /**
   * Mitschreiben, ob das Fahrzeug die Freigabe annimmt.
   *
   * Zwei Beweise setzen alle Zweifel zurück: Es fliesst Strom (dann will es
   * offensichtlich), oder es wurde abgesteckt (dann fängt beim nächsten Mal
   * alles von vorn an). Wird aus dem Messtakt UND aus dem Regelzyklus
   * aufgerufen — der Messtakt ist schneller, der Zyklus läuft auch dann, wenn
   * der Dienst ohne laufenden Messtakt getaktet wird.
   */
  private merkeNachfrage(leistungW: number, angesteckt: boolean | null): void {
    if (leistungW > LAEDT_AB_W) {
      this.angeboteOhneLadung = 0;
      this.fordertNicht = false;
    }
    if (angesteckt === false) {
      this.angeboteOhneLadung = 0;
      this.fordertNicht = false;
      this.naechsterVersuchAt = 0;
      // Beim nächsten Mal kann eine andere Dose dran sein — und ein von Hand
      // beendetes Laden soll nicht stillschweigend weitergelten.
      this.hoechsteLadeleistungW = 0;
      this.gestoppt = false;
    }
  }

  /**
   * Den Ladestrom auf das begrenzen, was die erkannte Dose verträgt.
   *
   * An der Starkstromdose sind es die Grenzen des Geräts, sonst nichts. An der
   * Haushaltssteckdose kommt eine dazu, und die ist kein Software-Detail: Eine
   * Schuko-Steckdose ist zwar mit 16 A gekennzeichnet, aber für 16 A im
   * DAUERBETRIEB nicht gebaut. Stundenlang 3,7 kW über Kontakte, die dafür
   * nicht ausgelegt sind, ist die klassische Ursache für geschmolzene Dosen —
   * Ladeziegel, die einer Haushaltsdose beiliegen, begrenzen aus genau diesem
   * Grund auf 8 bis 10 A.
   *
   * Deshalb gilt hier eine eigene Obergrenze, und zwar auch im Handbetrieb: Die
   * Regel dieser Anlage lautet, dass die Software nie über das hinausgeht, was
   * die Elektroinstallation zulässt. Wer es anders will, ändert
   * `haushaltMaxA` in config.json — bewusst und an einer Stelle, nicht mit
   * einem Fingertipp auf dem Handy.
   */
  private begrenzeAufDose(ampere: number): number {
    const geraet = Math.min(this.grenzen.maxA, Math.max(this.grenzen.minA, Math.round(ampere)));
    if (this.anschluss.phasen !== 1) return geraet;
    return Math.min(geraet, this.config.ueberschuss.haushaltMaxA);
  }

  /** Der erkannte Anschluss, aufbereitet für die Oberfläche. */
  private anschlussInfo(): Anschlussinfo {
    return {
      phasen: this.anschluss.phasen,
      spannungV: Math.round(this.anschluss.spannungV),
      name: anschlussName(this.anschluss),
      wattProAmpere: Math.round(ladeleistungAusStromW(1, this.anschluss) ?? 0),
    };
  }

  /**
   * Erfahrung aus aufgezeichneten Messwerten übernehmen.
   *
   * Vor `start()` aufzurufen. Ohne diesen Schritt fängt die Regelung nach jedem
   * Neustart bei null Wissen an: Sie wüsste nicht, dass der grosse Speicher
   * 4,2 kW und der kleine 4,6 kW liefern kann, würde beide nicht einplanen und
   * einen halben Sonnentag zu wenig laden — bis das Haus zufällig genug Last
   * macht, dass die Speicher es von selbst beweisen.
   */
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
      const snap = state.resolution.snapshot;
      const speicher = this.speicherzustand(state);
      const netzbezug = snap.gridImportW.valueW ?? 0;
      const evLeistung = snap.evCharger?.chargePowerW ?? 0;
      const jetzt = Date.now();

      // Zusehen und lernen, in jeder Betriebsart. Auch wer nur beobachtet, soll
      // wissen, was seine Speicher können — sonst startet die Regelung beim
      // Umschalten auf "regeln" ohne jede Erfahrung.
      this.gedaechtnis = merkeEntladung(this.gedaechtnis, speicher, jetzt);

      // Im Zwei-Sekunden-Takt mitprüfen, ob das Fahrzeug zugreift. Nur im
      // Regelzyklus zu schauen hiesse, einen kurzen Ladeversuch zwischen zwei
      // Zyklen zu verpassen und zu Unrecht aufzugeben.
      this.merkeNachfrage(
        snap.evCharger?.chargePowerW ?? 0,
        snap.evCharger?.vehicleConnected ?? null,
      );

      if (this.config.ueberschuss.modus !== 'regeln' || this.laeuft) return;
      if (evLeistung <= LAEDT_AB_W) return;
      if (netzbezug <= this.config.ueberschuss.notbremseAbW) return;
      if (jetzt - this.letzteSchnellpruefungAt < SCHNELLPRUEFUNG_ABSTAND_MS) return;

      // Netzbezug, obwohl mit Speicherleistung gerechnet wurde: Die Annahme war
      // zu gross. Vor dem Nachregeln den Nachweis zurücknehmen, sonst rechnet
      // der gleich folgende Zyklus mit derselben zu hohen Zahl noch einmal.
      if (this.mitSpeicherGerechnet) {
        this.gedaechtnis = nachweisZuruecknehmen(this.gedaechtnis, speicher, jetzt);
      }

      this.letzteSchnellpruefungAt = jetzt;
      void this.zyklus();
    });
  }

  /**
   * Betriebsart wählen.
   *
   * `autark` ist die Vorgabe und der einzige Zustand, in dem die Regel dieser
   * Anlage gilt. Die beiden anderen sind ausdrückliche Entscheidungen eines
   * Menschen, Netzstrom zu kaufen — sie werden deshalb auch deutlich angezeigt
   * und enden von selbst, sobald das Fahrzeug abgesteckt wird. Sonst gälten sie
   * stillschweigend für den nächsten Ladevorgang mit.
   *
   * Ein Neustart führt zurück auf `autark`. Das ist Absicht: Die sichere
   * Betriebsart ist der Ruhezustand, nicht die zuletzt gewählte.
   */
  setzeBetriebsart(art: Betriebsart, ampere?: number): void {
    // Ohne Vorgabe übernimmt der Handbetrieb, was gerade eingestellt ist. Wer
    // von der Automatik auf Hand umschaltet, während das Auto mit 14 A lädt,
    // erwartet 14 A und nicht einen Sprung auf den Mindestwert.
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
    this.setzeBetriebsartStill(art, gewuenschtA);
    // Nicht bis zum nächsten Zyklus warten: Wer den Knopf drückt, will es sehen.
    void this.zyklus();
  }

  /** Wie `setzeBetriebsart`, aber ohne sofortigen Zyklus — für Aufrufe von innen. */
  private setzeBetriebsartStill(art: Betriebsart, ampere: number): void {
    this.betriebsart = art;
    this.manuellA = ampere;
    // Wer umschaltet, will es jetzt wissen — nicht in einer halben Stunde.
    this.fordertNicht = false;
    this.angeboteOhneLadung = 0;
    this.naechsterVersuchAt = 0;
    console.log(
      art === 'intelligent'
        ? '[Laderegelung] Intelligentes Laden — nur, was Sonne und Speicher hergeben.'
        : `[Laderegelung] Handbetrieb mit ${ampere} A — feste Vorgabe, auch aus dem Netz.`,
    );
  }

  /**
   * Laden anhalten oder fortsetzen — der Knopf, der alles überstimmt.
   *
   * Anhalten wirkt in jeder Betriebsart: Auch wenn die Sonne scheint und der
   * Handbetrieb 16 A vorgibt, bleibt die Wallbox aus. Beim Fortsetzen gilt
   * wieder die eingestellte Betriebsart — nicht die Vorgabe, denn wer von Hand
   * geladen hat, will nach der Pause wieder von Hand laden.
   *
   * Endet beim Abstecken: Der nächste Ladevorgang soll nicht stillschweigend
   * angehalten sein.
   */
  setzeGestoppt(an: boolean): void {
    if (this.gestoppt === an) return;
    this.gestoppt = an;
    console.log(
      an
        ? '[Laderegelung] Laden von Hand beendet.'
        : '[Laderegelung] Laden von Hand fortgesetzt.',
    );
    // Wer den Knopf drückt, will es sehen und nicht dreissig Sekunden warten.
    void this.zyklus();
  }

  /**
   * Alte Schnittstelle, damit eine noch zwischengespeicherte Oberfläche auf
   * dem Handy nicht ins Leere greift. "Volladung" heisst jetzt Handbetrieb auf
   * dem Höchstwert — gleiches Verhalten, ein Knopf weniger.
   */
  setzeVolladung(an: boolean): void {
    if (an) this.setzeBetriebsart('manuell', this.grenzen.maxA);
    else this.setzeBetriebsart('intelligent');
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
      betriebsart: this.betriebsart,
      manuellA: this.manuellA,
      volladung: this.betriebsart === 'manuell' && this.manuellA >= this.grenzen.maxA,
      anschluss: this.anschlussInfo(),
      fordertNicht: this.fordertNicht,
      gestoppt: this.gestoppt,
      haushaltMaxA: this.config.ueberschuss.haushaltMaxA,
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
    betriebsart: Betriebsart;
    manuellA: number;
    minA: number;
    maxA: number;
    volladung: boolean;
    anschluss: Anschlussinfo;
    fordertNicht: boolean;
    gestoppt: boolean;
    haushaltMaxA: number;
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
      betriebsart: this.betriebsart,
      manuellA: this.manuellA,
      minA: this.grenzen.minA,
      maxA: this.grenzen.maxA,
      volladung: this.betriebsart === 'manuell' && this.manuellA >= this.grenzen.maxA,
      anschluss: this.anschlussInfo(),
      fordertNicht: this.fordertNicht,
      gestoppt: this.gestoppt,
      haushaltMaxA: this.config.ueberschuss.haushaltMaxA,
    };
  }

  // ── intern ──────────────────────────────────────────────────────────────

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

  /**
   * Die Speicher, wie die Regelung sie sieht — samt Nachweis.
   *
   * Eigene Methode, weil der Schnellpfad sie im Zwei-Sekunden-Takt braucht,
   * ohne den ganzen Messwertsatz aufzubauen.
   */
  private speicherzustand(state: EngineState): SpeicherZustand[] {
    return state.resolution.snapshot.batteries.map((b) => ({
      id: b.deviceId,
      name: b.displayName,
      socPercent: b.socPercent,
      ladenW: b.chargeW,
      entladenW: b.dischargeW,
      bewaehrtEntladenW: bewaehrtW(this.gedaechtnis, b.deviceId),
    }));
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

    const speicher = this.speicherzustand(state);

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
      evSchalterAn: ev?.schalterAn ?? null,
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
      if (messwerte.evStromA !== null) this.geraeteStromA = messwerte.evStromA;

      // Merken, ob in diesem Zyklus überhaupt mit ungenutzter Speicherleistung
      // gerechnet wurde. Nur dann darf späterer Netzbezug den Speichern
      // angelastet werden — sonst wäre jede Wolke ein Grund, den Nachweis zu
      // kürzen, den die Speicher sich redlich verdient haben.
      this.mitSpeicherGerechnet =
        speicherspielraum(messwerte.speicher, this.parameter()).entladespielraumW > 0;

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
      this.merkeNachfrage(messwerte.evLeistungW ?? 0, messwerte.evAngesteckt);

      // ── An welcher Dose hängt das Auto? ─────────────────────────────────
      // Aus gesetztem Strom und gemessener Leistung folgt beides: die Art der
      // Dose und ihre tatsächliche Spannung. Nur solange wirklich Strom
      // fliesst — ohne Messung gibt es nichts zu erkennen, und der zuletzt
      // erkannte Anschluss bleibt die richtige Auskunft.
      if (laedtWirklich) {
        this.hoechsteLadeleistungW = Math.max(
          this.hoechsteLadeleistungW,
          messwerte.evLeistungW ?? 0,
        );
        const erkannt = gemessenerAnschluss(
          messwerte.evLeistungW,
          messwerte.evStromA,
          this.anschluss,
          this.hoechsteLadeleistungW,
        );
        if (erkannt.phasen !== this.anschluss.phasen) {
          console.log(
            `[Laderegelung] Anschluss erkannt: ${anschlussName(erkannt)} `
              + `(${Math.round(erkannt.spannungV)} V, ${erkannt.phasen === 3 ? 'dreiphasig' : 'einphasig'}). `
              + `Ein Ampere sind hier ${Math.round(ladeleistungAusStromW(1, erkannt) ?? 0)} W.`,
          );
        }
        this.anschluss = erkannt;
      }

      if (laedtWirklich && this.historie.gesetztA === 0) {
        console.warn(
          `[Laderegelung] Die Wallbox lädt mit ${Math.round(messwerte.evLeistungW ?? 0)} W, `
            + 'obwohl sie abgeschaltet sein sollte — Stopp wird erneut gesendet.',
        );
        this.historie = { ...this.historie, gesetztA: messwerte.evStromA ?? UNBEKANNT_A };
        this.ladenAn = null;
      }

      // Und derselbe Griff in die andere Richtung — die Lücke, die am 8.9. an
      // der Anlage auffiel. Das Gerät stand auf `charge_cur_set 16` bei
      // `switch false`: eingestellt, aber abgeschaltet. Für die Regelung sah
      // das aus wie "16 A sind gesetzt, es gibt nichts zu tun", die Beruhigung
      // meldete brav "Sollwert unverändert" — und weil kein Befehl mehr
      // hinausging, blieb die Wallbox aus, obwohl 11 kW Überschuss dastanden.
      //
      // Ein Ladestrom OHNE Schalter ist kein gesetzter Ladestrom. Deshalb gilt
      // hier wieder der Messwert und nicht die Erinnerung: Ist das Gerät aus,
      // wird das Gedächtnis auf "pausiert" gestellt, und der reguläre Startweg
      // samt seiner Beobachtungszeit läuft von vorn.
      //
      // Der Abstand zum letzten Befehl muss sein: Direkt nach dem Einschalten
      // meldet die Tuya-Cloud den alten Schalterzustand noch eine Weile weiter,
      // und ohne diese Bedingung würde sich die Regelung selbst zurücksetzen.
      const schalterAusMs = Date.now() - (this.letzterBefehlAt ?? 0);
      if (
        messwerte.evSchalterAn === false
        && this.historie.gesetztA > 0
        && schalterAusMs > this.config.ueberschuss.intervallSekunden * 1000
      ) {
        console.warn(
          `[Laderegelung] Wallbox ist abgeschaltet, obwohl ${this.historie.gesetztA} A `
            + 'gesetzt sein sollten — wird neu gestartet.',
        );
        this.historie = { ...this.historie, gesetztA: 0 };
        this.ladenAn = false;
      }

      let entscheidung = berechneLadeziel(messwerte, this.parameter());

      // Handbetrieb endet, sobald das Fahrzeug weg ist — sonst gälte er
      // stillschweigend auch für den nächsten Ladevorgang.
      if (this.betriebsart !== 'intelligent' && messwerte.evAngesteckt === false) {
        this.setzeBetriebsartStill('intelligent', this.manuellA);
      }

      // ── Nimmt das Fahrzeug überhaupt noch? ──────────────────────────────
      // Nach drei Freigaben ohne ein einziges Ampere ist der Fall klar: voll,
      // oder die im Auto eingestellte Ladegrenze ist erreicht. Weiter
      // anzubieten heisst dann nur, dass die Wallbox alle paar Minuten ein
      // Schütz schaltet und in der App "lädt" steht, während nichts fliesst.
      if (this.angeboteOhneLadung >= VERSUCHE_BIS_AUFGABE && !this.fordertNicht) {
        this.fordertNicht = true;
        this.naechsterVersuchAt = Date.now() + NEUER_VERSUCH_MS;
        console.log(
          `[Laderegelung] Fahrzeug hat ${VERSUCHE_BIS_AUFGABE} Freigaben nicht angenommen — `
            + 'vermutlich voll. Laden wird beendet, neuer Versuch in '
            + `${Math.round(NEUER_VERSUCH_MS / 60_000)} Minuten.`,
        );
      }
      // Nach der Wartezeit noch einmal von vorn: Ein Fahrzeug darf seine
      // Meinung ändern.
      if (this.fordertNicht && Date.now() >= this.naechsterVersuchAt) {
        this.fordertNicht = false;
        this.angeboteOhneLadung = 0;
      }
      if (this.fordertNicht && messwerte.evAngesteckt === true) {
        entscheidung = {
          ...entscheidung,
          zustand: 'fordert-nicht',
          zielA: 0,
          zielLeistungW: 0,
          grund:
            'Das Fahrzeug nimmt keinen Strom mehr an — Akku voll oder die im '
            + 'Auto eingestellte Ladegrenze erreicht. Laden beendet.',
        };
      }

      // Übersteuerung durch den Menschen. Die Gerätegrenzen gelten weiterhin:
      // Was Wallbox und Fahrzeug nicht zulassen, wird auch von Hand nicht
      // gesetzt.
      const vonHand =
        this.betriebsart === 'manuell'
        && !this.gestoppt
        && messwerte.evAngesteckt === true
        && messwerte.wallboxErreichbar;
      if (vonHand) {
        const zielA = this.begrenzeAufDose(this.manuellA);
        // Wurde der Wunsch gekappt, muss das dastehen. Sonst steht dort 10 A,
        // wo 16 eingestellt wurden, und niemand weiss warum.
        const gekappt = zielA < Math.round(this.manuellA);
        entscheidung = {
          ...entscheidung,
          zustand: 'laedt',
          zielA,
          zielLeistungW: ladeleistungAusStromW(zielA, this.anschluss) ?? 0,
          grund: gekappt
            ? `Handbetrieb — ${Math.round(this.manuellA)} A gewünscht, an der `
              + `Haushaltssteckdose sind ${zielA} A die Dauergrenze.`
            : `Handbetrieb — fest auf ${zielA} A eingestellt, auch aus dem Netz.`,
        };
      }

      // Der Stopp-Knopf überstimmt alles, auch den Handbetrieb und die
      // schönste Sonne. Er steht deshalb ganz am Ende der Kette.
      if (this.gestoppt && messwerte.evAngesteckt === true) {
        entscheidung = {
          ...entscheidung,
          zustand: 'gestoppt',
          zielA: 0,
          zielLeistungW: 0,
          grund: 'Laden von Hand beendet. Zum Weiterladen "Laden fortsetzen" drücken.',
        };
      }

      // Und die Dose setzt die letzte Grenze — auch im intelligenten Betrieb.
      if (entscheidung.zielA > 0) {
        const begrenzt = this.begrenzeAufDose(entscheidung.zielA);
        if (begrenzt !== entscheidung.zielA) {
          entscheidung = {
            ...entscheidung,
            zielA: begrenzt,
            zielLeistungW: ladeleistungAusStromW(begrenzt, this.anschluss) ?? 0,
            grund:
              `${entscheidung.grund} An der Haushaltssteckdose höchstens `
              + `${begrenzt} A — mehr hält die Leitung im Dauerbetrieb nicht aus.`,
          };
        }
      }
      this.letzte = entscheidung;

      const netzW =
        (messwerte.netzbezugW ?? 0) - (messwerte.netzeinspeisungW ?? 0);

      // In Zuständen ohne Regelbedarf wird nichts gesendet, aber protokolliert:
      // "nicht verbunden" oder "gestört" sind Auskünfte, keine Ereignisse.
      // "fordert-nicht" gehoert dazu: Es muss ein Stopp hinausgehen, sonst
      // bliebe die Wallbox eingeschaltet und wartete auf ein Auto, das nicht
      // mehr will.
      const regelbar =
        entscheidung.zustand === 'laedt'
        || entscheidung.zustand === 'fordert-nicht'
        || entscheidung.zustand === 'gestoppt'
        || entscheidung.zustand.startsWith('pausiert');
      if (!regelbar) {
        this.notiere(messwerte, entscheidung, netzW, false, entscheidung.grund, null);
        return;
      }

      // Beruhigung nur im Autarkbetrieb. Sie ist dafür da, nicht auf jede Wolke
      // zu reagieren — nicht dafür, einen Menschen warten zu lassen. Wer den
      // Schieberegler bewegt, will die Änderung sehen und nicht neunzig
      // Sekunden Beobachtungszeit abwarten; nach einer Pause wären es sogar
      // zwei Minuten.
      const ergebnis = vonHand
        ? sofort(entscheidung.zielA, this.historie, Date.now())
        : beruhige({
            wunschA: entscheidung.zielA,
            netzbezugW: messwerte.netzbezugW ?? 0,
            jetztMs: Date.now(),
            historie: this.historie,
            zeit: this.zeitparameter(),
          });

      // Beobachten: rechnen, protokollieren, aber nichts an die Wallbox senden.
      //
      // `gesetztA` bleibt dabei unangetastet. Die Beruhigung schreibt es fort,
      // sobald sie senden WÜRDE — hier wurde aber nichts gesendet, und eine
      // Regelung, die sich einen nie abgeschickten Sollwert merkt, führt sich
      // selbst hinters Licht.
      if (this.config.ueberschuss.modus !== 'regeln') {
        this.historie = { ...ergebnis.historie, gesetztA: this.historie.gesetztA };
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
            // Jede Freigabe zaehlt, bis wirklich Strom fliesst. Zurueckgesetzt
            // wird im Messtakt, sobald das Fahrzeug zugreift.
            this.angeboteOhneLadung += 1;
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
