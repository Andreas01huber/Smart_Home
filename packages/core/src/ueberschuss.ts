/**
 * Überschussladen: wie viel darf das Auto gerade ziehen?
 *
 * Die eine Regel, aus der alles Übrige folgt: **Das Auto darf niemals der Grund
 * sein, dass Strom aus dem Netz kommt.** Alles hier ist darauf ausgelegt, im
 * Zweifel zu wenig statt zu viel freizugeben.
 *
 * ── Warum nicht einfach PV minus Haus ───────────────────────────────────────
 *
 * Weil beide Werte in dieser Anlage nicht unabhängig sind. `houseConsumptionW`
 * ist hier ein *berechneter* Wert (siehe `source-of-truth.ts`):
 *
 *     Haus = PV + Netzbezug - Einspeisung + Entladung - Ladung
 *
 * Die Wallbox hängt hinter dem Hauszähler, ihre Leistung steckt also bereits im
 * Hausverbrauch. Wer "PV - Haus" rechnet und dann noch das Auto abzieht, zieht
 * es zweimal ab und lädt viel zu vorsichtig. Deshalb ist der erste Schritt hier
 * immer: Hausverbrauch OHNE Auto = Haus - Auto.
 *
 * ── Warum der Netzzähler das Maß der Dinge ist ──────────────────────────────
 *
 * Die Bilanz aus PV, Haus und Speichern ist eine Rechnung mit vier Messfehlern.
 * Der Netzzähler dagegen misst genau das, was vermieden werden soll. Deshalb
 * ist er das Rückführsignal:
 *
 *     verfügbar = Auto_jetzt + Einspeisung - Netzbezug - Reserve ± Speicher
 *
 * Gelesen: Was das Auto gerade zieht, plus was trotzdem noch ins Netz geht,
 * minus was aus dem Netz kommt. Zieht das Auto 5 kW und es fliessen trotzdem
 * 400 W aus dem Netz, dann waren nur 4,6 kW wirklich verfügbar — unabhängig
 * davon, was PV und Haus einzeln behaupten. Diese Form regelt sich von selbst
 * auf Netzbezug null ein und braucht keine perfekten Einzelmessungen.
 *
 * ── Speicher ────────────────────────────────────────────────────────────────
 *
 * Eine laufende Entladung wird NICHT als verfügbar verbucht, sonst würde das
 * Auto den Speicher leersaugen, den das Haus für die Nacht braucht. Stattdessen
 * wird sie herausgerechnet und nur das wieder zugegeben, was die Strategie
 * ausdrücklich freigibt (`entladenMaxW`, oberhalb `minSocPercent`). Ergebnis:
 * Es kommt aus dem Speicher, was gebraucht wird, nicht was er hergäbe.
 *
 * Alles hier ist eine reine Funktion ohne Uhr, Netzwerk und Zustand — damit
 * jedes der Szenarien aus dem Betrieb als Test nachstellbar ist.
 */

import { ladeleistungAusStromW, type Ladeanschluss } from './ladeleistung.ts';

/** Zustände der Fahrzeugladung. Genau einer gilt zu jedem Zeitpunkt. */
export type Ladezustand =
  /** Regelung ist ausgeschaltet — die Wallbox macht, was sie will. */
  | 'aus'
  /** Kein Fahrzeug angesteckt. */
  | 'nicht-verbunden'
  /** Angesteckt, aber (noch) keine Freigabe. */
  | 'wartet'
  /** Lädt mit Überschuss. */
  | 'laedt'
  /** Angehalten: zu wenig Überschuss für den Mindestladestrom. */
  | 'pausiert-leistung'
  /** Angehalten: Speicher darf nicht (weiter) entladen werden. */
  | 'pausiert-speicher'
  /** Angehalten: Messwerte fehlen oder sind zu alt. */
  | 'pausiert-messwerte'
  /** Die Wallbox ist über Tuya gerade nicht erreichbar. */
  | 'gestoert'
  /** Fahrzeug meldet den Ladevorgang als beendet. */
  | 'beendet';

/** Ein Speicher, so wie ihn die Regelung braucht. */
export interface SpeicherZustand {
  readonly id: string;
  readonly name: string;
  readonly socPercent: number | null;
  readonly ladenW: number | null;
  readonly entladenW: number | null;
}

/** Grenzen eines Speichers. Kommt aus der Konfiguration. */
export interface SpeicherGrenzen {
  /** Unterhalb dieses Ladestands wird für das Auto nicht mehr entladen. */
  readonly minSocPercent: number;
  /** Höchste Leistung, die für das Auto aus diesem Speicher kommen darf. */
  readonly entladenMaxW: number;
}

