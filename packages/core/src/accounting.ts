/**
 * Energy Accounting (Anforderungen 24, 26, 27, 30–34, 42).
 *
 * Reine Funktionen auf akkumulierten Energiemengen (Wh). Kein Zustand, keine
 * Uhr, keine I/O — damit vollständig testbar.
 *
 * Woher eine Kilowattstunde kam, misst keine Anlage. Die Zuordnung hier ist ein
 * MODELL, und sie wird auch so ausgewiesen: je gültigem Messintervall nach einer
 * festen, dokumentierten Rangfolge (`zuordneIntervall`), nicht nachträglich aus
 * Tagessummen zurückgerechnet. Was sich nicht zuordnen lässt, bleibt "nicht
 * zuordenbar" — es wird nicht passend gemacht.
 */

/** Messdauer je Grundgrösse in Sekunden. */
export interface AbdeckungJeGroesse {
  readonly pv: number;
  readonly haus: number;
  readonly bezug: number;
  readonly einspeisung: number;
}

/**
 * Wohin welche Energie im Modell floss, in Wh.
 *
 * Nur aus Intervallen, in denen PV, Haus, Netz und alle Speicher gemessen
 * wurden. "Haus" ist der Hauszähler, das Auto also eingeschlossen.
 */
export interface Zuordnung {
  readonly hausAusPvWh: number;
  readonly hausAusSpeicherWh: number;
  readonly hausAusNetzWh: number;
  readonly speicherAusPvWh: number;
  readonly speicherAusNetzWh: number;
  /** Ein Speicher lädt, während ein anderer entlädt. */
  readonly speicherAusSpeicherWh: number;
  readonly netzAusPvWh: number;
  readonly netzAusSpeicherWh: number;
  /** Quellenseitiger Rest, der sich keiner Senke zuordnen liess. */
  readonly nichtZuordenbarWh: number;
}

/** Über einen Zeitraum (z. B. einen Tag) integrierte Energiemengen in Wh. */
export interface EnergyTotals {
  readonly productionWh: number;
  /** Erzeugung je Wechselrichter, Schlüssel = Connector-ID. */
  readonly perInverterWh: Readonly<Record<string, number>>;
  /** Hauszähler — das Auto ist darin enthalten. */
  readonly houseConsumptionWh: number;
  readonly gridImportWh: number;
  readonly gridExportWh: number;
  /** Ladung je Speicher, Schlüssel = Geräte-ID. */
  readonly batteryChargeWh: Readonly<Record<string, number>>;
  readonly batteryDischargeWh: Readonly<Record<string, number>>;
  readonly evChargeWh: number;
  /**
   * Sekunden, in denen PV, Haus, Bezug und Einspeisung gleichzeitig aktuell
   * gemessen wurden. Fehlt das Feld (Altbestand), ist die Abdeckung unbekannt.
   */
  readonly coveredSeconds?: number;
  /** Messdauer je Grundgrösse — für die Frage, ob Quoten vergleichbar sind. */
  readonly abdeckungJeGroesseS?: AbdeckungJeGroesse;
  /** Erster Messzeitpunkt im Zeitraum (ms). Davor wurde nicht aufgezeichnet. */
  readonly erfasstAbMs?: number | null;
  /** Modellierte Herkunft, nur aus vollständig gemessenen Intervallen. */
  readonly zuordnung?: Zuordnung;
  /**
   * Tagessummen laut Gerätezählern — die zweite, unabhängige Wahrheit.
   *
   * Zählerdifferenzen überstehen Ausfälle des Servers; die integrierten Werte
   * oben nicht. Wo beide da sind, ist die Differenz ein Mass für die Lücke.
   * `null` je Grösse, wenn kein Gerät einen passenden Zähler führt.
   */
  readonly zaehler?: Zaehlersummen;
}

/** Energiemengen aus Zählerdifferenzen über den Zeitraum, in Wh. */
export interface Zaehlersummen {
  readonly pvWh: number | null;
  readonly pvJeWechselrichterWh: Readonly<Record<string, number>>;
  readonly bezugWh: number | null;
  readonly einspeisungWh: number | null;
  readonly autoWh: number | null;
}

