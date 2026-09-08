/**
 * Ladestrom und Ladeleistung ineinander umrechnen.
 *
 * Warum es das gibt: Die Wallbox meldet zwei Dinge, die nach demselben klingen,
 * aber verschiedene Sachen sind — die eingestellte Strombegrenzung in Ampere
 * (6..16 A) und die tatsächlich fliessende Leistung in Watt. Wer nur "16 A"
 * liest, weiss noch nicht, was das kostet. Hier steht die Brücke dazwischen.
 *
 * Die Formel für Drehstrom (drei Phasen, wie bei einer 11-kW-Wallbox):
 *
 *     P = √3 × U × I × cos φ
 *
 * U ist dabei die verkettete Spannung zwischen zwei Aussenleitern, im
 * europäischen Netz 400 V. Bei einphasigem Laden entfällt das √3 und U ist die
 * Spannung gegen den Neutralleiter, also 230 V:
 *
 *     P = U × I × cos φ
 *
 * cos φ wird mit 1 angesetzt. Das ist keine Bequemlichkeit: Das Ladegerät im
 * Fahrzeug hat eine aktive Leistungsfaktorkorrektur (PFC) und arbeitet deshalb
 * praktisch rein ohmsch. Bei Motoren oder Trafos wäre die Annahme falsch.
 *
 * Daraus die Tabelle für den dreiphasigen Anschluss dieser Anlage:
 *
 *      6 A →  4,2 kW        11 A →  7,6 kW
 *      7 A →  4,8 kW        12 A →  8,3 kW
 *      8 A →  5,5 kW        13 A →  9,0 kW
 *      9 A →  6,2 kW        14 A →  9,7 kW
 *     10 A →  6,9 kW        15 A → 10,4 kW
 *                           16 A → 11,1 kW
 *
 * Ein Ampere entspricht also rund 0,69 kW.
 *
 * WICHTIG: Das Ergebnis ist ein Rechenwert, keine Messung. Es sagt, was bei
 * dieser Einstellung höchstens fliessen kann — nicht, was gerade fliesst. Das
 * Fahrzeug darf jederzeit weniger ziehen, und genau das tut es auch: gegen Ende
 * eines Ladevorgangs, bei kalter Batterie oder wenn es selbst begrenzt. Was
 * wirklich fliesst, misst die Wallbox und liefert es als `chargePowerW`. Die
 * Oberfläche muss beides auseinanderhalten, sonst steht dort eine erfundene
 * Zahl mit dem Anschein einer Messung.
 */

/** Wie das Fahrzeug angeschlossen ist. */
export interface Ladeanschluss {
  /** 3 = Drehstrom (11 kW bei 16 A), 1 = einphasig (3,7 kW bei 16 A). */
  readonly phasen: 1 | 3;
  /**
   * Netzspannung in Volt. Bei drei Phasen die verkettete Spannung (400 V),
   * bei einer Phase die gegen den Neutralleiter (230 V).
   */
  readonly spannungV: number;
}

/** Dreiphasig an 400 V — der übliche Anschluss einer 11-kW-Wallbox. */
export const LADEANSCHLUSS_STANDARD: Ladeanschluss = { phasen: 3, spannungV: 400 };

/**
 * Leistungsfaktor.
 *
 * Siehe Kopf der Datei: Bei einem Fahrzeug-Ladegerät mit PFC ist 1 der richtige
 * Wert. Steht hier als benannte Konstante, damit die 1 in der Formel nicht wie
 * ein vergessener Platzhalter aussieht.
 */
const LEISTUNGSFAKTOR = 1;

function faktor(anschluss: Ladeanschluss): number {
  return anschluss.phasen === 3 ? Math.sqrt(3) : 1;
}

/**
 * Welche Leistung fliesst bei diesem Strom höchstens? Ergebnis in Watt.
 *
 * `null` bei unbrauchbarer Eingabe — lieber keine Angabe als eine falsche.
 */
export function ladeleistungAusStromW(
  ampere: number | null,
  anschluss: Ladeanschluss = LADEANSCHLUSS_STANDARD,
): number | null {
  if (ampere === null || !Number.isFinite(ampere) || ampere < 0) return null;
  return faktor(anschluss) * anschluss.spannungV * ampere * LEISTUNGSFAKTOR;
}

/**
 * Umgekehrt: Welcher Strom steckt hinter dieser gemessenen Leistung?
 *
 * Nützlich, um eine gemessene Leistung mit der eingestellten Begrenzung
 * vergleichen zu können — "10,4 kW" sagt für sich genommen nicht, ob das Auto
 * die eingestellten 16 A ausschöpft oder von sich aus weniger nimmt.
 */
export function ladestromAusLeistungA(
  watt: number | null,
  anschluss: Ladeanschluss = LADEANSCHLUSS_STANDARD,
): number | null {
  if (watt === null || !Number.isFinite(watt) || watt < 0) return null;
  const nenner = faktor(anschluss) * anschluss.spannungV * LEISTUNGSFAKTOR;
  if (nenner <= 0) return null;
  return watt / nenner;
}