/** Messwerte eines Regelzyklus. `null` heisst: unbekannt, nicht null Watt. */
export interface Messwerte {
  readonly pvW: number | null;
  /** Hausverbrauch INKLUSIVE Auto — so, wie ihn die Bilanz liefert. */
  readonly hausMitAutoW: number | null;
  readonly netzbezugW: number | null;
  readonly netzeinspeisungW: number | null;
  readonly evLeistungW: number | null;
  readonly evAngesteckt: boolean | null;
  /** Aktuell an der Wallbox eingestellter Ladestrom. */
  readonly evStromA: number | null;
  readonly speicher: readonly SpeicherZustand[];
  /** Alter des ältesten Messwerts, der in die Entscheidung eingeht. */
  readonly messalterMs: number;
  /** Wallbox über Tuya erreichbar? */
  readonly wallboxErreichbar: boolean;
  /** Fahrzeug meldet "fertig". */
  readonly ladungBeendet?: boolean;
}

/** Alles, was die Regelung an Grenzen und Stellschrauben kennt. */
export interface Reglerparameter {
  readonly anschluss: Ladeanschluss;
  /** Kleinster Ladestrom, den Wallbox und Fahrzeug zulassen. */
  readonly minA: number;
  readonly maxA: number;
  /** Schrittweite, die die Wallbox akzeptiert. */
  readonly schrittA: number;
  /** Sicherheitsabstand zum Netzbezug in Watt. */
  readonly reserveW: number;
  /** Totzone um 0 W Netz — darunter wird nicht nachgeregelt. */
  readonly netzTotzoneW: number;
  /** Speichergrenzen je Gerät, plus Vorgabe für unbekannte Geräte. */
  readonly speicher: Readonly<Record<string, SpeicherGrenzen>>;
  readonly speicherStandard: SpeicherGrenzen;
  /** Darf überhaupt aus den Speichern für das Auto entladen werden? */
  readonly speicherEntladenErlaubt: boolean;
  /** Ab diesem Alter gelten Messwerte als unbrauchbar. */
  readonly maxMessalterMs: number;
}

/** Ergebnis eines Regelzyklus. */
export interface Ladeentscheidung {
  readonly zustand: Ladezustand;
  /** Zu setzender Ladestrom; 0 bedeutet Pause. */
  readonly zielA: number;
  /** Was dieser Strom an Leistung bedeutet. */
  readonly zielLeistungW: number;
  /** Errechnete verfügbare Leistung (kann negativ sein). */
  readonly verfuegbarW: number;
  /** Hausverbrauch ohne Auto — die Zahl, um die es eigentlich geht. */
  readonly hausOhneAutoW: number | null;
  /** Was die Speicher beitragen dürfen. */
  readonly speicherbeitragW: number;
  /** Klartext für Oberfläche und Protokoll. */
  readonly grund: string;
}

const LEER: SpeicherGrenzen = { minSocPercent: 100, entladenMaxW: 0 };

function zahl(wert: number | null | undefined): number | null {
  return typeof wert === 'number' && Number.isFinite(wert) ? wert : null;
}

/**
 * Wie viel dürfen die Speicher für das Auto beisteuern?
 *
 * Bewusst nicht "was können sie", sondern "was dürfen sie": Unterhalb des
 * Mindestladestands gibt ein Speicher nichts mehr her, und auch darüber nur bis
 * zu seiner konfigurierten Grenze. Ein Speicher ohne bekannten Ladestand zählt
 * mit null — im Zweifel lieber zu wenig.
 */
export function speicherFreigabeW(
  speicher: readonly SpeicherZustand[],
  parameter: Reglerparameter,
): number {
  if (!parameter.speicherEntladenErlaubt) return 0;
  let summe = 0;
  for (const s of speicher) {
    const grenzen = parameter.speicher[s.id] ?? parameter.speicherStandard ?? LEER;
    const soc = zahl(s.socPercent);
    if (soc === null || soc <= grenzen.minSocPercent) continue;
    summe += Math.max(0, grenzen.entladenMaxW);
  }
  return summe;
}

/** Summe der aktuellen Entladeleistung aller Speicher. */
function entladungJetztW(speicher: readonly SpeicherZustand[]): number {
  return speicher.reduce((summe, s) => summe + Math.max(0, zahl(s.entladenW) ?? 0), 0);
}

/** Auf die Schrittweite abgerundeter Ladestrom. Abrunden, niemals aufrunden. */
export function stromAusLeistungA(watt: number, parameter: Reglerparameter): number {
  const proAmpere = ladeleistungAusStromW(1, parameter.anschluss) ?? 0;
  if (proAmpere <= 0) return 0;
  const roh = watt / proAmpere;
  const schritt = parameter.schrittA > 0 ? parameter.schrittA : 1;
  // Abrunden ist kein Detail: Aufrunden hiesse, den fehlenden Rest aus dem Netz
  // zu holen - genau das, was diese ganze Datei verhindern soll.
  const gestuft = Math.floor(roh / schritt) * schritt;
  return Math.max(0, Math.min(parameter.maxA, gestuft));
}

/**
 * Der Kern: verfügbare Leistung und daraus der zulässige Ladestrom.
 *
 * Kennt weder Uhr noch Vorgeschichte. Die zeitliche Beruhigung — Hysterese,
 * Mindestabstände, Anti-Pendeln — sitzt bewusst eine Ebene höher im Regler,
 * damit diese Rechnung für sich prüfbar bleibt.
 */