export function leereZaehlersummen(): Zaehlersummen {
  return { pvWh: null, pvJeWechselrichterWh: {}, bezugWh: null, einspeisungWh: null, autoWh: null };
}

/** Zählersummen addieren; eine Grösse ist nur bekannt, wenn beide Seiten sie kennen. */
export function addiereZaehlersummen(a: Zaehlersummen, b: Zaehlersummen): Zaehlersummen {
  const beide = (x: number | null, y: number | null): number | null =>
    x === null || y === null ? null : x + y;
  const je: Record<string, number> = { ...a.pvJeWechselrichterWh };
  for (const [k, v] of Object.entries(b.pvJeWechselrichterWh)) je[k] = (je[k] ?? 0) + v;
  return {
    pvWh: beide(a.pvWh, b.pvWh),
    pvJeWechselrichterWh: je,
    bezugWh: beide(a.bezugWh, b.bezugWh),
    einspeisungWh: beide(a.einspeisungWh, b.einspeisungWh),
    autoWh: beide(a.autoWh, b.autoWh),
  };
}

export function leereZuordnung(): Zuordnung {
  return {
    hausAusPvWh: 0,
    hausAusSpeicherWh: 0,
    hausAusNetzWh: 0,
    speicherAusPvWh: 0,
    speicherAusNetzWh: 0,
    speicherAusSpeicherWh: 0,
    netzAusPvWh: 0,
    netzAusSpeicherWh: 0,
    nichtZuordenbarWh: 0,
  };
}

export function emptyTotals(): EnergyTotals {
  return {
    productionWh: 0,
    perInverterWh: {},
    houseConsumptionWh: 0,
    gridImportWh: 0,
    gridExportWh: 0,
    batteryChargeWh: {},
    batteryDischargeWh: {},
    evChargeWh: 0,
    coveredSeconds: 0,
    abdeckungJeGroesseS: { pv: 0, haus: 0, bezug: 0, einspeisung: 0 },
    erfasstAbMs: null,
    zuordnung: leereZuordnung(),
  };
}

/** Wie lückenlos ein Zeitraum gemessen wurde. */
export interface Abdeckung {
  /** `false` bei Altbestand ohne Abdeckungsdaten. */
  readonly bekannt: boolean;
  readonly coveredSeconds: number;
  /** Zeitraum, auf den sich die Abdeckung bezieht. */
  readonly zeitraumSeconds: number;
  readonly gapSeconds: number;
  readonly percent: number | null;
  readonly erfasstAbMs: number | null;
}

/**
 * Abdeckung eines Zeitraums.
 *
 * Der Nenner ist fest: heute vom lokalen Tagesbeginn bis jetzt, abgeschlossene
 * Tage über ihre tatsächliche Dauer (23, 24 oder 25 Stunden). Zeit vor Beginn
 * der Aufzeichnung ist deshalb keine Messung, sondern Lücke — die Oberfläche
 * nennt dazu separat, seit wann aufgezeichnet wird.
 *
 * Tage aus der Zeit vor dieser Rechnung haben keine Abdeckungsdaten; sie
 * bekommen "unbekannt" statt einer erfundenen 100 %.
 */
export function coverage(totals: EnergyTotals, zeitraumSeconds: number): Abdeckung {
  const bekannt = typeof totals.coveredSeconds === 'number' && Number.isFinite(totals.coveredSeconds);
  const covered = bekannt ? Math.max(0, totals.coveredSeconds ?? 0) : 0;
  const zeitraum = Math.max(0, zeitraumSeconds);
  return {
    bekannt,
    coveredSeconds: Math.min(covered, zeitraum),
    zeitraumSeconds: zeitraum,
    gapSeconds: bekannt ? Math.max(0, zeitraum - covered) : 0,
    percent: bekannt && zeitraum > 0 ? clampPercent((covered / zeitraum) * 100) : null,
    erfasstAbMs: typeof totals.erfasstAbMs === 'number' ? totals.erfasstAbMs : null,
  };
}

function nichtnegativ(wert: unknown): wert is number {
  return typeof wert === 'number' && Number.isFinite(wert) && wert >= 0;
}

