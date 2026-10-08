import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EnergyAccumulator, localDate, shiftDate, verdichteSerie, type SeriesPoint } from './history.ts';
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
  /** Zählerstände der Geräte in Wh. */
  zaehler?: { pv?: number; bezug?: number; einspeisung?: number; auto?: number };
}): EngineState {
  const snapshot: EnergySnapshot = {
    timestamp: opts.at,
    solarProductionW: metric(opts.pv, opts.pvQualitaet ?? 'live'),
    houseConsumptionW: metric(opts.house),
    gridImportW: metric(opts.gi),
    gridExportW: metric(opts.ge),
    batteries: opts.batteries ?? [],
    evCharger:
      opts.ev === undefined && opts.zaehler?.auto === undefined
        ? null
        : ({
            deviceId: 'ev', displayName: 'Wallbox', state: 'charging',
            vehicleConnected: true, chargePowerW: opts.ev ?? null, sessionEnergyWh: null,
            totalEnergyWh: opts.zaehler?.auto ?? null, maxCurrentA: 16, temperatureC: null,
            vehicleSocPercent: null, faultText: null,
            provenance: { connectorId: 'ev', deviceId: 'ev', measuredAt: opts.at, ageMs: 0, quality: 'live' },
          } as EnergySnapshot['evCharger']),
    ...(opts.zaehler
      ? {
          counters: {
            solarWh: opts.zaehler.pv === undefined ? null : { valueWh: opts.zaehler.pv, provenance: metric(0).provenance },
            gridImportWh: opts.zaehler.bezug === undefined ? null : { valueWh: opts.zaehler.bezug, provenance: metric(0).provenance },
            gridExportWh: opts.zaehler.einspeisung === undefined ? null : { valueWh: opts.zaehler.einspeisung, provenance: metric(0).provenance },
            solarByConnectorWh: {},
          },
        }
      : {}),
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
/** Uhr des Akkumulators — steht auf dem letzten eingespeisten Messzeitpunkt. */
let uhr = 0;
function makeAcc(beginn?: Date): EnergyAccumulator {
  dir = mkdtempSync(join(tmpdir(), 'energie-hist-'));
  uhr = (beginn ?? new Date(2026, 7, 19, 12, 0, 0)).getTime();
  return neuStart();
}
/** Ein weiterer Akkumulator im selben Verzeichnis — ein Neustart des Servers. */
function neuStart(): EnergyAccumulator {
  return new EnergyAccumulator({
    dataDir: dir, pvSources: ['fronius-local', 'fronius-gen24'], names: {}, tariff: TARIFF,
    jetzt: () => uhr,
  });
}
/** Messung einspeisen und die Uhr mitziehen. */
function miss(acc: EnergyAccumulator, s: Parameters<typeof state>[0], ev?: number | null): void {
  uhr = s.at.getTime();
  if (ev === undefined) acc.integrate(state(s));
  else acc.integrate(state(s), ev);
}
const um = (h: number, m: number, s = 0, tag = 19, monat = 7) => new Date(2026, monat, tag, h, m, s);
afterEach(() => { if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* egal */ } });

describe('EnergyAccumulator — Speicherung & Aggregation', () => {
  test('integriert Leistung zu Energie (P·t)', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 3600, house: 0, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 0, 10), pv: 3600, house: 0, gi: 0, ge: 0 });
    const v: any = acc.dayView('2026-08-19');
    // 3600 W über 10 s = 10 Wh
    assert.ok(Math.abs(v.totals.productionWh - 10) < 0.001, `erwartet ~10 Wh, war ${v.totals.productionWh}`);
    assert.equal(v.hasData, true);
    assert.equal(v.isToday, true);
  });

  test('fehlender Wert (null) wird nicht als 0 gezählt', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: null, house: 500, gi: null, ge: null });
    miss(acc, { at: um(12, 0, 10), pv: null, house: 500, gi: null, ge: null });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.totals.productionWh, 0);
    assert.ok(v.totals.houseConsumptionWh > 0);
  });

  test('Tag ohne Daten meldet hasData:false (keine erfundenen Werte)', () => {
    const acc = makeAcc();
    const v: any = acc.dayView('2020-01-01');
    assert.equal(v.hasData, false);
  });

  test('Speicher werden getrennt erfasst (klein + groß)', () => {
    const acc = makeAcc();
    const bats = [battery('fronius:0', 'Kleiner Speicher', 80, 2000, 0), battery('victron:0', 'Großer Speicher', 60, 0, 3000)];
    miss(acc, { at: um(12, 0, 0), pv: 0, house: 0, gi: 0, ge: 0, batteries: bats });
    miss(acc, { at: um(12, 0, 10), pv: 0, house: 0, gi: 0, ge: 0, batteries: bats });
    const v: any = acc.dayView('2026-08-19');
    const names = v.batteries.map((b: any) => b.name).sort();
    assert.deepEqual(names, ['Großer Speicher', 'Kleiner Speicher']);
    const fron = v.batteries.find((b: any) => b.deviceId === 'fronius:0');
    const vic = v.batteries.find((b: any) => b.deviceId === 'victron:0');
    assert.ok(fron.chargeWh > 0 && fron.dischargeWh === 0);
    assert.ok(vic.dischargeWh > 0 && vic.chargeWh === 0);
  });
});