/**
 * Wie weit die zurückgerechnete Spannung vom Nennwert abweichen darf.
 *
 * Das Versorgungsnetz selbst hält nach EN 50160 ±10 % ein. Gemessen wird hier
 * aber nicht am Übergabepunkt, sondern hinter der Elektronik der Wallbox, ihrer
 * Zuleitung und dem Kontakt der Steckdose. An dieser Anlage kommen bei 10 A an
 * der Haushaltsdose 2073 W an — zurückgerechnet 207 V, also genau auf der
 * Zehn-Prozent-Kante. Eine Messung später sind es 2007 W und damit 201 V, und
 * die Erkennung kippte bei jedem Messwert hin und her.
 *
 * Fünfzehn Prozent decken diesen Spannungsfall ab und lassen die beiden
 * Möglichkeiten immer noch weit auseinander: 196–265 V gegen 340–460 V.
 */
const SPANNUNGSTOLERANZ = 0.15;

/** Nennspannung je Anschlussart. Verkettet bei drei Phasen, gegen N bei einer. */
const NENNSPANNUNG: Record<1 | 3, number> = { 1: 230, 3: 400 };

/**
 * Was eine Haushaltssteckdose überhaupt hergeben kann.
 *
 * 16 A an 230 V sind 3,7 kW, mehr geht dort physikalisch nicht. Wer je mehr
 * gemessen hat, hängt an der Starkstromdose — und zwar unabhängig davon, was
 * das Fahrzeug in diesem Moment gerade zieht.
 */
export const HAUSHALT_HOECHSTLEISTUNG_W = 3700;

/** Einphasig an der Haushaltssteckdose — 16 A wären hier nur 3,7 kW. */
export const LADEANSCHLUSS_HAUSHALT: Ladeanschluss = { phasen: 1, spannungV: 230 };

/**
 * Aus einer echten Messung ableiten, WIE das Auto angesteckt ist.
 *
 * Die Wallbox meldet den eingestellten Ladestrom und die fliessende Leistung,
 * aber nirgends, an welcher Dose der Stecker steckt. Das lässt sich ausrechnen,
 * denn dieselben Ampere bedeuten an den beiden Dosen etwas völlig anderes:
 *
 *     10 A an der Starkstromdose   =  6,9 kW    (√3 × 400 V × 10 A)
 *     10 A an der Haushaltsdose    =  2,3 kW    (230 V × 10 A)
 *
 * Umgekehrt gerechnet ergibt die gemessene Leistung nur bei EINER der beiden
 * Annahmen eine mögliche Netzspannung. Bei 2,1 kW und 10 A wären es dreiphasig
 * 120 V — die gibt es nicht; einphasig 207 V — die gibt es. Genommen wird die
 * Annahme, deren Spannung näher an ihrem Nennwert liegt, und auch die nur, wenn
 * sie im Toleranzband bleibt.
 *
 * ── Warum das allein nicht reicht ───────────────────────────────────────────
 *
 * Ein Fahrzeug, das gegen Ende von sich aus zurücknimmt, sieht aus wie eine
 * schwächere Dose: 3200 W bei gesetzten 16 A ergeben einphasig 200 V, und das
 * liegt im Band. Die Regelung hielte dreiphasige 16 A für 3,7 kW statt für
 * 11 kW — und würde massiv zu viel einplanen. Deshalb der zweite Parameter:
 *
 * `hoechsteGemesseneW` ist die höchste Leistung, die an diesem Anschluss je
 * geflossen ist. Lag sie über dem, was eine Haushaltssteckdose überhaupt
 * hergibt, kann es keine sein — dann bleibt es dreiphasig, egal was die
 * Momentaufnahme nahelegt. Die Richtung ist bewusst unsymmetrisch: Sich
 * dreiphasig zu irren heisst zu vorsichtig laden, einphasig zu irren heisst
 * Netzbezug.
 */
export function gemessenerAnschluss(
  leistungW: number | null,
  ampere: number | null,
  anschluss: Ladeanschluss = LADEANSCHLUSS_STANDARD,
  hoechsteGemesseneW = 0,
): Ladeanschluss {
  if (leistungW === null || !Number.isFinite(leistungW) || leistungW <= 0) return anschluss;
  if (ampere === null || !Number.isFinite(ampere) || ampere <= 0) return anschluss;

  const kandidaten = ([3, 1] as const)
    .map((phasen) => {
      const spannungV = leistungW / ((phasen === 3 ? Math.sqrt(3) : 1) * ampere * LEISTUNGSFAKTOR);
      const abweichung = Math.abs(spannungV - NENNSPANNUNG[phasen]) / NENNSPANNUNG[phasen];
      return { phasen, spannungV, abweichung };
    })
    .filter((k) => k.abweichung <= SPANNUNGSTOLERANZ)
    // Eine Haushaltsdose kann nicht liefern, was hier schon einmal geflossen ist.
    .filter((k) => k.phasen === 3 || hoechsteGemesseneW <= HAUSHALT_HOECHSTLEISTUNG_W)
    .sort((a, b) => a.abweichung - b.abweichung);

  const beste = kandidaten[0];
  return beste === undefined
    ? anschluss
    : { phasen: beste.phasen, spannungV: beste.spannungV };
}

/** Klartext für die Oberfläche: an welcher Dose hängt das Auto? */
export function anschlussName(anschluss: Ladeanschluss): string {
  return anschluss.phasen === 3 ? 'Starkstromdose' : 'Haushaltssteckdose';
}
