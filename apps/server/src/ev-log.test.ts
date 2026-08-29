/**
 * Tests der automatischen Session-Erkennung.
 *
 * Geprüft wird der komplette Weg: Anstecken → Laden → Abstecken → Speichern →
 * nach Neustart wieder da. Es werden synthetische Messzustände eingespeist;
 * die Logik selbst ist dieselbe wie im Betrieb.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  BatterySnapshot,
  EnergySnapshot,
  EvChargerSnapshot,
  EvChargerState,
  PowerMetric,
} from '@energy/core';

import { ChargeSessionLog } from './ev-log.ts';
import { localDate } from './history.ts';
import type { EngineState } from './engine.ts';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'evlog-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const prov = (id: string) => ({
  connectorId: 'x',
  deviceId: id,
  measuredAt: new Date(),
  ageMs: 0,
  quality: 'live' as const,
});
const metric = (valueW: number | null): PowerMetric => ({ valueW, provenance: prov('x') });

function bat(deviceId: string, dischargeW: number): BatterySnapshot {
  return {
    deviceId,
    displayName: deviceId,
    socPercent: 50,
    chargeW: 0,
    dischargeW,
    storedEnergyWh: null,
    usableCapacityWh: 10_000,
    ratedCapacityWh: null,
    state: dischargeW > 0 ? 'discharging' : 'idle',
    provenance: prov(deviceId),
  };
}

function charger(opts: {
  connected: boolean | null;
  powerW: number | null;
  state?: EvChargerState;
}): EvChargerSnapshot {
  return {
    deviceId: 'ev-charger:dev',
    displayName: 'Leapmotor C10',
    state: opts.state ?? (opts.powerW && opts.powerW > 50 ? 'charging' : 'idle'),
    vehicleConnected: opts.connected,
    chargePowerW: opts.powerW,
    sessionEnergyWh: null,
    totalEnergyWh: null,
    maxCurrentA: 16,
    temperatureC: 40,
    vehicleSocPercent: null,
    faultText: null,
    provenance: prov('ev'),
  };
}

/** Ein Messzeitpunkt. `grid`/`pv` steuern die Quellen-Zuordnung. */
function tick(opts: {
  at: Date;
  ev: EvChargerSnapshot | null;
  pv?: number | null;
  grid?: number;
  batteries?: BatterySnapshot[];
}): EngineState {
  const snapshot: EnergySnapshot = {
    timestamp: opts.at,
    solarProductionW: metric(opts.pv ?? 0),
    houseConsumptionW: metric(0),
    gridImportW: metric(opts.grid ?? 0),
    gridExportW: metric(0),
    batteries: opts.batteries ?? [],
    evCharger: opts.ev,
  };
  return {
    resolution: {
      snapshot,
      unavailable: [],
      disagreements: [],
      derivedConsumptionNegative: false,
    },
    readings: [],
    diagnostics: [],
    polledAt: opts.at,
    pollDurationMs: 1,
  };
}

const t0 = new Date('2026-08-26T18:00:00');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