describe('Nur Gemessenes zählt', () => {
  test('eine eingefrorene Quelle erzeugt keine Energie', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 3600, house: 500, gi: 0, ge: 0, pvQualitaet: 'stale' });
    miss(acc, { at: um(12, 0, 10), pv: 3600, house: 500, gi: 0, ge: 0, pvQualitaet: 'stale' });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.totals.productionWh, 0, 'veralteter PV-Wert wurde integriert');
    assert.ok(v.totals.houseConsumptionWh > 0, 'gemessener Hausverbrauch ging verloren');
  });

  test('füllt eine Lücke nicht rückwirkend mit dem nächsten Messwert', () => {
    // Bis zur zweiten Messung war die PV unbekannt. Der neue Wert gilt ab jetzt,
    // nicht für die zehn Sekunden davor.
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 3600, house: 500, gi: 0, ge: 0, pvQualitaet: 'offline' });
    miss(acc, { at: um(12, 0, 10), pv: 3600, house: 500, gi: 0, ge: 0 });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.totals.productionWh, 0);
    assert.equal(v.coverage.coveredSeconds, 0);
  });

  test('ein langes Intervall ist als Ganzes Lücke — auch nicht die ersten 15 s', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 1000, house: 500, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 10, 0), pv: 1000, house: 500, gi: 0, ge: 0 });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.totals.productionWh, 0);
    assert.equal(v.coverage.coveredSeconds, 0);
  });

  test('zählt Wallbox-Leistung erst ab der gemeinsamen Schwelle', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 0, house: 500, gi: 0, ge: 0, ev: 20 });
    miss(acc, { at: um(12, 0, 10), pv: 0, house: 500, gi: 0, ge: 0, ev: 20 });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.totals.evChargeWh, 0, 'Grundrauschen der Wallbox wurde als Ladung gezählt');
  });

  test('eine unbekannte geprüfte Ladeleistung wird nicht verbucht', () => {
    // Die Wallbox meldet 2000 W, die Prüfung am Hauszähler sagt "unbekannt".
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 0, house: 500, gi: 0, ge: 0, ev: 2000 }, null);
    miss(acc, { at: um(12, 0, 10), pv: 0, house: 500, gi: 0, ge: 0, ev: 2000 }, null);
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.totals.evChargeWh, 0, 'der ungeprüfte Cloud-Wert wurde integriert');
  });
});

