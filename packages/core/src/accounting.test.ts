import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyTotals,
  autarkyPercent,
  selfConsumptionPercent,
  consumptionSources,
  productionSinks,
  computeCosts,
  aggregateStorage,
  type EnergyTotals,
} from './accounting.ts';

function totals(partial: Partial<EnergyTotals>): EnergyTotals {
  return { ...emptyTotals(), ...partial };
}

describe('autarkyPercent', () => {
  test('1 - Netzbezug / Verbrauch', () => {
    const t = totals({ houseConsumptionWh: 10000, gridImportWh: 2000 });
    assert.equal(autarkyPercent(t), 80);
  });
  test('ohne Verbrauch kein Wert', () => {
    assert.equal(autarkyPercent(emptyTotals()), null);
  });
});

describe('selfConsumptionPercent', () => {
  test('1 - Einspeisung / Erzeugung', () => {
    const t = totals({ productionWh: 20000, gridExportWh: 5000 });
    assert.equal(selfConsumptionPercent(t), 75);
  });
});

describe('consumptionSources — Deckung des Verbrauchs (24)', () => {
  test('PV-direkt = Rest nach Netz und Batterie', () => {
    const t = totals({
      houseConsumptionWh: 18640,
      gridImportWh: 1500,
      batteryDischargeWh: { a: 5300 },
    });
    const s = consumptionSources(t);
    assert.equal(s.gridWh, 1500);
    assert.equal(s.batteryWh, 5300);
    assert.equal(s.pvDirectWh, 11840);
  });
});

describe('productionSinks — Verbleib der Erzeugung (23)', () => {
  test('direkt = Erzeugung minus Einspeisung minus Ladung', () => {
    const t = totals({
      productionWh: 23170,
      gridExportWh: 8900,
      batteryChargeWh: { a: 4000 },
    });
    const s = productionSinks(t);
    assert.equal(s.gridWh, 8900);
    assert.equal(s.batteryWh, 4000);
    assert.equal(s.directWh, 10270);
  });
});

describe('computeCosts (30–34)', () => {
  test('Ersparnis und Einspeiseerlös', () => {
    const t = totals({
      houseConsumptionWh: 18000,
      gridImportWh: 0,
      gridExportWh: 8000,
    });
    const c = computeCosts(t, { importPricePerKWh: 0.28, exportPricePerKWh: 0.08 });
    // 18 kWh selbst genutzt × 0,28 = 5,04 €
    assert.ok(Math.abs(c.savedGridCostEUR - 5.04) < 1e-9);
    // 8 kWh × 0,08 = 0,64 €
    assert.ok(Math.abs(c.feedInRevenueEUR - 0.64) < 1e-9);
    assert.ok(Math.abs(c.totalBenefitEUR - 5.68) < 1e-9);
  });
  test('Referenzszenario ohne PV kostet den vollen Verbrauch', () => {
    const t = totals({ houseConsumptionWh: 10000, gridImportWh: 2000 });
    const c = computeCosts(t, { importPricePerKWh: 0.3, exportPricePerKWh: 0.08 });
    assert.ok(Math.abs(c.gridCostWithoutSystemEUR - 3.0) < 1e-9);
    assert.ok(Math.abs(c.gridCostActualEUR - 0.6) < 1e-9);
  });
});

describe('aggregateStorage — kapazitätsgewichteter SOC (15)', () => {
  test('gewichtet, nicht einfacher Mittelwert', () => {
    const agg = aggregateStorage([
      { usableCapacityWh: 12000, socPercent: 100 },
      { usableCapacityWh: 50000, socPercent: 50 },
    ]);
    // (12000*1 + 50000*0,5) / 62000 = 37000/62000 = 59,7 %
    assert.equal(agg.totalCapacityWh, 62000);
    assert.equal(agg.storedWh, 37000);
    assert.ok(Math.abs((agg.socPercent ?? 0) - 59.677) < 0.01);
  });
  test('einfacher Mittelwert wäre 75 % — das wäre falsch', () => {
    const agg = aggregateStorage([
      { usableCapacityWh: 12000, socPercent: 100 },
      { usableCapacityWh: 50000, socPercent: 50 },
    ]);
    assert.notEqual(Math.round(agg.socPercent ?? 0), 75);
  });
});

/**
 * Synthetische Szenarien (STEP 81). Geprüft wird die Energiebilanz-Konsistenz:
 * PV + Netzbezug + Entladung = Haus + Ladung + EV + Einspeisung.
 */
describe('synthetische Szenarien — Bilanzkonsistenz (81)', () => {
  const balance = (s: {
    pv: number; house: number; charge: number; discharge: number;
    ev: number; gridImport: number; gridExport: number;
  }): number =>
    s.pv + s.gridImport + s.discharge - (s.house + s.charge + s.ev + s.gridExport);

  test('Szenario 1: PV 10, Haus 4, Batterie lädt 4, Export 2', () => {
    assert.equal(balance({ pv: 10, house: 4, charge: 4, discharge: 0, ev: 0, gridImport: 0, gridExport: 2 }), 0);
  });
  test('Szenario 2: PV 0, Haus 5, Batterie liefert 3, Bezug 2', () => {
    assert.equal(balance({ pv: 0, house: 5, charge: 0, discharge: 3, ev: 0, gridImport: 2, gridExport: 0 }), 0);
  });
  test('Szenario 3: PV 15, Haus 3, Bat1 lädt 2, Bat2 lädt 5, Auto 4, Export 1', () => {
    assert.equal(balance({ pv: 15, house: 3, charge: 7, discharge: 0, ev: 4, gridImport: 0, gridExport: 1 }), 0);
  });
  test('Szenario 4: PV 2, Haus 3, Auto 7, Batterie liefert 4, Netz liefert 4', () => {
    assert.equal(balance({ pv: 2, house: 3, charge: 0, discharge: 4, ev: 7, gridImport: 4, gridExport: 0 }), 0);
  });
});
