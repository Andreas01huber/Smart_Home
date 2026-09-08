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
 * Der Netzzähler allein sieht einen Teil des Überschusses nicht. Lädt ein
 * Speicher gerade mit 1,9 kW, dann geht nichts ins Netz — der Zähler steht auf
 * null und meldet damit "kein Überschuss", obwohl die Sonne 7,3 kW liefert.
 * Genau das liess das Auto an sonnigen Tagen stehen.
 *
 * Deshalb kommen zum Netzzähler zwei Posten aus den Speichern dazu, und beide
 * sind bewusst KEINE Versprechen aus der Konfiguration:
 *
 *   Ladeleistung   Was gerade in einen Speicher fliesst, ist gemessener
 *                  Überschuss. Nimmt das Auto ihn, lädt der Speicher langsamer
 *                  — Netzbezug entsteht dabei nicht.
 *   Entladespielraum  Was ein Speicher noch hergeben könnte, aber höchstens
 *                  so viel, wie er an dieser Anlage schon einmal wirklich
 *                  geliefert hat.
 *
 * Beides gilt erst ab `autoVorrangAbSocPercent`. Darunter bleibt es bei der
 * alten Rangfolge: Erst der Speicher, dann das Auto. Ist der Speicher dagegen
 * fast voll, bringen ihm die letzten Prozent wenig und dem Auto viel.
 *
 * Eine Entladung ÜBER der Freigabe wird nach wie vor abgezogen — die braucht
 * das Haus, nicht das Auto.
 *
 * Alles hier ist eine reine Funktion ohne Uhr, Netzwerk und Zustand — damit
 * jedes der Szenarien aus dem Betrieb als Test nachstellbar ist.
 */

import {
  gemessenerAnschluss,
  ladeleistungAusStromW,
  type Ladeanschluss,
} from './ladeleistung.ts';

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
  | 'beendet'
  /**
   * Angesteckt und freigegeben, aber das Fahrzeug nimmt nichts ab.
   *
   * Der Akku ist voll oder die im Auto eingestellte Ladegrenze ist erreicht.
   * Von aussen sieht das aus wie "lädt" — die Wallbox ist eingeschaltet, ein
   * Ladestrom steht —, nur fliesst nichts. Ohne eigenen Zustand böte die
   * Regelung endlos weiter an.
   */
  | 'fordert-nicht';

/** Ein Speicher, so wie ihn die Regelung braucht. */
export interface SpeicherZustand {
  readonly id: string;
  readonly name: string;
  readonly socPercent: number | null;
  readonly ladenW: number | null;
  readonly entladenW: number | null;
  /**
   * Höchste Entladeleistung, die dieser Speicher nachweislich geliefert hat.
   *
   * Nicht das Datenblatt, nicht die Konfiguration: gemessen, an dieser Anlage,
   * in den letzten Stunden. Nur bis hierher darf die Regelung mit dem Speicher
   * rechnen — siehe `speicherspielraum`.
   */
  readonly bewaehrtEntladenW?: number | null;
}