describe('Abdeckung, Kurve und Neustart erklären dieselben Lücken', () => {
  test('Nenner ist der Tag bis jetzt; Aufzeichnung seit dem ersten Messwert', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 1000, house: 500, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 0, 10), pv: 1000, house: 500, gi: 0, ge: 0, pvQualitaet: 'offline' });
    miss(acc, { at: um(12, 0, 20), pv: 1000, house: 500, gi: 0, ge: 0 });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.coverage.coveredSeconds, 10);
    assert.equal(v.coverage.zeitraumSeconds, 12 * 3600 + 20);
    assert.equal(v.coverage.gapSeconds, 12 * 3600 + 10);
    assert.equal(v.coverage.erfasstAbMs, um(12, 0, 0).getTime());
  });

  test('ungültige Kurvenpunkte sind Lücken, keine fortgeführten Messungen', () => {
    // Die Kurve zeigt Minutenmittel; ein Mittel braucht ein Intervall.
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 1000, house: 500, gi: 0, ge: 0, pvQualitaet: 'stale' });
    miss(acc, { at: um(12, 0, 10), pv: 1000, house: 500, gi: 0, ge: 0, pvQualitaet: 'stale' });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.series[0].pv, null);
    assert.equal(v.series[0].house, 500);
  });

  test('Neustart am selben Tag: Zwischenstand bleibt, Ausfallzeit ist Lücke in Summe und Kurve', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 3600, house: 0, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 0, 10), pv: 3600, house: 0, gi: 0, ge: 0 });
    acc.persist();

    // Eine Stunde später läuft der Dienst wieder.
    uhr = um(13, 0, 10).getTime();
    const acc2 = neuStart();
    miss(acc2, { at: um(13, 0, 10), pv: 3600, house: 0, gi: 0, ge: 0 });
    miss(acc2, { at: um(13, 1, 20), pv: 3600, house: 0, gi: 0, ge: 0 });
    const v: any = acc2.dayView('2026-08-19');

    assert.ok(Math.abs(v.totals.productionWh - 10) < 0.001, 'Zwischenstand oder Ausfallzeit falsch');
    assert.equal(v.coverage.coveredSeconds, 10);
    // In der Kurve trennt ein leerer Punkt die Stunde ohne Aufzeichnung.
    const luecke = v.series.find((p: any) => p.t > um(12, 0, 0).getTime() && p.t < um(13, 0, 0).getTime());
    assert.ok(luecke, 'kein Trennpunkt in der Kurve');
    assert.equal(luecke.pv, null);
  });

  test('Mitternacht teilt das Intervall auf beide Tage', () => {
    // 23:59:55 bis 00:00:05 mit 3600 W: je 5 Wh auf jeden Tag, nicht 10 Wh
    // auf den neuen.
    const acc = makeAcc(um(23, 59, 50, 18));
    miss(acc, { at: um(23, 59, 55, 18), pv: 3600, house: 0, gi: 0, ge: 0 });
    miss(acc, { at: um(0, 0, 5, 19), pv: 3600, house: 0, gi: 0, ge: 0 });
    const alt: any = acc.dayView('2026-08-18');
    const neu: any = acc.dayView('2026-08-19');
    assert.ok(Math.abs(alt.totals.productionWh - 5) < 0.001, `Vortag ${alt.totals.productionWh}`);
    assert.ok(Math.abs(neu.totals.productionWh - 5) < 0.001, `neuer Tag ${neu.totals.productionWh}`);
    assert.ok(alt.series.length >= 1, 'Kurve des Vortags fehlt');
  });

  test('liefert die Tagesgrenzen der Anlage mit', () => {
    const acc = makeAcc();
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.tagBeginnMs, new Date(2026, 7, 19).getTime());
    assert.equal(v.tagEndeMs, new Date(2026, 7, 20).getTime());
  });
});

describe('Herkunftsmodell je Intervall', () => {
  test('Netzladung des Speichers erscheint nicht als PV-Verwendung', () => {
    const acc = makeAcc();
    const bats = [battery('victron:0', 'Großer Speicher', 40, 4000, 0)];
    miss(acc, { at: um(2, 0, 0), pv: 0, house: 1000, gi: 5000, ge: 0, batteries: bats });
    miss(acc, { at: um(2, 0, 10), pv: 0, house: 1000, gi: 5000, ge: 0, batteries: bats });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.derived.productionSinks.batteryWh, 0);
    assert.ok(Math.abs(v.derived.consumptionSources.gridWh - 1000 * 10 / 3600) < 1e-6);
  });

  test('ohne vollständige Speicherdaten keine Zuordnung, nur "nicht zuordenbar"', () => {
    const acc = makeAcc();
    const s = state({ at: um(2, 0, 0), pv: 0, house: 1000, gi: 1000, ge: 0 });
    const fehlt = { ...s, resolution: { ...s.resolution, unavailable: ['battery:victron-modbus'] } };
    uhr = um(2, 0, 0).getTime();
    acc.integrate(fehlt);
    uhr = um(2, 0, 10).getTime();
    acc.integrate({ ...fehlt, polledAt: um(2, 0, 10) });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.derived.consumptionSources.gridWh, 0);
    assert.ok(v.derived.consumptionSources.nichtZuordenbarWh > 0);
  });
});