function pruefeEnergieRecord(roh: unknown): Record<string, number> | null {
  if (typeof roh !== 'object' || roh === null || Array.isArray(roh)) return null;
  const aus: Record<string, number> = {};
  for (const [k, v] of Object.entries(roh)) {
    if (!nichtnegativ(v)) return null;
    aus[k] = v;
  }
  return aus;
}

const ZUORDNUNG_FELDER = Object.keys(leereZuordnung()) as (keyof Zuordnung)[];

/**
 * Gespeicherte Summen prüfen, bevor ihnen geglaubt wird.
 *
 * Gültiges JSON ist noch keine gültige Tagessumme: Ein `"productionWh": -3`
 * oder ein Text statt einer Zahl liesse sich bisher unbemerkt einlesen und
 * rechnete danach in Autarkie und Kosten mit. Hier wird Feld für Feld geprüft;
 * was nicht stimmt, macht die ganze Summe unbrauchbar (`null`). Optionale
 * Felder aus neueren Fassungen dürfen fehlen, aber nicht falsch sein.
 */
export function pruefeTotals(roh: unknown): EnergyTotals | null {
  if (typeof roh !== 'object' || roh === null || Array.isArray(roh)) return null;
  const r = roh as Record<string, unknown>;
  for (const feld of ['productionWh', 'houseConsumptionWh', 'gridImportWh', 'gridExportWh', 'evChargeWh']) {
    if (!nichtnegativ(r[feld])) return null;
  }
  const perInverterWh = pruefeEnergieRecord(r['perInverterWh'] ?? {});
  const batteryChargeWh = pruefeEnergieRecord(r['batteryChargeWh'] ?? {});
  const batteryDischargeWh = pruefeEnergieRecord(r['batteryDischargeWh'] ?? {});
  if (perInverterWh === null || batteryChargeWh === null || batteryDischargeWh === null) return null;

  let abdeckung: AbdeckungJeGroesse | undefined;
  if (r['abdeckungJeGroesseS'] !== undefined) {
    const a = r['abdeckungJeGroesseS'] as Record<string, unknown>;
    if (typeof a !== 'object' || a === null) return null;
    if (![a['pv'], a['haus'], a['bezug'], a['einspeisung']].every(nichtnegativ)) return null;
    abdeckung = a as unknown as AbdeckungJeGroesse;
  }
  let zuordnung: Zuordnung | undefined;
  if (r['zuordnung'] !== undefined) {
    const z = r['zuordnung'] as Record<string, unknown>;
    if (typeof z !== 'object' || z === null) return null;
    if (!ZUORDNUNG_FELDER.every((f) => nichtnegativ(z[f]))) return null;
    zuordnung = Object.fromEntries(ZUORDNUNG_FELDER.map((f) => [f, z[f]])) as unknown as Zuordnung;
  }
  if (r['coveredSeconds'] !== undefined && !nichtnegativ(r['coveredSeconds'])) return null;
  const erfasstAb = r['erfasstAbMs'];
  if (erfasstAb !== undefined && erfasstAb !== null && !nichtnegativ(erfasstAb)) return null;

  let zaehler: Zaehlersummen | undefined;
  if (r['zaehler'] !== undefined) {
    const z = r['zaehler'] as Record<string, unknown>;
    if (typeof z !== 'object' || z === null) return null;
    const optional = (w: unknown): number | null | false =>
      w === null || w === undefined ? null : nichtnegativ(w) ? w : false;
    const pv = optional(z['pvWh']);
    const bezug = optional(z['bezugWh']);
    const einspeisung = optional(z['einspeisungWh']);
    const auto = optional(z['autoWh']);
    const je = pruefeEnergieRecord(z['pvJeWechselrichterWh'] ?? {});
    if (pv === false || bezug === false || einspeisung === false || auto === false || je === null) return null;
    zaehler = { pvWh: pv, pvJeWechselrichterWh: je, bezugWh: bezug, einspeisungWh: einspeisung, autoWh: auto };
  }

  return {
    productionWh: r['productionWh'] as number,
    perInverterWh,
    houseConsumptionWh: r['houseConsumptionWh'] as number,
    gridImportWh: r['gridImportWh'] as number,
    gridExportWh: r['gridExportWh'] as number,
    batteryChargeWh,
    batteryDischargeWh,
    evChargeWh: r['evChargeWh'] as number,
    ...(r['coveredSeconds'] !== undefined ? { coveredSeconds: r['coveredSeconds'] as number } : {}),
    ...(abdeckung !== undefined ? { abdeckungJeGroesseS: abdeckung } : {}),
    ...(erfasstAb !== undefined ? { erfasstAbMs: erfasstAb as number | null } : {}),
    ...(zuordnung !== undefined ? { zuordnung } : {}),
    ...(zaehler !== undefined ? { zaehler } : {}),
  };
}