/** Grenzen eines Speichers. Kommt aus der Konfiguration. */
export interface SpeicherGrenzen {
  /** Unterhalb dieses Ladestands wird für das Auto nicht mehr entladen. */
  readonly minSocPercent: number;
  /** Höchste Leistung, die für das Auto aus diesem Speicher kommen darf. */
  readonly entladenMaxW: number;
  /**
   * Ab diesem Ladestand hat das Auto Vorrang vor dem Speicher.
   *
   * Darunter gilt die alte Rangfolge: Erst wird der Speicher voll, das Auto
   * bekommt nur, was übrig bleibt. Darüber dreht sie sich um — ein fast voller
   * Speicher hat wenig davon, die letzten Prozent noch mitzunehmen, das Auto
   * dagegen sehr viel. Das ist die Stellschraube für "die Speicher sind voll,
   * also soll der Rest ins Auto".
   */
  readonly autoVorrangAbSocPercent: number;
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
  /**
   * Hauptschalter der Wallbox laut Gerät. null = meldet keinen.
   *
   * Geht nicht in die Rechnung ein — der Regeldienst braucht ihn, um sein
   * eigenes Gedächtnis gegen die Wirklichkeit zu prüfen.
   */
  readonly evSchalterAn?: boolean | null;
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

const LEER: SpeicherGrenzen = {
  minSocPercent: 100,
  entladenMaxW: 0,
  autoVorrangAbSocPercent: 101,
};

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

/** Was die Speicher zur verfügbaren Leistung beitragen — in vier Posten. */
export interface Speicherspielraum {
  /**
   * Leistung, die gerade in die Speicher fliesst und die das Auto haben darf.
   *
   * Der wichtigste Posten, und lange der fehlende. Ein Speicher, der mit 1,9 kW
   * lädt, verschluckt genau diese 1,9 kW Überschuss: Es geht nichts ins Netz,
   * also sieht der Netzzähler nichts, also hielt die Regelung den Überschuss
   * für null und liess das Auto stehen — bei 7,3 kW Sonne. Dabei ist diese
   * Leistung der handfesteste Beitrag von allen, weil sie GEMESSEN ist. Nimmt
   * das Auto sie, lädt der Speicher eben langsamer. Netzbezug entsteht dabei
   * nicht, und die Rechnung korrigiert sich von selbst: Sinkt die Ladeleistung
   * des Speichers, schrumpft dieser Posten im nächsten Zyklus mit.
   */
  readonly ladungFuerAutoW: number;
  /**
   * Noch ungenutzte Entladeleistung — begrenzt auf das, was der Speicher
   * nachweislich schafft.
   *
   * Hier wäre der bequeme Fehler, die konfigurierte Freigabe einzusetzen. Das
   * stand einmal so da und kostete rund 2 kWh Netzbezug am Tag: Eine Freigabe
   * ist ein Versprechen, und ein Speicher an seiner Reserve oder mit
   * begrenztem Wechselrichter hält es nicht. Das Auto zieht trotzdem, die
   * Differenz kommt aus dem Netz — und weil das Versprechen fest in der Formel
   * stand, pendelte sich die Regelung genau auf diesen Netzbezug ein, statt auf
   * null.
   *
   * Deshalb zählt hier nur, was der Speicher an dieser Anlage schon einmal
   * wirklich geliefert hat (`bewaehrtEntladenW`). Ein Speicher, der nie mehr
   * als 2 kW hergab, wird auch nur mit 2 kW eingeplant, egal was in der
   * Konfiguration steht. Damit kann die Regelung nicht dauerhaft zu viel
   * verlangen, und ein Sägezahn aus "erhöhen, Netzbezug, senken" entsteht gar
   * nicht erst.
   */
  readonly entladespielraumW: number;
  /** Entladung über der Freigabe — die gehört dem Haus und wird abgezogen. */
  readonly ueberEntladungW: number;
  /** Summe der konfigurierten Freigaben. Nur zur Anzeige. */
  readonly freigabeW: number;
}

/**
 * Was dürfen die Speicher zum Laden des Autos beitragen?
 *
 * Drei Stufen, von unten nach oben:
 *
 *   SoC ≤ minSocPercent      Der Speicher ist tabu. Was er entlädt, braucht das
 *                            Haus; es wird voll abgezogen.
 *   bis autoVorrangAbSoc     Alte Rangfolge: Eine laufende Entladung bis zur
 *                            Freigabe wird dem Auto nicht angelastet, aber es
 *                            wird nichts eingeplant. Der Speicher hat Vorrang.
 *   darüber                  Das Auto hat Vorrang: Die Ladeleistung des
 *                            Speichers darf es haben, und der noch ungenutzte
 *                            — bewährte — Entladespielraum kommt dazu.
 */
export function speicherspielraum(
  speicher: readonly SpeicherZustand[],
  parameter: Reglerparameter,
): Speicherspielraum {
  let ladungFuerAuto = 0;
  let entladespielraum = 0;
  let ueberEntladung = 0;
  let freigabe = 0;

  for (const s of speicher) {
    const grenzen = parameter.speicher[s.id] ?? parameter.speicherStandard ?? LEER;
    const soc = zahl(s.socPercent);
    const laden = Math.max(0, zahl(s.ladenW) ?? 0);
    const entladen = Math.max(0, zahl(s.entladenW) ?? 0);

    // Ein Speicher ohne bekannten Ladestand zählt wie einer an seiner Reserve.
    // Im Zweifel lieber zu wenig — das ist hier die ganze Haltung.
    const darfEntladen =
      parameter.speicherEntladenErlaubt && soc !== null && soc > grenzen.minSocPercent;
    const dieseFreigabe = darfEntladen ? Math.max(0, grenzen.entladenMaxW) : 0;
    freigabe += dieseFreigabe;
    ueberEntladung += Math.max(0, entladen - dieseFreigabe);

    if (soc === null || soc < grenzen.autoVorrangAbSocPercent) continue;

    ladungFuerAuto += laden;
    if (!darfEntladen) continue;
    const bewaehrt = Math.max(0, zahl(s.bewaehrtEntladenW ?? null) ?? 0);
    entladespielraum += Math.max(0, Math.min(dieseFreigabe, bewaehrt) - entladen);
  }

  return {
    ladungFuerAutoW: ladungFuerAuto,
    entladespielraumW: entladespielraum,
    ueberEntladungW: ueberEntladung,
    freigabeW: freigabe,
  };
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
  const haus = zahl(messwerte.hausMitAutoW);
  const gemeldetesAuto = zahl(messwerte.evLeistungW) ?? 0;

  // Der Ladewert wird am Hausverbrauch gedeckelt — und das ist keine Kosmetik,
  // sondern die Lehre aus einem Regelkreis, der sich selbst aufgeschaukelt hat.
  //
  // Die Wallbox meldet über die Tuya-Cloud, der Rest der Anlage über das
  // Heimnetz. Hört das Auto auf zu laden, sieht der Hauszähler das sofort, die
  // Cloud aber noch eine halbe Minute lang nicht. In dieser Lücke stand im
  // Protokoll: "verfügbar 14435 W" bei 5663 W Sonne — die Rechnung addierte
  // 9 kW Ladeleistung, die längst nicht mehr flossen. Die Regelung stellte
  // brav 16 A, das Auto lief wirklich an, und der Netzzähler sprang auf
  // 2847 W. Drei Mal hintereinander, jedes Mal gefolgt von einer Notbremse.
  //
  // Ein Auto kann nicht mehr ziehen als das ganze Haus verbraucht. Das ist eine
  // physikalische Aussage, keine Annahme, und sie macht aus zwei
  // widersprüchlichen Messwerten wieder einen brauchbaren: Im Zweifel gilt der
  // schnellere Zähler. Nach unten deckeln ist dabei die sichere Richtung — zu
  // wenig eingeplante Ladeleistung heisst zu vorsichtig laden, zu viel heisst
  // Netzbezug.
  // Zweite Schranke, und die wichtigere: Mehr als die eingestellte
  // Strombegrenzung hergibt, kann das Auto nicht ziehen.
  //
  // Am 8.9. um 16:50 stand an der Wallbox `charge_cur_set 6`, während
  // `power_total` seit Minuten unverändert 10 084 W meldete. Der Leistungswert
  // aus der Tuya-Cloud friert ein; die Strombegrenzung dagegen folgt dem Befehl
  // sofort. Wer nur den Leistungswert glaubt, rechnet mit sechs Kilowatt, die
  // es nicht gibt — genau daran hat sich die Regelung aufgeschaukelt: 16 A
  // gestellt, drei Kilowatt Netzbezug, Notbremse, von vorn.
  //
  // Die Eichung weiter unten prüft dabei mit: 10 084 W bei 6 A wären 970 V, das
  // liegt weit ausserhalb jeder Netzspannung. Solche Paare fallen durch, und es
  // bleibt bei der Umrechnung mit der Nennspannung.
  const anschluss = gemessenerAnschluss(
    gemeldetesAuto,
    messwerte.evStromA,
    parameter.anschluss,
  );
  // Nur wenn wirklich ein Ladestrom eingestellt ist. Steht dort 0 oder nichts,
  // gibt es von dieser Seite keine Aussage — und ein Auto, das trotz
  // abgeschalteter Wallbox zieht, soll sichtbar bleiben und nicht auf null
  // gerechnet werden. Diesen Fall behandelt der Abgleich im Regeldienst.
  const gesetztA = zahl(messwerte.evStromA);
  const ausStrom =
    gesetztA !== null && gesetztA > 0 ? ladeleistungAusStromW(gesetztA, anschluss) : null;

  const schranken = [gemeldetesAuto];
  if (ausStrom !== null) schranken.push(ausStrom);
  if (haus !== null) schranken.push(Math.max(0, haus));
  const evLeistung = Math.min(...schranken);
  const widerspruch = evLeistung < gemeldetesAuto;

  // Das Auto steckt im Hausverbrauch bereits drin. Genau hier wird die
  // Doppelzählung vermieden, vor der jede Überschussregelung steht.
  //
  // Widersprechen sich die beiden Messwerte, kommt hier `null` heraus und nicht
  // etwa null Watt. Der Unterschied ist wichtig: Die Anzeige macht aus `null`
  // ein "—", aus 0 aber ein leeres Haus. Genau das stand vorher minutenlang im
  // Protokoll — "Haus ohne Auto 0 W", während im Haus 1,5 kW liefen.
  const hausOhneAuto =
    haus === null ? null : widerspruch ? null : Math.max(0, haus - evLeistung);

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

  // ── Umrechnung an der Wirklichkeit nacheichen ────────────────────────────
  // Solange das Auto lädt, sind gesetzter Strom und gemessene Leistung beide
  // bekannt — daraus folgt, was ein Ampere an DIESER Anlage wirklich bedeutet.
  // Ohne das rechnet die Regelung mit 693 W je Ampere, während 673 fliessen,
  // und verlangt für jede Stufe rund 300 W mehr Überschuss als nötig.
  const geeicht: Reglerparameter = { ...parameter, anschluss };

  // ── Verfügbare Leistung ──────────────────────────────────────────────────
  const spielraum = speicherspielraum(messwerte.speicher, parameter);
  const freigabe = spielraum.freigabeW;
  const entladung = entladungJetztW(messwerte.speicher);

  // Was die Speicher zum Laden beitragen — das, was sie gerade liefern, plus
  // das, was sie noch könnten. Früher stand hier die konfigurierte Freigabe,
  // also eine Zahl aus einer Datei. Die half beim Verstehen nicht: Sie blieb
  // gleich, ob der Speicher voll oder leer war.
  const speicherbeitrag =
    spielraum.ladungFuerAutoW + spielraum.entladespielraumW + Math.min(entladung, freigabe);

  // Die vier Summanden hinter dem Netzzähler sind bewusst zweierlei Art:
  //
  //   evLeistung + einspeisung - netzbezug   gemessen, am Übergabepunkt
  //   + ladungFuerAuto                       gemessen, an den Speichern
  //   + entladespielraum                     bewährt, nicht versprochen
  //   - ueberEntladung                       gemessen, gehört dem Haus
  //
  // Alles davon korrigiert sich im nächsten Zyklus selbst: Nimmt das Auto die
  // Ladeleistung des Speichers, sinkt `ladungFuerAuto`; entlädt der Speicher
  // wirklich, schrumpft `entladespielraum`. Es steht keine feste Zahl in der
  // Formel, auf die sich die Regelung mit Netzbezug einpendeln könnte.
  const verfuegbar =
    evLeistung
    + einspeisung
    - netzbezug
    - parameter.reserveW
    + spielraum.ladungFuerAutoW
    + spielraum.entladespielraumW
    - spielraum.ueberEntladungW;

  const maxLeistung = ladeleistungAusStromW(geeicht.maxA, geeicht.anschluss) ?? 0;
  const zielLeistung = Math.max(0, Math.min(verfuegbar, maxLeistung));
  let zielA = stromAusLeistungA(zielLeistung, geeicht);

  // Die Reserve ist ein Sicherheitsabstand fürs Wachsen, kein Grund zum
  // Abwürgen. Ohne diese Ausnahme beendet sie das Laden am Minimum von selbst:
  // Bei 6 A fliessen gut 4150 W, abzüglich 200 W Reserve bleiben 3950 W — das
  // sind rechnerisch 5 A, also unter dem Minimum, also Pause. Und nach der
  // Pause fehlen erst recht 4150 W, um wieder anzufangen. Das Auto käme nie
  // über den kleinsten Ladestrom hinaus.
  //
  // Wer schon lädt und dabei nachweislich keinen Netzbezug verursacht, darf
  // deshalb weiterladen. Nachweislich heisst: gemessen, nicht gehofft.
  if (
    zielA < parameter.minA &&
    evLeistung > 0 &&
    netzbezug <= parameter.netzTotzoneW &&
    stromAusLeistungA(Math.max(0, verfuegbar + geeicht.reserveW), geeicht) >= geeicht.minA
  ) {
    zielA = parameter.minA;
  }

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
        speicherbeitragW: speicherbeitrag,
      };
    }
    const fehlt = Math.max(
      0,
      (ladeleistungAusStromW(geeicht.minA, geeicht.anschluss) ?? 0) - verfuegbar,
    );
    return {
      ...leer(
        'pausiert-leistung',
        `Laden pausiert — es fehlen rund ${Math.round(fehlt)} W für den `
          + `Mindestladestrom von ${parameter.minA} A. Netzbezug würde entstehen.`,
      ),
      verfuegbarW: verfuegbar,
      speicherbeitragW: speicherbeitrag,
    };
  }

  const gesetzteLeistung = ladeleistungAusStromW(zielA, geeicht.anschluss) ?? 0;
  return {
    zustand: 'laedt',
    zielA,
    zielLeistungW: gesetzteLeistung,
    verfuegbarW: verfuegbar,
    hausOhneAutoW: hausOhneAuto,
    speicherbeitragW: speicherbeitrag,
    grund:
      speicherbeitrag > 0
        ? `Lädt mit ${zielA} A — Sonne plus ${Math.round(speicherbeitrag)} W aus den Speichern.`
        : `Lädt mit Überschuss, ${zielA} A.`,
  };
}