describe('Ladeprotokoll — Session-Erkennung', () => {
  test('erkennt Anstecken, Laden und Abstecken als EINE Session', () => {
    const log = new ChargeSessionLog(tempDir());
    log.integrate(tick({ at: at(0), ev: charger({ connected: false, powerW: 0 }) }));
    log.integrate(tick({ at: at(1), ev: charger({ connected: true, powerW: 0 }) }));
    // 30 Minuten mit 3 kW aus dem Netz
    for (let m = 2; m <= 31; m++) {
      log.integrate(
        tick({ at: at(m), ev: charger({ connected: true, powerW: 3000 }), grid: 3000 }),
      );
    }
    log.integrate(tick({ at: at(32), ev: charger({ connected: false, powerW: 0 }) }));

    const sessions = log.list();
    assert.equal(sessions.length, 1, 'genau eine Session');
    const s = sessions[0]!;
    assert.ok(s.energyWh > 1400 && s.energyWh < 1600, `~1,5 kWh, war ${s.energyWh}`);
    assert.equal(s.endReason, 'unplugged');
    assert.equal(s.maxPowerW, 3000);
    assert.equal(s.socStartPercent, null);
    assert.equal(s.socEndPercent, null);
  });

  test('eine Ladepause erzeugt KEINE zweite Session', () => {
    const log = new ChargeSessionLog(tempDir());
    log.integrate(tick({ at: at(0), ev: charger({ connected: true, powerW: 0 }) }));
    for (let m = 1; m <= 10; m++) {
      log.integrate(tick({ at: at(m), ev: charger({ connected: true, powerW: 3000 }), grid: 3000 }));
    }
    // Pause: angesteckt, aber keine Leistung
    for (let m = 11; m <= 20; m++) {
      log.integrate(tick({ at: at(m), ev: charger({ connected: true, powerW: 0, state: 'paused' }) }));
    }
    for (let m = 21; m <= 30; m++) {
      log.integrate(tick({ at: at(m), ev: charger({ connected: true, powerW: 3000 }), grid: 3000 }));
    }
    log.integrate(tick({ at: at(31), ev: charger({ connected: false, powerW: 0 }) }));

    assert.equal(log.list().length, 1);
    const s = log.list()[0]!;
    // Steckzeit deutlich länger als reine Ladezeit
    assert.ok(s.connectedSeconds > s.chargingSeconds, 'Steckzeit > Ladezeit');
    assert.ok(s.chargingSeconds > 0);
  });

  test('kurzes Anstecken ohne Energie wird nicht als Ladevorgang gewertet', () => {
    const log = new ChargeSessionLog(tempDir());
    log.integrate(tick({ at: at(0), ev: charger({ connected: true, powerW: 0 }) }));
    log.integrate(tick({ at: at(1), ev: charger({ connected: false, powerW: 0 }) }));
    assert.equal(log.list().length, 0);
  });

  test('teilt die Energie der Session nach Quellen auf', () => {
    const log = new ChargeSessionLog(tempDir());
    log.integrate(tick({ at: at(0), ev: charger({ connected: true, powerW: 0 }) }));
    // 30 min: 2 kW PV + 2 kW Batterie versorgen ein 2-kW-Auto -> je 50 %
    for (let m = 1; m <= 30; m++) {
      log.integrate(
        tick({
          at: at(m),
          ev: charger({ connected: true, powerW: 2000 }),
          pv: 2000,
          batteries: [bat('gross', 2000)],
        }),
      );
    }
    log.integrate(tick({ at: at(31), ev: charger({ connected: false, powerW: 0 }) }));

    const s = log.list()[0]!;
    assert.ok(s.split.pvWh > 0, 'PV-Anteil vorhanden');
    assert.ok((s.split.batteryWh['gross'] ?? 0) > 0, 'Batterie-Anteil vorhanden');
    assert.equal(s.split.gridWh, 0, 'kein Netzanteil');
    // Beide Quellen lieferten gleich viel -> etwa gleiche Anteile.
    const ratio = s.split.pvWh / (s.split.batteryWh['gross'] ?? 1);
    assert.ok(ratio > 0.9 && ratio < 1.1, `etwa 50/50, war ${ratio}`);
  });

  test('schliesst die Session sauber ab, wenn das Ladegerät ausfällt', () => {
    const log = new ChargeSessionLog(tempDir());
    log.integrate(tick({ at: at(0), ev: charger({ connected: true, powerW: 0 }) }));
    for (let m = 1; m <= 20; m++) {
      log.integrate(tick({ at: at(m), ev: charger({ connected: true, powerW: 3000 }), grid: 3000 }));
    }
    // Ladegerät ausgesteckt -> offline
    log.integrate(tick({ at: at(21), ev: charger({ connected: null, powerW: null, state: 'offline' }) }));
    const s = log.list()[0]!;
    assert.equal(s.endReason, 'interrupted');
    assert.ok(s.energyWh > 0);
  });

  test('Sessions überleben einen Neustart des Servers', () => {
    const dir = tempDir();
    const first = new ChargeSessionLog(dir);
    first.integrate(tick({ at: at(0), ev: charger({ connected: true, powerW: 0 }) }));
    for (let m = 1; m <= 20; m++) {
      first.integrate(tick({ at: at(m), ev: charger({ connected: true, powerW: 3000 }), grid: 3000 }));
    }
    first.integrate(tick({ at: at(21), ev: charger({ connected: false, powerW: 0 }) }));
    const before = first.list()[0]!;

    // Neustart: neue Instanz auf demselben Verzeichnis
    const second = new ChargeSessionLog(dir);
    const after = second.list()[0];
    assert.ok(after, 'Session nach Neustart vorhanden');
    assert.equal(after!.id, before.id);
    assert.equal(Math.round(after!.energyWh), Math.round(before.energyWh));
  });

  test('Statistik zählt nur Sessions des gewählten Zeitraums', () => {
    const log = new ChargeSessionLog(tempDir());
    log.integrate(tick({ at: at(0), ev: charger({ connected: true, powerW: 0 }) }));
    for (let m = 1; m <= 20; m++) {
      log.integrate(tick({ at: at(m), ev: charger({ connected: true, powerW: 3000 }), grid: 3000 }));
    }
    log.integrate(tick({ at: at(21), ev: charger({ connected: false, powerW: 0 }) }));

    const day = log.stats('day', '2026-08-26') as { sessionCount: number; energyWh: number };
    assert.equal(day.sessionCount, 1);
    assert.ok(day.energyWh > 0);

    const otherDay = log.stats('day', '2026-08-25') as { sessionCount: number };
    assert.equal(otherDay.sessionCount, 0);

    const year = log.stats('year', '2026-01-01') as { sessionCount: number };
    assert.equal(year.sessionCount, 1);
  });

  test('ein nächtlicher Ladevorgang zählt zum Tag der Ortszeit', () => {
    const log = new ChargeSessionLog(tempDir());
    // 00:30 Uhr nach der Uhr im Haus. Gespeichert wird der Zeitpunkt als ISO
    // in UTC — dort liegt er in unserer Zeitzone noch auf dem Vortag. Genau
    // in diesen Stunden wird ein Auto üblicherweise geladen, deshalb darf die
    // Zuordnung nicht am UTC-Datum hängen.
    const night = new Date('2026-08-26T00:30:00');
    const nightAt = (minutes: number) => new Date(night.getTime() + minutes * 60_000);
    log.integrate(tick({ at: nightAt(0), ev: charger({ connected: true, powerW: 0 }) }));
    for (let m = 1; m <= 20; m++) {
      log.integrate(
        tick({ at: nightAt(m), ev: charger({ connected: true, powerW: 3000 }), grid: 3000 }),
      );
    }
    log.integrate(tick({ at: nightAt(21), ev: charger({ connected: false, powerW: 0 }) }));

    const today = localDate(night);
    const day = log.stats('day', today) as {
      sessionCount: number;
      buckets: readonly { key: string }[];
    };
    assert.equal(day.sessionCount, 1, 'gehört zum Tag der Ortszeit');
    assert.equal(day.buckets[0]?.key, today, 'auch im Verlauf unter diesem Tag');

    const yesterday = localDate(new Date(night.getTime() - 24 * 3600_000));
    const previous = log.stats('day', yesterday) as { sessionCount: number };
    assert.equal(previous.sessionCount, 0, 'und nicht zum Vortag');
  });

  test('ohne Ladegerät passiert nichts (kein Absturz, keine Geister-Session)', () => {
    const log = new ChargeSessionLog(tempDir());
    for (let m = 0; m <= 5; m++) log.integrate(tick({ at: at(m), ev: null }));
    assert.equal(log.list().length, 0);
    assert.equal(log.current(), null);
  });
});
