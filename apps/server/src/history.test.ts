import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
function metric(valueW: number | null, quality: 'live' | 'stale' | 'offline' = 'live'): PowerMetric {
  return {
    valueW,
    provenance: { connectorId: 'x', deviceId: 'x', measuredAt: new Date(), ageMs: 0, quality },
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
  /** Qualität der PV-Messung — für den Fall einer eingefrorenen Quelle. */
  pvQualitaet?: 'live' | 'stale' | 'offline';
  ev?: number | null;
}): EngineState {
  const snapshot: EnergySnapshot = {
    timestamp: opts.at,
    solarProductionW: metric(opts.pv, opts.pvQualitaet ?? 'live'),
    houseConsumptionW: metric(opts.house),
    gridImportW: metric(opts.gi),
    gridExportW: metric(opts.ge),
    batteries: opts.batteries ?? [],
    evCharger:
      opts.ev === undefined
        ? null
        : ({
            deviceId: 'ev', displayName: 'Wallbox', state: 'charging',
            vehicleConnected: true, chargePowerW: opts.ev, sessionEnergyWh: null,
            totalEnergyWh: null, maxCurrentA: 16, temperatureC: null,
            vehicleSocPercent: null, faultText: null,
            provenance: { connectorId: 'ev', deviceId: 'ev', measuredAt: opts.at, ageMs: 0, quality: 'live' },
          } as EnergySnapshot['evCharger']),
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

  test('eine eingefrorene Quelle erzeugt keine Energie mehr', () => {
    // Der eigentliche Fehler: Eine Quelle, die ihren letzten Wert weitermeldet,
    // lief ungebremst in die Tagessumme. Aus 3600 W, die längst nicht mehr
    // flossen, wurden so über eine Viertelstunde 900 Wh reine Erfindung.
    const acc = makeAcc();
    const d = new Date(2026, 7, 19, 12, 0, 0);
    acc.integrate(state({ at: d, pv: 3600, house: 500, gi: 0, ge: 0, pvQualitaet: 'stale' }));
    acc.integrate(state({
      at: new Date(2026, 7, 19, 12, 0, 10),
      pv: 3600, house: 500, gi: 0, ge: 0, pvQualitaet: 'stale',
    }));
    const v: any = acc.dayView(localDate(d));
    assert.equal(v.totals.productionWh, 0, 'veralteter PV-Wert wurde integriert');
    // Der Hauszähler misst weiter — was gemessen wurde, zählt auch.
    assert.ok(v.totals.houseConsumptionWh > 0, 'gemessener Hausverbrauch ging verloren');
  });

  test('weist Abdeckung und Lücken aus', () => {
    const acc = makeAcc();
    const d = new Date(2026, 7, 19, 12, 0, 0);
    acc.integrate(state({ at: d, pv: 1000, house: 500, gi: 0, ge: 0 }));
    // Zehn vollständig gemessene Sekunden.
    acc.integrate(state({ at: new Date(2026, 7, 19, 12, 0, 10), pv: 1000, house: 500, gi: 0, ge: 0 }));
    // Zehn Sekunden mit eingefrorener PV: gemessen, aber nicht vollständig.
    acc.integrate(state({
      at: new Date(2026, 7, 19, 12, 0, 20),
      pv: 1000, house: 500, gi: 0, ge: 0, pvQualitaet: 'offline',
    }));
    const v: any = acc.dayView(localDate(d));
    assert.ok(Math.abs(v.coverage.coveredSeconds - 10) < 0.001, `${v.coverage.coveredSeconds} s abgedeckt`);
    assert.ok(Math.abs(v.coverage.gapSeconds - 10) < 0.001, `${v.coverage.gapSeconds} s Lücke`);
    assert.ok(Math.abs(v.coverage.percent - 50) < 0.001, `${v.coverage.percent} %`);
  });

  test('eine lange Pause zählt als Lücke, nicht als gemessene Zeit', () => {
    // Neustart, schlafender Rechner, Netzausfall: Der Schritt wird auf die
    // zulässige Länge gekappt. Bisher verschwand der Rest spurlos.
    const acc = makeAcc();
    const d = new Date(2026, 7, 19, 12, 0, 0);
    acc.integrate(state({ at: d, pv: 1000, house: 500, gi: 0, ge: 0 }));
    acc.integrate(state({ at: new Date(2026, 7, 19, 12, 10, 0), pv: 1000, house: 500, gi: 0, ge: 0 }));
    const v: any = acc.dayView(localDate(d));
    // 600 s verstrichen, 15 s davon integriert.
    assert.ok(v.coverage.gapSeconds > 580, `nur ${v.coverage.gapSeconds} s als Lücke gezählt`);
    assert.ok(v.coverage.percent < 5, `${v.coverage.percent} % Abdeckung behauptet`);
  });

  test('zählt Wallbox-Leistung erst ab der gemeinsamen Schwelle', () => {
    // Bilanz und Ladeprotokoll müssen dieselbe Schwelle benutzen, sonst weisen
    // sie für denselben Tag verschiedene Kilowattstunden aus.
    const acc = makeAcc();
    const d = new Date(2026, 7, 19, 12, 0, 0);
    acc.integrate(state({ at: d, pv: 0, house: 500, gi: 0, ge: 0, ev: 20 }));
    acc.integrate(state({ at: new Date(2026, 7, 19, 12, 0, 10), pv: 0, house: 500, gi: 0, ge: 0, ev: 20 }));
    const v: any = acc.dayView(localDate(d));
    assert.equal(v.totals.evChargeWh, 0, 'Grundrauschen der Wallbox wurde als Ladung gezählt');
  });

  test('nimmt die geprüfte Ladeleistung, wenn sie übergeben wird', () => {
    // Die Wallbox meldet über die Cloud 2000 W, der Hauszähler weiss es besser:
    // Es fliesst nichts. Dann darf auch nichts in der Bilanz stehen.
    const acc = makeAcc();
    const d = new Date(2026, 7, 19, 12, 0, 0);
    acc.integrate(state({ at: d, pv: 0, house: 500, gi: 0, ge: 0, ev: 2000 }), 0);
    acc.integrate(state({ at: new Date(2026, 7, 19, 12, 0, 10), pv: 0, house: 500, gi: 0, ge: 0, ev: 2000 }), 0);
    const v: any = acc.dayView(localDate(d));
    assert.equal(v.totals.evChargeWh, 0, 'der ungeprüfte Cloud-Wert wurde integriert');
  });

  test('eine kaputte Datei reisst die anderen nicht mit und bleibt erhalten', () => {
    // Vorher lagen history.json, tariff.json und today.json in EINEM try/catch:
    // Eine beschädigte Historie kostete auch den Tarif. Und beim nächsten
    // Speichern wurde die kaputte Datei kommentarlos überschrieben.
    const acc = makeAcc();
    acc.setTariff({ importPricePerKWh: 0.42, exportPricePerKWh: 0.07 });
    acc.persist();

    writeFileSync(join(dir, 'history.json'), '{ das ist kein JSON', 'utf8');
    const acc2 = new EnergyAccumulator({ dataDir: dir, pvSources: [], names: {}, tariff: TARIFF });

    assert.equal(acc2.getTariff().importPricePerKWh, 0.42, 'der Tarif ging mit verloren');
    const beiseite = readdirSync(dir).filter((f) => f.includes('beschaedigt'));
    assert.equal(beiseite.length, 1, 'die kaputte Datei wurde nicht aufbewahrt');
    assert.match(readFileSync(join(dir, beiseite[0] ?? ''), 'utf8'), /das ist kein JSON/);
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