function sumValues(record: Readonly<Record<string, number>>): number {
  let sum = 0;
  for (const value of Object.values(record)) sum += value;
  return sum;
}

export function totalBatteryChargeWh(t: EnergyTotals): number {
  return sumValues(t.batteryChargeWh);
}

export function totalBatteryDischargeWh(t: EnergyTotals): number {
  return sumValues(t.batteryDischargeWh);
}

/**
 * Autarkiegrad: Anteil des Verbrauchs, der NICHT aus dem Netz kam.
 *
 *   Autarkie = 1 - Netzbezug / Gesamtverbrauch
 */
export function autarkyPercent(t: EnergyTotals): number | null {
  if (t.houseConsumptionWh <= 0) return null;
  const value = 1 - t.gridImportWh / t.houseConsumptionWh;
  return clampPercent(value * 100);
}

/**
 * Eigenverbrauchsquote: Anteil der Erzeugung, der selbst genutzt wurde
 * (direkt, Speicher, Auto) statt eingespeist zu werden.
 *
 *   Eigenverbrauch = 1 - Netzeinspeisung / Erzeugung
 */
export function selfConsumptionPercent(t: EnergyTotals): number | null {
  if (t.productionWh <= 0) return null;
  const value = 1 - t.gridExportWh / t.productionWh;
  return clampPercent(value * 100);
}

/**
 * Ab welcher Differenz zwei Messdauern nicht mehr vergleichbar sind.
 *
 * Eine Quote teilt zwei Summen durcheinander. Fehlt einer davon eine Stunde,
 * die der anderen nicht fehlt, ist das Verhältnis falsch — nicht unscharf.
 * Fünf Minuten oder zwei Prozent des Zeitraums sind die Grenze.
 */
const VERGLEICHBAR_ABS_S = 300;
const VERGLEICHBAR_REL = 0.02;

function vergleichbar(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(VERGLEICHBAR_ABS_S, VERGLEICHBAR_REL * Math.max(a, b));
}

export type Quotenstatus = 'vergleichbar' | 'unvollstaendig' | 'abdeckung-unbekannt';

export interface Quote {
  readonly percent: number | null;
  readonly status: Quotenstatus;
}

/**
 * Autarkie und Eigenverbrauch — nur, wenn Zähler und Nenner gleich lang
 * gemessen wurden. Sonst wird die Quote unterdrückt und als unvollständig
 * ausgewiesen.
 */
export function quoten(t: EnergyTotals): { autarkie: Quote; eigenverbrauch: Quote } {
  const je = t.abdeckungJeGroesseS;
  if (je === undefined) {
    return {
      autarkie: { percent: autarkyPercent(t), status: 'abdeckung-unbekannt' },
      eigenverbrauch: { percent: selfConsumptionPercent(t), status: 'abdeckung-unbekannt' },
    };
  }
  const autarkieOk = vergleichbar(je.haus, je.bezug);
  const eigenOk = vergleichbar(je.pv, je.einspeisung);
  return {
    autarkie: autarkieOk
      ? { percent: autarkyPercent(t), status: 'vergleichbar' }
      : { percent: null, status: 'unvollstaendig' },
    eigenverbrauch: eigenOk
      ? { percent: selfConsumptionPercent(t), status: 'vergleichbar' }
      : { percent: null, status: 'unvollstaendig' },
  };
}

/** Energien eines Messintervalls, alle in Wh und nichtnegativ. */
export interface Intervallenergie {
  readonly pv: number;
  readonly haus: number;
  readonly bezug: number;
  readonly einspeisung: number;
  /** Summe aller ladenden Speicher. */
  readonly laden: number;
  /** Summe aller entladenden Speicher. */
  readonly entladen: number;
}

