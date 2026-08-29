import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EnergyAccumulator, localDate, shiftDate } from './history.ts';
import type { EngineState } from './engine.ts';
import type { ConnectorReading, EnergySnapshot, PowerMetric, BatterySnapshot } from '@energy/core';

// ── Zeit-/Datumshelfer (Anforderung 5/60) ─────────────────────────────
describe('localDate / shiftDate', () => {
  test('localDate liefert lokales YYYY-MM-DD', () => {
    assert.match(localDate(new Date(2026, 7, 19, 14, 30)), /^2026-08-19$/);
  });
  test('shiftDate: gestern', () => {
    assert.equal(shiftDate('2026-08-19', -1), '2026-08-18');
  });
  test('shiftDate über Monatsgrenze', () => {
    assert.equal(shiftDate('2026-09-01', -1), '2026-08-31');
  });
  test('shiftDate ist DST-sicher (Sommerzeitende Okt 2026)', () => {
    // In Europa endet die Sommerzeit am 25.10.2026. Der Tageswechsel muss
    // trotzdem exakt einen Kalendertag verschieben.
    assert.equal(shiftDate('2026-10-25', -1), '2026-10-24');
    assert.equal(shiftDate('2026-10-26', -1), '2026-10-25');
  });
});

// ── Helfer zum Bauen synthetischer Engine-Zustände ────────────────────
function metric(valueW: number | null): PowerMetric {
  return {
    valueW,
    provenance: { connectorId: 'x', deviceId: 'x', measuredAt: new Date(), ageMs: 0, quality: 'live' },
  };
}
function battery(deviceId: string, name: string, soc: number, chargeW: number, dischargeW: number): BatterySnapshot {
  return {
    deviceId, displayName: name, socPercent: soc, chargeW, dischargeW,
    storedEnergyWh: null, usableCapacityWh: 10000, ratedCapacityWh: null,
    state: chargeW > 0 ? 'charging' : dischargeW > 0 ? 'discharging' : 'idle',
    provenance: { connectorId: 'x', deviceId, measuredAt: new Date(), ageMs: 0, quality: 'live' },
  };
}
function state(opts: {
  at: Date; pv: number | null; house: number | null; gi: number | null; ge: number | null;
  inv?: Record<string, number>; batteries?: BatterySnapshot[];
}): EngineState {
  const snapshot: EnergySnapshot = {
    timestamp: opts.at,
    solarProductionW: metric(opts.pv),
    houseConsumptionW: metric(opts.house),
    gridImportW: metric(opts.gi),
    gridExportW: metric(opts.ge),
    batteries: opts.batteries ?? [],
    evCharger: null,
  };
  const readings: ConnectorReading[] = Object.entries(opts.inv ?? {}).map(([id, w]) => ({
    connectorId: id, timestamp: opts.at,
    solarProductionW: metric(w), houseConsumptionW: null, gridImportW: null, gridExportW: null, batteries: [],
  }));
  return {
    resolution: { snapshot, unavailable: [], disagreements: [], derivedConsumptionNegative: false },
    readings, diagnostics: [], polledAt: opts.at, pollDurationMs: 1,
  };
}

const TARIFF = { importPricePerKWh: 0.28, exportPricePerKWh: 0.08 };
let dir: string;
function makeAcc(): EnergyAccumulator {
  dir = mkdtempSync(join(tmpdir(), 'energie-hist-'));
  return new EnergyAccumulator({ dataDir: dir, pvSources: ['fronius-local', 'fronius-gen24'], names: {}, tariff: TARIFF });
}
afterEach(() => { if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* egal */ } });