describe('Tarife mit Gültigkeit', () => {
  test('ein Tarifwechsel verändert frühere Kosten nicht', () => {
    const acc = makeAcc(um(12, 0, 0, 18));
    miss(acc, { at: um(12, 0, 0, 18), pv: 0, house: 3600, gi: 3600, ge: 0 });
    miss(acc, { at: um(12, 0, 10, 18), pv: 0, house: 3600, gi: 3600, ge: 0 });
    acc.tarife.setze({ importPricePerKWh: 0.3, exportPricePerKWh: 0.08, gueltigAb: '2026-08-18' });
    const vorher: any = acc.dayView('2026-08-18');

    // Am nächsten Tag steigt der Preis.
    uhr = um(12, 0, 0, 19).getTime();
    acc.tarife.setze({ importPricePerKWh: 0.5, exportPricePerKWh: 0.08, gueltigAb: '2026-08-19' });
    const nachher: any = acc.dayView('2026-08-18');

    assert.equal(nachher.derived.costs.gridCostActualEUR, vorher.derived.costs.gridCostActualEUR);
    assert.equal(nachher.derived.costs.tarif.importPricePerKWh, 0.3);
    assert.equal(nachher.derived.costs.tarif.grundlage, 'bekannt');
  });

  test('ohne bekannten Tarif für den Tag steht er als angenommen da', () => {
    const acc = makeAcc();
    acc.tarife.setze({ importPricePerKWh: 0.3, exportPricePerKWh: 0.08, gueltigAb: '2026-08-19' });
    assert.equal(acc.tarife.fuerTag('2026-01-01').grundlage, 'angenommen');
  });

  test('ungültige Tarife werden abgelehnt, der bisherige bleibt', () => {
    const acc = makeAcc();
    acc.tarife.setze({ importPricePerKWh: 0.3, exportPricePerKWh: 0.08 });
    for (const kaputt of [
      { importPricePerKWh: -0.1, exportPricePerKWh: 0.08 },
      { importPricePerKWh: Number.NaN, exportPricePerKWh: 0.08 },
      { importPricePerKWh: 0.3, exportPricePerKWh: 0.08, hack: 1 },
      { importPricePerKWh: '0.3', exportPricePerKWh: 0.08 },
    ]) {
      assert.throws(() => acc.tarife.setze(kaputt), TypeError, JSON.stringify(kaputt));
    }
    assert.equal(acc.tarife.aktuell().tarif.importPricePerKWh, 0.3);
  });

  test('ein Schreibfehler ist kein Erfolg und ändert nichts', () => {
    const acc = makeAcc();
    acc.tarife.setze({ importPricePerKWh: 0.3, exportPricePerKWh: 0.08 });
    rmSync(dir, { recursive: true, force: true }); // Verzeichnis weg: Schreiben scheitert
    assert.throws(() => acc.tarife.setze({ importPricePerKWh: 0.9, exportPricePerKWh: 0.08 }));
    assert.equal(acc.tarife.aktuell().tarif.importPricePerKWh, 0.3);
  });

  test('übernimmt den alten Einzeltarif ohne erfundene Historie', () => {
    const acc = makeAcc();
    writeFileSync(join(dir, 'tariff.json'), JSON.stringify({ importPricePerKWh: 0.31, exportPricePerKWh: 0.07 }));
    const acc2 = neuStart();
    const heute = acc2.tarife.fuerTag('2026-08-19');
    assert.equal(heute.tarif.importPricePerKWh, 0.31);
    assert.equal(heute.grundlage, 'bekannt');
    assert.equal(acc2.tarife.fuerTag('2026-03-01').grundlage, 'angenommen');
    void acc;
  });
});