/**
 * Zuordnung eines Messintervalls — das Herkunftsmodell.
 *
 * Rangfolge, in genau dieser Reihenfolge und jeweils höchstens so viel, wie
 * Quelle UND Senke noch hergeben:
 *
 *   1. PV → Haus          4. Speicher → Haus       7. Netz → Haus
 *   2. PV → Speicher      5. Speicher → Netz       8. Netz → Speicher
 *   3. PV → Netz          6. Speicher → Speicher
 *
 * Damit gilt je Senke: Summe ihrer Teile ≤ gemessene Senke, und je Quelle
 * dasselbe. Was übrig bleibt, ist Messungenauigkeit oder ein unerfasster
 * Erzeuger und steht als `nichtZuordenbarWh` da.
 *
 * Bewusst NICHT modelliert: woher die Energie im Speicher ursprünglich kam.
 * "Speicher → Haus" sagt nicht, dass es Sonnenstrom war — dafür bräuchte es
 * ein eigenes Herkunftsmodell über den Tag hinweg, und das gibt es nicht.
 */
export function zuordneIntervall(e: Intervallenergie): Zuordnung {
  let pv = Math.max(0, e.pv);
  let entladen = Math.max(0, e.entladen);
  let bezug = Math.max(0, e.bezug);
  let haus = Math.max(0, e.haus);
  let laden = Math.max(0, e.laden);
  let einspeisung = Math.max(0, e.einspeisung);

  const nimm = (quelle: number, senke: number): number => Math.min(quelle, senke);

  const hausAusPv = nimm(pv, haus); pv -= hausAusPv; haus -= hausAusPv;
  const speicherAusPv = nimm(pv, laden); pv -= speicherAusPv; laden -= speicherAusPv;
  const netzAusPv = nimm(pv, einspeisung); pv -= netzAusPv; einspeisung -= netzAusPv;
  const hausAusSpeicher = nimm(entladen, haus); entladen -= hausAusSpeicher; haus -= hausAusSpeicher;
  const netzAusSpeicher = nimm(entladen, einspeisung); entladen -= netzAusSpeicher; einspeisung -= netzAusSpeicher;
  const speicherAusSpeicher = nimm(entladen, laden); entladen -= speicherAusSpeicher; laden -= speicherAusSpeicher;
  const hausAusNetz = nimm(bezug, haus); bezug -= hausAusNetz; haus -= hausAusNetz;
  const speicherAusNetz = nimm(bezug, laden); bezug -= speicherAusNetz; laden -= speicherAusNetz;

  return {
    hausAusPvWh: hausAusPv,
    hausAusSpeicherWh: hausAusSpeicher,
    hausAusNetzWh: hausAusNetz,
    speicherAusPvWh: speicherAusPv,
    speicherAusNetzWh: speicherAusNetz,
    speicherAusSpeicherWh: speicherAusSpeicher,
    netzAusPvWh: netzAusPv,
    netzAusSpeicherWh: netzAusSpeicher,
    // Quellenseitiger Rest: Was erzeugt, entladen oder bezogen wurde und
    // keine Senke mehr fand. Senkenseitige Reste zeigen die Auswertungen.
    nichtZuordenbarWh: pv + entladen + bezug,
  };
}

export function addiereZuordnung(a: Zuordnung, b: Zuordnung): Zuordnung {
  return {
    hausAusPvWh: a.hausAusPvWh + b.hausAusPvWh,
    hausAusSpeicherWh: a.hausAusSpeicherWh + b.hausAusSpeicherWh,
    hausAusNetzWh: a.hausAusNetzWh + b.hausAusNetzWh,
    speicherAusPvWh: a.speicherAusPvWh + b.speicherAusPvWh,
    speicherAusNetzWh: a.speicherAusNetzWh + b.speicherAusNetzWh,
    speicherAusSpeicherWh: a.speicherAusSpeicherWh + b.speicherAusSpeicherWh,
    netzAusPvWh: a.netzAusPvWh + b.netzAusPvWh,
    netzAusSpeicherWh: a.netzAusSpeicherWh + b.netzAusSpeicherWh,
    nichtZuordenbarWh: a.nichtZuordenbarWh + b.nichtZuordenbarWh,
  };
}