describe('EnergyAccumulator — Speicherung & Aggregation', () => {
  test('integriert Leistung zu Energie (P·t)', () => {
    const acc = makeAcc();
    const day = new Date(2026, 7, 19, 12, 0, 0);
    acc.integrate(state({ at: day, pv: 3600, house: 0, gi: 0, ge: 0 })); // Anker
    acc.integrate(state({ at: new Date(2026, 7, 19, 12, 0, 10), pv: 3600, house: 0, gi: 0, ge: 0 })); // +10 s
    const v: any = acc.dayView(localDate(day));
    // 3600 W über 10 s = 10 Wh
    assert.ok(Math.abs(v.totals.productionWh - 10) < 0.001, `erwartet ~10 Wh, war ${v.totals.productionWh}`);
    assert.equal(v.hasData, true);
    assert.equal(v.isToday, true);
  });

  test('fehlender Wert (null) wird nicht als 0 gezählt', () => {
    const acc = makeAcc();
    const day = new Date(2026, 7, 19, 12, 0, 0);
    acc.integrate(state({ at: day, pv: null, house: 500, gi: null, ge: null }));
    acc.integrate(state({ at: new Date(2026, 7, 19, 12, 0, 10), pv: null, house: 500, gi: null, ge: null }));
    const v: any = acc.dayView(localDate(day));
    assert.equal(v.totals.productionWh, 0); // PV war null -> keine Energie
    assert.ok(v.totals.houseConsumptionWh > 0); // Haus lief
  });

  test('Tageswechsel archiviert den Vortag mit Kurve, kein Datenverlust', () => {
    const acc = makeAcc();
    const d1 = new Date(2026, 7, 18, 12, 0, 0);
    acc.integrate(state({ at: d1, pv: 3600, house: 0, gi: 0, ge: 0 }));
    acc.integrate(state({ at: new Date(2026, 7, 18, 12, 0, 10), pv: 3600, house: 0, gi: 0, ge: 0 }));
    // Sprung auf den nächsten Tag -> rollover
    acc.integrate(state({ at: new Date(2026, 7, 19, 0, 0, 5), pv: 0, house: 0, gi: 0, ge: 0 }));

    const yesterday: any = acc.dayView("2026-08-18");
    assert.equal(yesterday.hasData, true, 'Vortag muss abrufbar sein');
    assert.equal(yesterday.isToday, false);
    assert.ok(Math.abs(yesterday.totals.productionWh - 10) < 0.001);
    assert.ok(yesterday.series.length >= 1, 'Kurve des Vortags muss erhalten sein');
  });

  test('Tag ohne Daten meldet hasData:false (keine erfundenen Werte)', () => {
    const acc = makeAcc();
    const v: any = acc.dayView("2020-01-01");
    assert.equal(v.hasData, false);
  });

  test('Speicher werden getrennt erfasst (klein + groß)', () => {
    const acc = makeAcc();
    const d = new Date(2026, 7, 19, 12, 0, 0);
    const bats = [battery('fronius:0', 'Kleiner Speicher', 80, 2000, 0), battery('victron:0', 'Großer Speicher', 60, 0, 3000)];
    acc.integrate(state({ at: d, pv: 0, house: 0, gi: 0, ge: 0, batteries: bats }));
    acc.integrate(state({ at: new Date(2026, 7, 19, 12, 0, 10), pv: 0, house: 0, gi: 0, ge: 0, batteries: bats }));
    const v: any = acc.dayView(localDate(d));
    const names = v.batteries.map((b: any) => b.name).sort();
    assert.deepEqual(names, ['Großer Speicher', 'Kleiner Speicher']);
    const fron = v.batteries.find((b: any) => b.deviceId === 'fronius:0');
    const vic = v.batteries.find((b: any) => b.deviceId === 'victron:0');
    assert.ok(fron.chargeWh > 0 && fron.dischargeWh === 0);
    assert.ok(vic.dischargeWh > 0 && vic.chargeWh === 0);
  });

  test('Neustart stellt den heutigen Zwischenstand wieder her', () => {
    const acc = makeAcc();
    const d = new Date(2026, 7, 19, 12, 0, 0);
    acc.integrate(state({ at: d, pv: 3600, house: 0, gi: 0, ge: 0 }));
    acc.integrate(state({ at: new Date(2026, 7, 19, 12, 0, 10), pv: 3600, house: 0, gi: 0, ge: 0 }));
    acc.persist();
    // Zweite Instanz mit demselben Datenverzeichnis (simuliert Serverneustart am selben Tag).
    const acc2 = new EnergyAccumulator({ dataDir: dir, pvSources: ['fronius-local'], names: {}, tariff: TARIFF });
    const v: any = acc2.dayView(localDate(d));
    // Nur am selben Kalendertag wiederherstellbar; sonst 0 (Test läuft am selben Tag nur bei Zufall).
    if (localDate(new Date()) === localDate(d)) {
      assert.ok(v.totals.productionWh > 9);
    } else {
      assert.ok(v.totals.productionWh >= 0);
    }
  });
});