describe('Beschädigte Dateien', () => {
  test('eine kaputte Datei reisst die anderen nicht mit und bleibt erhalten', () => {
    const acc = makeAcc();
    acc.tarife.setze({ importPricePerKWh: 0.42, exportPricePerKWh: 0.07 });
    acc.persist();

    writeFileSync(join(dir, 'history.json'), '{ das ist kein JSON', 'utf8');
    const acc2 = neuStart();

    assert.equal(acc2.tarife.aktuell().tarif.importPricePerKWh, 0.42, 'der Tarif ging mit verloren');
    const beiseite = readdirSync(dir).filter((f) => f.includes('beschaedigt'));
    assert.equal(beiseite.length, 1, 'die kaputte Datei wurde nicht aufbewahrt');
    assert.match(readFileSync(join(dir, beiseite[0] ?? ''), 'utf8'), /das ist kein JSON/);
  });

  test('fachlich ungültige Summen werden nicht übernommen', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 3600, house: 0, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 0, 10), pv: 3600, house: 0, gi: 0, ge: 0 });
    acc.persist();
    const today = JSON.parse(readFileSync(join(dir, 'today.json'), 'utf8'));
    today.totals.productionWh = -500;
    writeFileSync(join(dir, 'today.json'), JSON.stringify(today));
    const acc2 = neuStart();
    const v: any = acc2.dayView('2026-08-19');
    assert.ok(!v.hasData || v.totals.productionWh >= 0, 'negative Summe wurde geglaubt');
  });
});

describe('Kurve als Minutenmittel', () => {
  test('ein Punkt je Minute, Mittel über die Messungen der Minute', () => {
    const acc = makeAcc();
    // 12:00:00–12:00:30 mit 1000 W, 12:00:30–12:01:00 mit 3000 W → Mittel 2000 W.
    miss(acc, { at: um(12, 0, 0), pv: 1000, house: 500, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 0, 10), pv: 1000, house: 500, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 0, 20), pv: 1000, house: 500, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 0, 30), pv: 3000, house: 500, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 0, 40), pv: 3000, house: 500, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 0, 50), pv: 3000, house: 500, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 1, 0), pv: 3000, house: 500, gi: 0, ge: 0 });
    const v: any = acc.dayView('2026-08-19');
    const punkt = v.series.find((p: any) => p.t === um(12, 0, 0).getTime());
    assert.ok(punkt, 'kein Punkt für 12:00');
    assert.equal(punkt.pv, 2000);
    assert.equal(punkt.house, 500);
    assert.ok(Number.isInteger(punkt.pv), 'ganze Watt');
  });

  test('die angefangene Minute ist in der Live-Ansicht schon sichtbar', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 1000, house: 500, gi: 0, ge: 0 });
    miss(acc, { at: um(12, 0, 10), pv: 1000, house: 500, gi: 0, ge: 0 });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.series.length, 1);
    assert.equal(v.series[0].pv, 1000);
    assert.equal(acc.todaySeries().length, 1);
  });

  test('Kurve und Summe beschreiben dieselbe Energie', () => {
    const acc = makeAcc();
    for (let s = 0; s <= 120; s += 10) {
      miss(acc, { at: new Date(um(12, 0, 0).getTime() + s * 1000), pv: 600 + s * 10, house: 0, gi: 0, ge: 0 });
    }
    const v: any = acc.dayView('2026-08-19');
    const ausKurve = v.series.filter((p: any) => p.pv !== null).reduce((a: number, p: any) => a + p.pv / 60, 0);
    assert.ok(Math.abs(ausKurve - v.totals.productionWh) < 1, `Kurve ${ausKurve} Wh vs Summe ${v.totals.productionWh} Wh`);
  });

  test('verdichteSerie mittelt vorhandene Werte und lässt Lücken Lücken', () => {
    const t0 = um(12, 0, 0).getTime();
    const p = (min: number, pv: number | null): SeriesPoint => ({
      t: t0 + min * 60_000, pv, house: 100, gridImport: 0, gridExport: 0, inv: { a: pv }, bat: { b: { p: pv, soc: 50 + min } }, socAgg: 50 + min,
    });
    const serie = [p(0, 1000), p(1, 2000), p(2, null), p(15, null), p(16, null)];
    const grob = verdichteSerie(serie, 15 * 60_000);
    assert.equal(grob.length, 2);
    assert.equal(grob[0]?.pv, 1500, 'Mittel nur über vorhandene Werte');
    assert.equal(grob[0]?.bat['b']?.soc, 52, 'SOC: letzter Wert des Fensters');
    assert.equal(grob[1]?.pv, null, 'ein Fenster ohne Wert bleibt Lücke');
  });
});

