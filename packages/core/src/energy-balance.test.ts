import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkEnergyBalance } from './energy-balance.ts';
import type { EnergySnapshot, PowerMetric, Provenance } from './model.ts';

const PROV: Provenance = {
  connectorId: 'test',
  deviceId: 'test',
  measuredAt: new Date(),
  ageMs: 0,
  quality: 'live',
};

const m = (valueW: number | null): PowerMetric => ({ valueW, provenance: PROV });

function snapshot(values: {
  solar: number | null;
  house: number | null;
  gridImport: number | null;
  gridExport: number | null;
  charge?: number;
  discharge?: number;
}): EnergySnapshot {
  return {
    timestamp: new Date(),
    solarProductionW: m(values.solar),
    houseConsumptionW: m(values.house),
    gridImportW: m(values.gridImport),
    gridExportW: m(values.gridExport),
    evCharger: null,
    batteries:
      values.charge === undefined && values.discharge === undefined
        ? []
        : [
            {
              deviceId: 'b',
              displayName: 'Speicher',
              socPercent: 50,
              chargeW: values.charge ?? 0,
              dischargeW: values.discharge ?? 0,
              storedEnergyWh: null,
              usableCapacityWh: null,
              ratedCapacityWh: null,
              state: 'idle',
              provenance: PROV,
            },
          ],
  };
}

describe('checkEnergyBalance', () => {
  test('stimmige Bilanz gilt als ok', () => {
    const result = checkEnergyBalance(
      snapshot({ solar: 9200, house: 3800, gridImport: 0, gridExport: 2500, charge: 2900 }),
    );
    assert.equal(result.verdict, 'ok');
    assert.equal(result.message, null);
  });

  test('erkennt nicht erfasste Erzeugung — der reale Fall dieser Anlage', () => {
    // Gemessen am 18.08.2026: PV 990 W, Haus 18 W, Einspeisung 2641 W.
    // Der GEN24 speist ein, wird aber von keiner Quelle erfasst.
    const result = checkEnergyBalance(
      snapshot({ solar: 990, house: 18, gridImport: 0, gridExport: 2641 }),
    );
    assert.equal(result.verdict, 'unmeasured-generation');
    assert.equal(result.residualW, 990 - 2659);
    assert.match(result.message ?? '', /mehr abgegeben als erfasst erzeugt/);
  });

  test('erkennt nicht erfassten Verbrauch', () => {
    const result = checkEnergyBalance(
      snapshot({ solar: 5000, house: 100, gridImport: 0, gridExport: 200 }),
    );
    assert.equal(result.verdict, 'unmeasured-consumption');
  });

  test('urteilt nicht, solange eine Größe fehlt', () => {
    const result = checkEnergyBalance(
      snapshot({ solar: 990, house: null, gridImport: 0, gridExport: 2641 }),
    );
    assert.equal(result.verdict, 'incomplete');
    assert.equal(result.residualW, null);
  });

  test('toleriert kleine Abweichungen zwischen nicht synchronen Messungen', () => {
    const result = checkEnergyBalance(
      snapshot({ solar: 5000, house: 4900, gridImport: 0, gridExport: 0 }),
    );
    assert.equal(result.verdict, 'ok');
  });
});