export function berechneLadeziel(
  messwerte: Messwerte,
  parameter: Reglerparameter,
): Ladeentscheidung {
  const evLeistung = zahl(messwerte.evLeistungW) ?? 0;
  const haus = zahl(messwerte.hausMitAutoW);
  // Das Auto steckt im Hausverbrauch bereits drin. Genau hier wird die
  // Doppelzählung vermieden, vor der jede Überschussregelung steht.
  const hausOhneAuto = haus === null ? null : Math.max(0, haus - evLeistung);

  const leer = (zustand: Ladezustand, grund: string): Ladeentscheidung => ({
    zustand,
    zielA: 0,
    zielLeistungW: 0,
    verfuegbarW: 0,
    hausOhneAutoW: hausOhneAuto,
    speicherbeitragW: 0,
    grund,
  });

  // ── Zustände, in denen gar nicht geregelt wird ────────────────────────────
  if (!messwerte.wallboxErreichbar) {
    return leer('gestoert', 'Wallbox über Tuya nicht erreichbar — keine Änderung.');
  }
  if (messwerte.evAngesteckt === false) {
    return leer('nicht-verbunden', 'Kein Fahrzeug angesteckt.');
  }
  if (messwerte.ladungBeendet === true) {
    return leer('beendet', 'Fahrzeug meldet den Ladevorgang als beendet.');
  }

  // ── Messwerte brauchbar? ─────────────────────────────────────────────────
  // Ohne Netzzähler ist die Regelung blind. Dann wird nicht geraten, sondern
  // pausiert - Anforderung "im Zweifel kein Netzbezug".
  const netzbezug = zahl(messwerte.netzbezugW);
  const einspeisung = zahl(messwerte.netzeinspeisungW);
  if (netzbezug === null || einspeisung === null || messwerte.evAngesteckt === null) {
    return leer('pausiert-messwerte', 'Netzzähler liefert keine Werte — Laden pausiert.');
  }
  if (messwerte.messalterMs > parameter.maxMessalterMs) {
    const sekunden = Math.round(messwerte.messalterMs / 1000);
    return leer(
      'pausiert-messwerte',
      `Messwerte sind ${sekunden} s alt — Laden pausiert, um Netzbezug auszuschliessen.`,
    );
  }

  // ── Verfügbare Leistung ──────────────────────────────────────────────────
  const freigabe = speicherFreigabeW(messwerte.speicher, parameter);
  const entladung = entladungJetztW(messwerte.speicher);

  // Rückführung über den Netzzähler, dann die Speicher zurechtrücken:
  // laufende Entladung raus (die gehört dem Haus), erlaubte Freigabe rein.
  const verfuegbar =
    evLeistung + einspeisung - netzbezug - parameter.reserveW - entladung + freigabe;

  const maxLeistung = ladeleistungAusStromW(parameter.maxA, parameter.anschluss) ?? 0;
  const zielLeistung = Math.max(0, Math.min(verfuegbar, maxLeistung));
  const zielA = stromAusLeistungA(zielLeistung, parameter);

  // ── Reicht es für den Mindeststrom? ──────────────────────────────────────
  if (zielA < parameter.minA) {
    // Warum es nicht reicht, sauber unterscheiden: Ein Speicher, der wegen
    // seiner Reserve nichts hergeben darf, ist etwas anderes als ein trüber Tag.
    const koennteMitSpeicher =
      !parameter.speicherEntladenErlaubt && messwerte.speicher.length > 0;
    if (koennteMitSpeicher) {
      return {
        ...leer(
          'pausiert-speicher',
          'Laden pausiert — die Speicher sind für das Auto gesperrt und die '
            + 'Sonne allein reicht gerade nicht.',
        ),
        verfuegbarW: verfuegbar,
        speicherbeitragW: freigabe,
      };
    }
    const fehlt = Math.max(
      0,
      (ladeleistungAusStromW(parameter.minA, parameter.anschluss) ?? 0) - verfuegbar,
    );
    return {
      ...leer(
        'pausiert-leistung',
        `Laden pausiert — es fehlen rund ${Math.round(fehlt)} W für den `
          + `Mindestladestrom von ${parameter.minA} A. Netzbezug würde entstehen.`,
      ),
      verfuegbarW: verfuegbar,
      speicherbeitragW: freigabe,
    };
  }

  const gesetzteLeistung = ladeleistungAusStromW(zielA, parameter.anschluss) ?? 0;
  return {
    zustand: 'laedt',
    zielA,
    zielLeistungW: gesetzteLeistung,
    verfuegbarW: verfuegbar,
    hausOhneAutoW: hausOhneAuto,
    speicherbeitragW: freigabe,
    grund:
      freigabe > 0 && entladung > 0
        ? `Lädt aus Überschuss und freigegebener Speicherleistung mit ${zielA} A.`
        : `Lädt mit Überschuss, ${zielA} A.`,
  };
}
