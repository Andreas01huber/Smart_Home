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
