/**
 * Tests der Energiequellen-Zuordnung für Ladevorgänge.
 *
 * Kernanspruch: Es wird nie geraten. Was nicht sauber bestimmbar ist, landet
 * vollständig in `unknownWh` — nicht in einer plausibel aussehenden Aufteilung.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addSplit,
  attributeEvEnergy,
  emptySplit,
  splitTotalWh,
  type EvFlowSample,
} from './ev-sessions.ts';

const HOUR = 1;
const base: EvFlowSample = {
  evW: 0,
  pvW: 0,
  gridImportW: 0,
  gridExportW: 0,
  batteryDischargeW: {},
  batteryChargeW: 0,
};
const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

describe('Energiequellen eines Ladevorgangs', () => {
  it('ordnet reinen Netzbezug vollständig dem Netz zu', () => {
    const s = attributeEvEnergy({ ...base, evW: 3000, gridImportW: 3000 }, HOUR);
    close(s.gridWh, 3000);
    close(s.pvWh, 0);
    close(s.unknownWh, 0);
  });

  it('ordnet reines PV-Laden vollständig der PV zu', () => {
    const s = attributeEvEnergy({ ...base, evW: 3000, pvW: 3000 }, HOUR);
    close(s.pvWh, 3000);
    close(s.gridWh, 0);
  });

  it('zählt Einspeisung und Batterieladung NICHT als PV für den Verbrauch', () => {
    // 10 kW PV, davon 4 kW eingespeist und 3 kW in die Batterie -> 3 kW an Lasten.
    const s = attributeEvEnergy(
      { ...base, evW: 3000, pvW: 10_000, gridExportW: 4000, batteryChargeW: 3000 },
      HOUR,
    );
    close(s.pvWh, 3000); // das Auto ist die einzige Last
    close(s.unknownWh, 0);
  });

  it('teilt anteilig auf, wenn mehrere Quellen gleichzeitig liefern', () => {
    // Versorgung: PV 2 kW + Netz 1 kW + Batterie 1 kW = 4 kW, Auto zieht 2 kW.
    const s = attributeEvEnergy(
      {
        ...base,
        evW: 2000,
        pvW: 2000,
        gridImportW: 1000,
        batteryDischargeW: { 'bat-a': 1000 },
      },
      HOUR,
    );
    close(s.pvWh, 1000); // 2/4 von 2000
    close(s.gridWh, 500); // 1/4
    close(s.batteryWh['bat-a'] ?? 0, 500); // 1/4
    close(splitTotalWh(s), 2000); // Summe = geladene Energie
  });

  it('trennt zwei Speicher nach ihrem tatsächlichen Entladeanteil', () => {
    const s = attributeEvEnergy(
      {
        ...base,
        evW: 3000,
        batteryDischargeW: { klein: 1000, gross: 2000 },
      },
      HOUR,
    );
    close(s.batteryWh['klein'] ?? 0, 1000);
    close(s.batteryWh['gross'] ?? 0, 2000);
  });

  it('rät NICHT, wenn ein Messwert fehlt', () => {
    const s = attributeEvEnergy({ ...base, evW: 3000, pvW: null, gridImportW: 500 }, HOUR);
    close(s.unknownWh, 3000);
    close(s.gridWh, 0);
    close(s.pvWh, 0);
  });

  it('rät NICHT, wenn die Bilanz unplausibel ist (keine Versorgung sichtbar)', () => {
    const s = attributeEvEnergy({ ...base, evW: 3000 }, HOUR);
    close(s.unknownWh, 3000);
  });

  it('liefert bei fehlender Ladeleistung eine leere Aufteilung', () => {
    close(splitTotalWh(attributeEvEnergy({ ...base, evW: 0, pvW: 5000 }, HOUR)), 0);
  });

  it('rechnet Teilintervalle korrekt (P·t)', () => {
    // 3 kW über 15 Minuten = 750 Wh
    const s = attributeEvEnergy({ ...base, evW: 3000, gridImportW: 3000 }, 0.25);
    close(s.gridWh, 750);
  });

  it('summiert Aufteilungen über mehrere Intervalle korrekt', () => {
    const a = attributeEvEnergy({ ...base, evW: 2000, gridImportW: 2000 }, HOUR);
    const b = attributeEvEnergy({ ...base, evW: 2000, pvW: 2000 }, HOUR);
    const sum = addSplit(addSplit(emptySplit(), a), b);
    close(sum.gridWh, 2000);
    close(sum.pvWh, 2000);
    close(splitTotalWh(sum), 4000);
  });
});
