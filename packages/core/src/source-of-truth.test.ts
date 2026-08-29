import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { ConnectorReading, PowerMetric, Provenance } from './model.ts';
import { resolveSnapshot, type SourceMapping } from './source-of-truth.ts';

function prov(connectorId: string): Provenance {
  return {
    connectorId,
    deviceId: 'test',
    measuredAt: new Date(),
    ageMs: 0,
    quality: 'live',
  };
}

function metric(connectorId: string, valueW: number | null): PowerMetric {
  return { valueW, provenance: prov(connectorId) };
}

function reading(
  connectorId: string,
  values: Partial<Record<'solar' | 'house' | 'import' | 'export', number | null>>,
): ConnectorReading {
  return {
    connectorId,
    timestamp: new Date(),
    solarProductionW:
      values.solar === undefined ? null : metric(connectorId, values.solar),
    houseConsumptionW:
      values.house === undefined ? null : metric(connectorId, values.house),
    gridImportW:
      values.import === undefined ? null : metric(connectorId, values.import),
    gridExportW:
      values.export === undefined ? null : metric(connectorId, values.export),
    batteries: [],
  };
}

const MAPPING: SourceMapping = {
  solarProductionW: 'fronius-local',
  houseConsumptionW: 'fronius-local',
  gridImportW: 'fronius-local',
  gridExportW: 'fronius-local',
};

describe('resolveSnapshot — Doppelzählung ausschließen (4L)', () => {
  test('addiert überlappende Messungen niemals', () => {
    const result = resolveSnapshot(
      [
        reading('fronius-local', { house: 3800, import: 0, export: 800, solar: 9200 }),
        // Victron misst dieselben Flüsse. Würde man addieren, käme 7600 W heraus.
        reading('victron-mqtt', { house: 3800, import: 0, export: 800, solar: 0 }),
      ],
      MAPPING,
    );

    assert.equal(result.snapshot.houseConsumptionW.valueW, 3800);
    assert.equal(result.snapshot.gridExportW.valueW, 800);
  });

  test('nimmt den Wert der maßgeblichen Quelle, nicht den erstbesten', () => {
    const result = resolveSnapshot(
      [
        reading('victron-mqtt', { solar: 1111 }),
        reading('fronius-local', { solar: 9200 }),
      ],
      MAPPING,
    );

    assert.equal(result.snapshot.solarProductionW.valueW, 9200);
    assert.equal(result.snapshot.solarProductionW.provenance.connectorId, 'fronius-local');
  });

  test('setzt keinen Ersatzwert ein, wenn die maßgebliche Quelle schweigt', () => {
    const result = resolveSnapshot(
      [
        reading('fronius-local', { solar: null }),
        reading('victron-mqtt', { solar: 4200 }),
      ],
      MAPPING,
    );

    assert.equal(result.snapshot.solarProductionW.valueW, null);
    assert.ok(result.unavailable.includes('solarProductionW'));
  });

  test('meldet Widersprüche zwischen den Quellen für die Diagnose', () => {
    const result = resolveSnapshot(
      [
        reading('fronius-local', { house: 3800 }),
        reading('victron-mqtt', { house: 1200 }),
      ],
      MAPPING,
    );

    assert.equal(result.disagreements.length, 1);
    const [first] = result.disagreements;
    assert.equal(first?.metric, 'houseConsumptionW');
    assert.equal(first?.authoritative, 'fronius-local');
    assert.equal(first?.other, 'victron-mqtt');
  });

  test('ignoriert Abweichungen im Rauschbereich', () => {
    const result = resolveSnapshot(
      [
        reading('fronius-local', { house: 20 }),
        reading('victron-mqtt', { house: 50 }),
      ],
      MAPPING,
    );

    assert.equal(result.disagreements.length, 0);
  });

  test('summiert PV verschiedener Wechselrichter, ohne den Netzwert zu addieren', () => {
    const mapping: SourceMapping = {
      solarProductionW: ['fronius-local', 'fronius-gen24'],
      gridImportW: 'fronius-gen24',
      gridExportW: 'fronius-gen24',
      houseConsumptionW: 'derived',
    };
    const result = resolveSnapshot(
      [
        reading('fronius-local', { solar: 601 }),
        reading('fronius-gen24', { solar: 1362, import: 0, export: 1518 }),
        reading('victron-modbus', { solar: 601, import: 0, export: 1501 }),
      ],
      mapping,
    );

    // PV: 601 + 1362 = 1963. Der Victron-Wert (ebenfalls der Symo) wird NICHT addiert.
    assert.equal(result.snapshot.solarProductionW.valueW, 1963);
    assert.equal(result.snapshot.solarProductionW.provenance.connectorId, 'sum');
    // Netz kommt aus genau einer Quelle.
    assert.equal(result.snapshot.gridExportW.valueW, 1518);
  });

  test('berechnet den Hausverbrauch, wenn kein Gerät ihn misst', () => {
    const mapping: SourceMapping = {
      solarProductionW: ['fronius-local', 'fronius-gen24'],
      gridImportW: 'fronius-gen24',
      gridExportW: 'fronius-gen24',
      houseConsumptionW: 'derived',
    };
    const result = resolveSnapshot(
      [
        reading('fronius-local', { solar: 601 }),
        reading('fronius-gen24', { solar: 1362, import: 0, export: 1510 }),
      ],
      mapping,
    );
    // Verbrauch = 1963 PV + 0 Bezug - 1510 Einspeisung = 453 W
    assert.equal(result.snapshot.houseConsumptionW.valueW, 453);
    assert.equal(result.snapshot.houseConsumptionW.provenance.connectorId, 'derived');
    assert.equal(result.derivedConsumptionNegative, false);
  });

  test('meldet nicht erfasste Erzeugung, wenn berechneter Verbrauch negativ wäre', () => {
    const mapping: SourceMapping = {
      solarProductionW: 'fronius-gen24',
      gridImportW: 'fronius-gen24',
      gridExportW: 'fronius-gen24',
      houseConsumptionW: 'derived',
    };
    const result = resolveSnapshot(
      [reading('fronius-gen24', { solar: 1362, import: 0, export: 1510 })],
      mapping,
    );
    // Nur GEN24-PV (1362) erfasst, aber 1510 eingespeist -> Rest -148 -> Erzeugung fehlt.
    assert.equal(result.snapshot.houseConsumptionW.valueW, 0);
    assert.equal(result.derivedConsumptionNegative, true);
  });

  test('führt Batterien zusammen, statt sie aufzulösen', () => {
    const froniusBattery = {
      deviceId: 'fronius-bat-0',
      displayName: 'Kleiner Speicher',
      socPercent: 86,
      chargeW: 1700,
      dischargeW: 0,
      storedEnergyWh: 10_320,
      usableCapacityWh: 12_000,
      ratedCapacityWh: 12_000,
      state: 'charging' as const,
      provenance: prov('fronius-local'),
    };
    const victronBattery = {
      ...froniusBattery,
      deviceId: 'victron-bat-0',
      displayName: 'Großer Speicher',
      usableCapacityWh: 50_000,
      provenance: prov('victron-mqtt'),
    };

    const result = resolveSnapshot(
      [
        { ...reading('fronius-local', {}), batteries: [froniusBattery] },
        { ...reading('victron-mqtt', {}), batteries: [victronBattery] },
      ],
      MAPPING,
    );

    assert.equal(result.snapshot.batteries.length, 2);
  });
});