describe('Zählerstände als zweite Wahrheit', () => {
  test('Tagessumme ist die Zählerdifferenz seit dem ersten Stand des Tages', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { pv: 100_000, bezug: 5000, einspeisung: 7000, auto: 900 } });
    miss(acc, { at: um(12, 0, 10), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { pv: 100_250, bezug: 5020, einspeisung: 7100, auto: 950 } });
    const v: any = acc.dayView('2026-08-19');
    assert.deepEqual(v.totals.zaehler, { pvWh: 250, pvJeWechselrichterWh: {}, bezugWh: 20, einspeisungWh: 100, autoWh: 50 });
  });

  test('ohne Zähler bleibt die Grösse null — nicht 0', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { bezug: 5000 } });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.totals.zaehler.pvWh, null);
    assert.equal(v.totals.zaehler.bezugWh, 0);
  });

  test('überlebt einen Neustart samt Ausfallzeit — die Zähler zählten weiter', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 3600, house: 0, gi: 0, ge: 0, zaehler: { pv: 1000 } });
    miss(acc, { at: um(12, 0, 10), pv: 3600, house: 0, gi: 0, ge: 0, zaehler: { pv: 1010 } });
    acc.persist();
    uhr = um(13, 0, 0).getTime();
    const acc2 = neuStart();
    miss(acc2, { at: um(13, 0, 0), pv: 3600, house: 0, gi: 0, ge: 0, zaehler: { pv: 4610 } });
    const v: any = acc2.dayView('2026-08-19');
    assert.ok(Math.abs(v.totals.productionWh - 10) < 0.001, 'Integration kennt nur die 10 Wh vor dem Ausfall');
    assert.equal(v.totals.zaehler.pvWh, 3610, 'der Zähler kennt auch die Stunde dazwischen');
  });

  test('ein Zählerrücksprung verliert nichts', () => {
    const acc = makeAcc();
    miss(acc, { at: um(12, 0, 0), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { bezug: 500 } });
    miss(acc, { at: um(12, 0, 10), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { bezug: 530 } });
    miss(acc, { at: um(12, 0, 20), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { bezug: 5 } });
    miss(acc, { at: um(12, 0, 30), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { bezug: 12 } });
    const v: any = acc.dayView('2026-08-19');
    assert.equal(v.totals.zaehler.bezugWh, 30 + 7);
  });

  test('über Mitternacht beginnt der neue Tag beim letzten Stand des alten', () => {
    const acc = makeAcc(um(23, 59, 50, 18));
    miss(acc, { at: um(23, 59, 55, 18), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { bezug: 1000 } });
    miss(acc, { at: um(0, 0, 5, 19), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { bezug: 1010 } });
    miss(acc, { at: um(0, 0, 15, 19), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { bezug: 1030 } });
    const alt: any = acc.dayView('2026-08-18');
    const neu: any = acc.dayView('2026-08-19');
    assert.equal(alt.totals.zaehler.bezugWh, 0);
    assert.equal(neu.totals.zaehler.bezugWh, 30);
  });

  test('Monats- und Gesamtsummen addieren Zähler nur, wenn alle Tage welche haben', () => {
    const acc = makeAcc(um(23, 59, 50, 18));
    miss(acc, { at: um(23, 59, 55, 18), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { bezug: 1000 } });
    miss(acc, { at: um(0, 0, 5, 19), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { bezug: 1010 } });
    miss(acc, { at: um(0, 0, 15, 19), pv: 0, house: 0, gi: 0, ge: 0, zaehler: { bezug: 1030 } });
    const h: any = acc.historyView('total');
    assert.equal(h.lifetime.zaehler.bezugWh, 30);
    assert.equal(h.lifetime.zaehler.pvWh, null);
  });
});