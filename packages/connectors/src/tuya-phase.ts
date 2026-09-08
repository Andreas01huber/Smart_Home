/**
 * Die acht Bytes hinter `phase_a`.
 *
 * Tuya überträgt diesen Datenpunkt als `raw`, also base64-kodierte Rohbytes.
 * Die Aufteilung stammt nicht aus einem Datenblatt, sondern aus dem Abgleich
 * mit der Anlage: `08 d8 00 24 54 00 08 39` ergibt 226,4 V, 9,30 A und 2105 W —
 * und exakt dieselben 2105 W meldete `power_total` im selben Moment. Drei
 * unabhängige Zahlen, die zusammenpassen, sind Beweis genug.
 *
 *   Byte 0-1   Spannung in Zehntelvolt
 *   Byte 2-4   Strom in Milliampere
 *   Byte 5-7   Wirkleistung in Watt
 *
 * Warum das wichtig ist: `power_total` aktualisiert sich unregelmässig und
 * steht auch mal minutenlang still, `phase_a` dagegen alle paar Sekunden. Und
 * der Strom hier ist der TATSÄCHLICH fliessende — nicht der eingestellte. Bei
 * gesetzten 10 A zog das Fahrzeug 9,3 A; wer mit der Einstellung rechnet, liegt
 * um sieben Prozent daneben.
 */
export interface Phasenmesswert {
  readonly spannungV: number;
  readonly stromA: number;
  readonly leistungW: number;
}

export function entschluessblePhase(roh: unknown): Phasenmesswert | null {
  if (typeof roh !== 'string' || roh === '') return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(roh, 'base64');
  } catch {
    return null;
  }
  if (bytes.length < 8) return null;
  const spannungV = bytes.readUInt16BE(0) / 10;
  const stromA = ((bytes[2] as number) * 65536 + (bytes[3] as number) * 256 + (bytes[4] as number)) / 1000;
  const leistungW = (bytes[5] as number) * 65536 + (bytes[6] as number) * 256 + (bytes[7] as number);
  if (!Number.isFinite(spannungV) || !Number.isFinite(stromA) || !Number.isFinite(leistungW)) {
    return null;
  }
  return { spannungV, stromA, leistungW };
}

/**
 * Wie viele Phasen liefern gerade Leistung?
 *
 * Diese Wallbox misst nur eine Phase (`phase_a`), meldet aber in `power_total`
 * die Summe über alle. Das Verhältnis der beiden sagt alles:
 *
 *     einphasig    power_total ≈ 1 × (U × I)
 *     dreiphasig   power_total ≈ 3 × (U × I)
 *
 * An der Anlage gemessen: 226,4 V × 9,30 A = 2105 W, power_total = 2105 W,
 * Verhältnis 1,0 — Haushaltssteckdose. Das ist keine Schätzung über
 * zurückgerechnete Spannungen mehr, sondern eine Division zweier gemessener
 * Grössen.
 *
 * `null`, solange zu wenig fliesst: Bei ein paar Watt Grundrauschen wäre das
 * Verhältnis Zufall.
 */
export function phasenAusMessung(
  phase: Phasenmesswert | null,
  gesamtleistungW: number | null,
): 1 | 3 | null {
  if (phase === null || gesamtleistungW === null) return null;
  const einePhaseW = phase.spannungV * phase.stromA;
  // Unter 300 W ist das Verhältnis nicht belastbar — das ist weniger als ein
  // Zehntel dessen, was schon der kleinste Ladestrom bewegt.
  if (einePhaseW < 300 || gesamtleistungW < 300) return null;
  const verhaeltnis = gesamtleistungW / einePhaseW;
  if (verhaeltnis < 1.5) return 1;
  if (verhaeltnis > 2.5) return 3;
  // Dazwischen ist es weder das eine noch das andere — dann lieber nichts sagen.
  return null;
}