/** Woraus der Hausverbrauch gedeckt wurde — modelliert, siehe `zuordneIntervall`. */
export interface ConsumptionSources {
  readonly pvDirectWh: number;
  readonly batteryWh: number;
  readonly gridWh: number;
  /** Verbrauch ausserhalb vollständig gemessener Intervalle oder ohne Quelle. */
  readonly nichtZuordenbarWh: number;
  readonly modell: true;
}

/** `null`, wenn es für den Zeitraum keine Intervallzuordnung gibt (Altbestand). */
export function consumptionSources(t: EnergyTotals): ConsumptionSources | null {
  const z = t.zuordnung;
  if (z === undefined) return null;
  const teile = z.hausAusPvWh + z.hausAusSpeicherWh + z.hausAusNetzWh;
  return {
    pvDirectWh: z.hausAusPvWh,
    batteryWh: z.hausAusSpeicherWh,
    gridWh: z.hausAusNetzWh,
    nichtZuordenbarWh: Math.max(0, t.houseConsumptionWh - teile),
    modell: true,
  };
}

/** Wohin die Erzeugung floss — modelliert, siehe `zuordneIntervall`. */
export interface ProductionSinks {
  readonly directWh: number;
  readonly batteryWh: number;
  readonly gridWh: number;
  readonly nichtZuordenbarWh: number;
  readonly modell: true;
}

export function productionSinks(t: EnergyTotals): ProductionSinks | null {
  const z = t.zuordnung;
  if (z === undefined) return null;
  const teile = z.hausAusPvWh + z.speicherAusPvWh + z.netzAusPvWh;
  return {
    directWh: z.hausAusPvWh,
    batteryWh: z.speicherAusPvWh,
    gridWh: z.netzAusPvWh,
    nichtZuordenbarWh: Math.max(0, t.productionWh - teile),
    modell: true,
  };
}

/** Konfigurierbare Stromtarife (29). */
export interface Tariff {
  /** Arbeitspreis Netzbezug in €/kWh. */
  readonly importPricePerKWh: number;
  /** Einspeisevergütung in €/kWh. */
  readonly exportPricePerKWh: number;
  /** Optionale Grundgebühr pro Monat in €. Geht in keine Kostenzahl ein. */
  readonly baseFeePerMonth?: number;
}

export interface CostResult {
  /** Selbst gedeckter Hausverbrauch × Arbeitspreis — nicht gekaufter Strom. */
  readonly savedGridCostEUR: number;
  /** Einspeisung × Vergütung. */
  readonly feedInRevenueEUR: number;
  /** Ersparnis + Einspeiseerlös. */
  readonly totalBenefitEUR: number;
  /** Netzbezug × Arbeitspreis, Speicherladung aus dem Netz eingeschlossen. */
  readonly gridCostActualEUR: number;
  /** Hypothetisch: gesamter Hausverbrauch aus dem Netz. */
  readonly gridCostWithoutSystemEUR: number;
  /**
   * `modell`: aus der Intervallzuordnung. `naeherung`: Altbestand ohne
   * Zuordnung, Ersparnis aus Tagessummen (Verbrauch − Bezug).
   */
  readonly basis: 'modell' | 'naeherung';
  /** Die Grundgebühr ist in keiner dieser Zahlen enthalten. */
  readonly grundgebuehrEnthalten: false;
}

/**
 * Kosten und Ersparnis (30–34).
 *
 * Ersparnis ist der Hausverbrauch, der im Modell aus eigener Erzeugung oder
 * aus dem Speicher kam — abzüglich dessen, was der Speicher vorher aus dem Netz
 * geladen hat. Sonst zählte Netzstrom, der den Umweg über den Speicher nimmt,
 * einmal als Kosten und ein zweites Mal als Ersparnis.
 */
export function computeCosts(t: EnergyTotals, tariff: Tariff): CostResult {
  const z = t.zuordnung;
  const selbstWh = z === undefined
    ? Math.max(0, t.houseConsumptionWh - t.gridImportWh)
    : z.hausAusPvWh + Math.max(0, z.hausAusSpeicherWh - z.speicherAusNetzWh);
  const savedGridCostEUR = (selbstWh / 1000) * tariff.importPricePerKWh;
  const feedInRevenueEUR = (t.gridExportWh / 1000) * tariff.exportPricePerKWh;
  const gridCostActualEUR = (t.gridImportWh / 1000) * tariff.importPricePerKWh;
  const gridCostWithoutSystemEUR =
    (t.houseConsumptionWh / 1000) * tariff.importPricePerKWh;

  return {
    savedGridCostEUR,
    feedInRevenueEUR,
    totalBenefitEUR: savedGridCostEUR + feedInRevenueEUR,
    gridCostActualEUR,
    gridCostWithoutSystemEUR,
    basis: z === undefined ? 'naeherung' : 'modell',
    grundgebuehrEnthalten: false,
  };
}

