/**
 * Zentrale Formatierungsfunktionen (Anforderungen 13–17, 58).
 *
 * Eine einzige Quelle für die gesamte Darstellung. Deutsche Zahlenformatierung
 * (1.234,56). Fehlende Werte werden zu „—", niemals „NaN" oder „null".
 */

const nfSoc = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

const MISSING = '—';

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Ladezustand: immer ganzzahlig, „74 %". Nie „74,000 %". */
export function formatSoc(value) {
  if (!isNum(value)) return MISSING;
  return `${nfSoc.format(Math.round(value))} %`;
}

/** Prozentwert (Autarkie, Eigenverbrauch): ganzzahlig, „93 %". */
export function formatPercentage(value) {
  if (!isNum(value)) return MISSING;
  return `${nf0.format(Math.round(value))} %`;
}

/**
 * Leistung mit Einheit: unter 1 kW in Watt (ganzzahlig), darüber in kW mit
 * einer Nachkommastelle. Gibt { value, unit } für getrennte Darstellung.
 */
export function formatPowerParts(watts) {
  if (!isNum(watts)) return { value: MISSING, unit: '' };
  if (Math.abs(watts) < 1000) return { value: nf0.format(Math.round(watts)), unit: 'W' };
  return { value: nf1.format(watts / 1000), unit: 'kW' };
}
export function formatPower(watts) {
  const p = formatPowerParts(watts);
  return p.unit ? `${p.value} ${p.unit}` : p.value;
}

/** Energie: kWh mit einer Nachkommastelle, ab 1 MWh in MWh mit zwei. */
export function formatEnergyParts(wh) {
  if (!isNum(wh)) return { value: MISSING, unit: '' };
  const kwh = wh / 1000;
  if (Math.abs(kwh) >= 1000) return { value: nf2.format(kwh / 1000), unit: 'MWh' };
  return { value: nf1.format(kwh), unit: 'kWh' };
}
export function formatEnergy(wh) {
  const e = formatEnergyParts(wh);
  return e.unit ? `${e.value} ${e.unit}` : e.value;
}

/** Geldbetrag: „8,42 €". */
export function formatCurrency(value) {
  if (!isNum(value)) return MISSING;
  return `${nf2.format(value)} €`;
}

/** Relatives Alter aus einem ISO-Zeitstempel oder Date. */
export function formatTimestamp(value) {
  if (value === null || value === undefined) return MISSING;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return MISSING;
  const seconds = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (seconds < 2) return 'gerade eben';
  if (seconds < 60) return `vor ${seconds} Sekunden`;
  const minutes = Math.round(seconds / 60);
  if (minutes === 1) return 'vor 1 Minute';
  if (minutes < 60) return `vor ${minutes} Minuten`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return 'vor 1 Stunde';
  if (hours < 24) return `vor ${hours} Stunden`;
  return d.toLocaleDateString('de-DE');
}

