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
