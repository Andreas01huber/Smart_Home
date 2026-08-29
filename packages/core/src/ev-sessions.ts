/**
 * Ladevorgänge (Sessions) und die Frage: Woher kam der Strom?
 *
 * ── Warum eine anteilige Zuordnung ──────────────────────────────────────────
 * Strom ist nicht markierbar. Wenn gleichzeitig PV erzeugt, die Batterie
 * entlädt und Netz bezogen wird, lässt sich physikalisch NICHT messen, welches
 * Elektron ins Auto geflossen ist. Jede Aufteilung ist deshalb ein Modell.
 *
 * Verwendet wird das übliche und nachvollziehbare Mischungsmodell: In jedem
 * Messintervall wird die Ladeenergie des Autos im Verhältnis der zeitgleich
 * VERFÜGBAREN Quellen aufgeteilt.
 *
 *   pvToLoad = PV − Einspeisung − Batterieladung        (was PV an Lasten liefert)
 *   supply   = pvToLoad + Netzbezug + Σ Batterieentladung
 *   Anteil_x = Quelle_x / supply
 *
 * Aus der Energiebilanz folgt supply == Hausverbrauch, die Anteile ergeben also
 * zusammen genau die Ladeenergie. Die Wallbox hängt hinter dem Hauszähler, ihre
 * Leistung ist im Hausverbrauch bereits enthalten — es wird nichts addiert (4L).
 *
 * ── Ehrlichkeit vor Vollständigkeit ─────────────────────────────────────────
 * Fehlt ein Messwert oder ist `supply` nicht plausibel (<= 0), wird die Energie
 * dieses Intervalls NICHT geraten, sondern als `unknownWh` ausgewiesen. Die
 * Oberfläche zeigt das offen als „nicht zuordenbar“ an.
 */

/** Momentaufnahme der Energieflüsse, wie sie für eine Zuordnung nötig ist. */
export interface EvFlowSample {
  /** Ladeleistung des Autos in W (>= 0). */
  readonly evW: number;
  readonly pvW: number | null;
  readonly gridImportW: number | null;
  readonly gridExportW: number | null;
  /** Entladeleistung je Speicher (deviceId -> W). */
  readonly batteryDischargeW: Readonly<Record<string, number>>;
  /** Summe der Ladeleistung aller Speicher in W. */
  readonly batteryChargeW: number;
}

/** Aufteilung einer Energiemenge nach Herkunft, in Wh. */
export interface EvEnergySplit {
  readonly pvWh: number;
  readonly gridWh: number;
  /** Je Speicher-Gerät (deviceId -> Wh). */
  readonly batteryWh: Readonly<Record<string, number>>;
  /** Nicht zuordenbar (fehlende Messwerte oder unplausible Bilanz). */
  readonly unknownWh: number;
}

export function emptySplit(): EvEnergySplit {
  return { pvWh: 0, gridWh: 0, batteryWh: {}, unknownWh: 0 };
}

/**
 * Teilt die im Intervall geladene Energie (evW · hours) nach Herkunft auf.
 *
 * Gibt niemals geschätzte Werte zurück: Was nicht sauber bestimmbar ist,
 * landet vollständig in `unknownWh`.
 */
export function attributeEvEnergy(sample: EvFlowSample, hours: number): EvEnergySplit {
  const evWh = Math.max(0, sample.evW) * hours;
  if (evWh <= 0 || !Number.isFinite(evWh)) return emptySplit();

  const { pvW, gridImportW, gridExportW } = sample;
  // Ohne vollständige Messwerte wird nicht zugeordnet.
  if (pvW === null || gridImportW === null || gridExportW === null) {
    return { ...emptySplit(), unknownWh: evWh };
  }

  const dischargeEntries = Object.entries(sample.batteryDischargeW).filter(
    ([, w]) => Number.isFinite(w) && w > 0,
  );
  const dischargeTotal = dischargeEntries.reduce((sum, [, w]) => sum + w, 0);

  // Was die PV tatsächlich an Verbraucher liefert: alles, was nicht ins Netz
  // geht und nicht in die Speicher geladen wird.
  const pvToLoad = Math.max(0, pvW - gridExportW - Math.max(0, sample.batteryChargeW));
  const supply = pvToLoad + Math.max(0, gridImportW) + dischargeTotal;

  if (!(supply > 0)) return { ...emptySplit(), unknownWh: evWh };

  const batteryWh: Record<string, number> = {};
  for (const [deviceId, w] of dischargeEntries) {
    batteryWh[deviceId] = (evWh * w) / supply;
  }

  return {
    pvWh: (evWh * pvToLoad) / supply,
    gridWh: (evWh * Math.max(0, gridImportW)) / supply,
    batteryWh,
    unknownWh: 0,
  };
}

/** Zwei Aufteilungen zusammenzählen (für Sessions und Zeiträume). */
export function addSplit(a: EvEnergySplit, b: EvEnergySplit): EvEnergySplit {
  const batteryWh: Record<string, number> = { ...a.batteryWh };
  for (const [id, wh] of Object.entries(b.batteryWh)) {
    batteryWh[id] = (batteryWh[id] ?? 0) + wh;
  }
  return {
    pvWh: a.pvWh + b.pvWh,
    gridWh: a.gridWh + b.gridWh,
    batteryWh,
    unknownWh: a.unknownWh + b.unknownWh,
  };
}

/** Summe aller zugeordneten und nicht zugeordneten Anteile. */
export function splitTotalWh(split: EvEnergySplit): number {
  return (
    split.pvWh +
    split.gridWh +
    split.unknownWh +
    Object.values(split.batteryWh).reduce((sum, wh) => sum + wh, 0)
  );
}

/** Warum ein Ladevorgang endete. */
export type ChargeSessionEnd =
  | 'unplugged' // Fahrzeug abgesteckt (Normalfall)
  | 'finished' // Ladegerät meldet "beendet"
  | 'fault' // Störung
  | 'interrupted' // Verbindung zum Ladegerät ging verloren
  | null; // läuft noch

/**
 * Ein Ladevorgang: vom Anstecken bis zum Abstecken.
 *
 * Zeiten als ISO-Zeichenketten, damit sie unverändert gespeichert und wieder
 * geladen werden können.
 */
export interface ChargeSession {
  readonly id: string;
  /** Fahrzeug angesteckt. */
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Sekunden, in denen tatsächlich geladen wurde. */
  readonly chargingSeconds: number;
  /** Sekunden, die das Fahrzeug insgesamt angesteckt war. */
  readonly connectedSeconds: number;
  /** Geladene Energie, aus der Leistung integriert (P·t). */
  readonly energyWh: number;
  readonly maxPowerW: number;
  /** Durchschnitt über die Ladezeit (nicht über die Steckzeit). */
  readonly avgPowerW: number | null;
  /** Vom Ladegerät nicht lieferbar (IEC 61851) — bleibt null. */
  readonly socStartPercent: number | null;
  readonly socEndPercent: number | null;
  readonly split: EvEnergySplit;
  readonly endReason: ChargeSessionEnd;
  readonly faultText: string | null;
  /** true, wenn während des Ladens Messwerte fehlten. */
  readonly hasGaps: boolean;
}