/** Uhrzeit „14:32". */
export function formatClock(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return MISSING;
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** Dauer in Alltagssprache: „2 h 34 min“, „48 min“, „—“ bei fehlendem Wert. */
export function formatDuration(seconds) {
  if (!isNum(seconds) || seconds < 0) return MISSING;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  // Unter einer Minute: Sekunden — ausser bei glatt 0, dort liest sich die
  // gleiche Einheit wie bei allen anderen Dauern ruhiger.
  if (h === 0 && m === 0) return total === 0 ? '0 min' : `${total} s`;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// ── Wallbox: Einstellung und Messung auseinanderhalten ─────────────────────
//
// Die beiden Kacheln standen einmal nebeneinander und sagten dasselbe zweimal,
// mit verschiedenen Zahlen: "Ladeleistung 10,1 kW ~ 15 A" neben "Ladestrom
// 15 A ~ 10,4 kW". Die eine Zahl war gemessen, die andere aus 400 V gerechnet,
// und an dieser Anlage liegen dazwischen rund 300 W. Wer beide liest, glaubt
// zu Recht keiner von beiden.
//
// Jetzt sagt jede Kachel genau eine Sache: die eine, was fliesst; die andere,
// was eingestellt ist.

/** Eingestellte Strombegrenzung, im Verhaeltnis zum Hoechstwert des Geraets. */
export function formatLadestrom(ev) {
  if (!ev || ev.maxCurrentA == null) return MISSING;
  const grenze = ev.regelung?.maxA;
  return grenze ? `${ev.maxCurrentA} A von ${grenze} A` : `${ev.maxCurrentA} A`;
}

/** Gemessene Ladeleistung. Eine Messung, keine Rechnung. */
export function formatLadeleistung(ev) {
  if (!ev || !isNum(ev.powerW)) return MISSING;
  return formatPower(ev.powerW);
}

// ── Hinweise rund um die Ladedose ───────────────────────────────────────────
//
// Reine Textfunktionen: Sie bekommen den Zustand der Regelung und geben einen
// Satz zurueck, sonst nichts. Hier statt in app.js, weil sie so geprueft werden
// koennen, ohne auf das passende Wetter zu warten — der Abendhinweis erscheint
// sonst nur zwischen Sonnenuntergang und leerem Speicher.

/** Was ein Ampere an der Starkstromdose bedeutet — Nennwert fuer den Vergleich. */
const DREHSTROM_W_PRO_A = 693;
/** Und an der Haushaltssteckdose. */
const HAUSHALT_W_PRO_A = 230;

/**
 * Steckt das Auto an der Haushaltssteckdose?
 *
 * Nur dann kommt ein Satz. Die Starkstromdose ist der Normalfall und braucht
 * keine Meldung; an der Haushaltsdose dagegen bedeutet dieselbe Amperezahl ein
 * Drittel der Leistung, und das erklaert sonst niemand.
 */
export function dosenText(regelung) {
  const dose = regelung?.anschluss;
  if (!dose || dose.phasen !== 1) return '';
  return `Erkannt: ${dose.name} — hier sind ein Ampere ${formatPower(dose.wattProAmpere)} `
    + `statt ${formatPower(DREHSTROM_W_PRO_A)}. Laenger mit hohem Strom zu laden belastet `
    + 'eine Haushaltsleitung stark.';
}

/**
 * Der Hinweis fuer den Abend.
 *
 * Ist die Sonne weg und geben die Speicher die gut vier Kilowatt fuer den
 * kleinsten dreiphasigen Ladestrom nicht mehr her, bricht die Regelung ab —
 * sonst kaeme der Rest aus dem Netz. An der Haushaltssteckdose reichen dafuer
 * aber schon 1,4 kW. Statt einfach stehen zu bleiben, sagt die App, was dort
 * noch ginge.
 *
 * Im Handbetrieb kommt der Hinweis nicht: Dort ist Netzbezug ausdruecklich
 * gewollt, und es wird gar nicht abgebrochen.
 */
export function umsteckText(regelung) {
  const r = regelung;
  if (!r || r.betriebsart === 'manuell') return '';
  if (!String(r.zustand ?? '').startsWith('pausiert')) return '';
  if (r.anschluss?.phasen !== 3) return '';
  const minA = r.minA || 6;
  if (!isNum(r.verfuegbarW) || r.verfuegbarW < minA * HAUSHALT_W_PRO_A) return '';
  const maxA = r.maxA || 16;
  const moeglichA = Math.min(maxA, Math.floor(r.verfuegbarW / HAUSHALT_W_PRO_A));
  return `Fuer die Starkstromdose reicht es gerade nicht — ${formatPower(r.verfuegbarW)} sind `
    + `weniger als die ${formatPower(minA * DREHSTROM_W_PRO_A)} fuer ${minA} A. An der `
    + `Haushaltssteckdose waeren es ${moeglichA} A. Zum Weiterladen dort umstecken.`;
}