/** Ein Speicher, so wie ihn die Gesamtrechnung braucht. */
export interface SpeicherMessung {
  readonly usableCapacityWh: number | null;
  readonly socPercent: number | null;
  readonly chargeW?: number | null;
  readonly dischargeW?: number | null;
  /** Ein nicht erreichbarer Speicher zählt als fehlend, nicht als leer. */
  readonly erreichbar?: boolean;
}

/**
 * Was sich über alle Speicher zusammen sagen lässt — und was nicht.
 *
 * Früher zählten nur die liefernden Speicher; fiel einer aus, stand der andere
 * als "Gesamtspeicher" mit vollem Anspruch da. Jetzt sind erwartete und
 * verfügbare Geräte getrennt, und Gesamt-SOC sowie Gesamtleistung gibt es nur,
 * wenn wirklich alle erwarteten Speicher vollständig melden.
 */
export interface SpeicherGesamt {
  readonly erwartet: number;
  readonly verfuegbar: number;
  readonly vollstaendig: boolean;
  /** Bekannte Kapazität der verfügbaren Speicher. */
  readonly kapazitaetBekanntWh: number;
  /** Aktuell bekannte Energie der verfügbaren Speicher. */
  readonly energieBekanntWh: number;
  /** Kapazitätsgewichteter SOC — nur bei Vollständigkeit. */
  readonly socPercent: number | null;
  /** + laden, − entladen — nur bei Vollständigkeit. */
  readonly nettoLeistungW: number | null;
}

function endlich(wert: number | null | undefined): wert is number {
  return typeof wert === 'number' && Number.isFinite(wert);
}

/**
 * Gesamtspeicher, kapazitätsgewichtet (15).
 *
 *   (Kap1 × SOC1 + Kap2 × SOC2) / (Kap1 + Kap2)
 *
 * Ein einfacher Mittelwert wäre falsch, wenn die Kapazitäten stark differieren.
 *
 * @param erwartet Wie viele Speicher es geben sollte. Fehlende werden nicht
 *   mit null aufgefüllt, sondern machen die Gesamtwerte unbekannt.
 */
export function speicherGesamt(
  speicher: readonly SpeicherMessung[],
  erwartet = speicher.length,
): SpeicherGesamt {
  const verfuegbare = speicher.filter((s) => s.erreichbar !== false);
  let kapazitaet = 0;
  let energie = 0;
  let alleMitSoc = true;
  let netto = 0;
  let alleMitLeistung = true;

  for (const s of verfuegbare) {
    if (endlich(s.usableCapacityWh) && s.usableCapacityWh > 0 && endlich(s.socPercent)) {
      kapazitaet += s.usableCapacityWh;
      energie += (clampPercent(s.socPercent) / 100) * s.usableCapacityWh;
    } else {
      alleMitSoc = false;
    }
    const laden = endlich(s.chargeW) ? s.chargeW : null;
    const entladen = endlich(s.dischargeW) ? s.dischargeW : null;
    if (laden === null && entladen === null) alleMitLeistung = false;
    else netto += (laden ?? 0) - (entladen ?? 0);
  }

  const alleDa = verfuegbare.length >= erwartet && verfuegbare.length > 0;
  const vollstaendig = alleDa && alleMitSoc;
  return {
    erwartet: Math.max(erwartet, verfuegbare.length),
    verfuegbar: verfuegbare.length,
    vollstaendig,
    kapazitaetBekanntWh: kapazitaet,
    energieBekanntWh: energie,
    socPercent: vollstaendig && kapazitaet > 0 ? (energie / kapazitaet) * 100 : null,
    nettoLeistungW: alleDa && alleMitLeistung ? netto : null,
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
