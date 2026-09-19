/**
 * Tests der automatischen Session-Erkennung.
 *
 * Geprüft wird der komplette Weg: Anstecken → Laden → Abstecken → Speichern →
 * nach Neustart wieder da. Es werden synthetische Messzustände eingespeist;
 * die Logik selbst ist dieselbe wie im Betrieb.
 */

import { test, describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChargeSession,
  BatterySnapshot,
  EnergySnapshot,
  EvChargerSnapshot,
  EvChargerState,
  PowerMetric,
} from '@energy/core';

import { ChargeSessionLog, fuehreZusammen } from './ev-log.ts';
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
    schalterAn: null,
    spannungV: null,
    stromA: null,
    phasen: null,
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

/**
 * Das Protokoll, so wie es der Dienst füttert.
 *
 * Die Tests unten denken in Minuten, der echte Dienst misst alle zwei
 * Sekunden. Zwischen zwei Testschritten fragt diese Hülle deshalb alle zehn
 * Sekunden mit dem unveränderten letzten Zustand nach — genau das, was die
 * Engine bis zur nächsten Änderung melden würde. Ohne sie wäre jeder
 * Minutenschritt länger als der zulässige Integrationsschritt und damit eine
 * Lücke.
 */
class Protokoll extends ChargeSessionLog {
  private zuletzt: { state: EngineState; ev: number | null | undefined } | null = null;

  override integrate(state: EngineState, evLeistungW?: number | null): void {
    const z = this.zuletzt;
    if (z !== null) {
      for (let t = z.state.polledAt.getTime() + 10_000; t < state.polledAt.getTime(); t += 10_000) {
        if (z.ev === undefined) super.integrate({ ...z.state, polledAt: new Date(t) });
        else super.integrate({ ...z.state, polledAt: new Date(t) }, z.ev);
      }
    }
    this.zuletzt = { state, ev: evLeistungW };
    if (evLeistungW === undefined) super.integrate(state);
    else super.integrate(state, evLeistungW);
  }
}

const t0 = new Date('2026-08-26T18:00:00');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

/**
 * Steckt das Fahrzeug ab und wartet die Abklingzeit aus.
 *
 * Seit der Umstellung schliesst ein einzelner "nicht verbunden"-Messwert die
 * Session nicht mehr — sonst hätte jeder Aussetzer der Tuya-Cloud einen
 * Ladevorgang zerrissen. Erst zehn Minuten Abwesenheit beenden ihn.
 */
function steckeAb(
  log: ChargeSessionLog,
  abMinute: number,
  ev: EvChargerSnapshot = charger({ connected: false, powerW: 0 }),
): void {
  for (let m = abMinute; m <= abMinute + 12; m++) {
    log.integrate(tick({ at: at(m), ev }));
  }
}

describe('Ladeprotokoll — Session-Erkennung', () => {
  test('erkennt Anstecken, Laden und Abstecken als EINE Session', () => {
    const log = new Protokoll(tempDir());
    log.integrate(tick({ at: at(0), ev: charger({ connected: false, powerW: 0 }) }));
    log.integrate(tick({ at: at(1), ev: charger({ connected: true, powerW: 0 }) }));
    // 30 Minuten mit 3 kW aus dem Netz
    for (let m = 2; m <= 31; m++) {
      log.integrate(
        tick({ at: at(m), ev: charger({ connected: true, powerW: 3000 }), grid: 3000 }),
      );
    }
    steckeAb(log, 32);

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
    const log = new Protokoll(tempDir());
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
    steckeAb(log, 31);

    assert.equal(log.list().length, 1);
    const s = log.list()[0]!;
    // Steckzeit deutlich länger als reine Ladezeit
    assert.ok(s.connectedSeconds > s.chargingSeconds, 'Steckzeit > Ladezeit');
    assert.ok(s.chargingSeconds > 0);
  });

  test('kurzes Anstecken ohne Energie wird nicht als Ladevorgang gewertet', () => {
    const log = new Protokoll(tempDir());
    log.integrate(tick({ at: at(0), ev: charger({ connected: true, powerW: 0 }) }));
    log.integrate(tick({ at: at(1), ev: charger({ connected: false, powerW: 0 }) }));
    assert.equal(log.list().length, 0);
  });

  test('teilt die Energie der Session nach Quellen auf', () => {
    const log = new Protokoll(tempDir());
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
    steckeAb(log, 31);

    const s = log.list()[0]!;
    assert.ok(s.split.pvWh > 0, 'PV-Anteil vorhanden');
    assert.ok((s.split.batteryWh['gross'] ?? 0) > 0, 'Batterie-Anteil vorhanden');
    assert.equal(s.split.gridWh, 0, 'kein Netzanteil');
    // Beide Quellen lieferten gleich viel -> etwa gleiche Anteile.
    const ratio = s.split.pvWh / (s.split.batteryWh['gross'] ?? 1);
    assert.ok(ratio > 0.9 && ratio < 1.1, `etwa 50/50, war ${ratio}`);
  });

  test('schliesst die Session sauber ab, wenn das Ladegerät ausfällt', () => {
    const log = new Protokoll(tempDir());
    log.integrate(tick({ at: at(0), ev: charger({ connected: true, powerW: 0 }) }));
    for (let m = 1; m <= 20; m++) {
      log.integrate(tick({ at: at(m), ev: charger({ connected: true, powerW: 3000 }), grid: 3000 }));
    }
    // Ladegerät ausgesteckt -> offline
    steckeAb(log, 21, charger({ connected: null, powerW: null, state: 'offline' }));
    const s = log.list()[0]!;
    assert.equal(s.endReason, 'interrupted');
    assert.ok(s.energyWh > 0);
  });

  test('Sessions überleben einen Neustart des Servers', () => {
    const dir = tempDir();
    const first = new Protokoll(dir);
    first.integrate(tick({ at: at(0), ev: charger({ connected: true, powerW: 0 }) }));
    for (let m = 1; m <= 20; m++) {
      first.integrate(tick({ at: at(m), ev: charger({ connected: true, powerW: 3000 }), grid: 3000 }));
    }
    steckeAb(first, 21);
    const before = first.list()[0]!;

    // Neustart: neue Instanz auf demselben Verzeichnis
    const second = new Protokoll(dir);
    const after = second.list()[0];
    assert.ok(after, 'Session nach Neustart vorhanden');
    assert.equal(after!.id, before.id);
    assert.equal(Math.round(after!.energyWh), Math.round(before.energyWh));
  });

  test('Statistik zählt nur Sessions des gewählten Zeitraums', () => {
    const log = new Protokoll(tempDir());
    log.integrate(tick({ at: at(0), ev: charger({ connected: true, powerW: 0 }) }));
    for (let m = 1; m <= 20; m++) {
      log.integrate(tick({ at: at(m), ev: charger({ connected: true, powerW: 3000 }), grid: 3000 }));
    }
    steckeAb(log, 21);

    const day = log.stats('day', '2026-08-26') as { sessionCount: number; energyWh: number };
    assert.equal(day.sessionCount, 1);
    assert.ok(day.energyWh > 0);

    const otherDay = log.stats('day', '2026-08-25') as { sessionCount: number };
    assert.equal(otherDay.sessionCount, 0);

    const year = log.stats('year', '2026-01-01') as { sessionCount: number };
    assert.equal(year.sessionCount, 1);
  });

  test('ein nächtlicher Ladevorgang zählt zum Tag der Ortszeit', () => {
    const log = new Protokoll(tempDir());
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
    const log = new Protokoll(tempDir());
    for (let m = 0; m <= 5; m++) log.integrate(tick({ at: at(m), ev: null }));
    assert.equal(log.list().length, 0);
    assert.equal(log.current(), null);
  });
});

describe('Eine Ladung ist ein Ladevorgang', () => {
  /** Fährt eine Folge von Messpunkten durch und gibt das Protokoll zurück. */
  function fahre(
    log: ChargeSessionLog,
    schritte: readonly { minute: number; ev: EvChargerSnapshot | null }[],
  ): void {
    const start = new Date('2026-09-06T12:00:00Z').getTime();
    for (const s of schritte) {
      log.integrate(tick({ at: new Date(start + s.minute * 60_000), ev: s.ev, pv: 9000 }));
    }
  }

  it('Szenario I — Ampere wechselt und pausiert: trotzdem EINE Session', () => {
    const log = new Protokoll(tempDir());
    const schritte: { minute: number; ev: EvChargerSnapshot }[] = [];
    // 14:00-14:20 5 kW, 14:20-14:35 3 kW, 14:35-14:40 Pause, 14:40-15:10 6 kW,
    // 15:10-15:30 2 kW - genau der Ablauf aus der Anforderung.
    const plan: [number, number][] = [
      [0, 5000], [20, 3000], [35, 0], [40, 6000], [70, 2000], [90, 2000],
    ];
    for (let minute = 0; minute <= 90; minute++) {
      const stufe = [...plan].reverse().find(([ab]) => minute >= ab);
      schritte.push({
        minute,
        ev: charger({ connected: true, powerW: stufe?.[1] ?? 0 }),
      });
    }
    fahre(log, schritte);

    // Abstecken beendet die Session - nach der Abklingzeit.
    for (let minute = 91; minute <= 110; minute++) {
      fahre(log, [{ minute, ev: charger({ connected: false, powerW: 0 }) }]);
    }

    assert.equal(log.list(50).length, 1, 'es sollte genau eine Session sein');
    const s = log.list(50)[0];
    assert.ok(s);
    assert.equal(s.endReason, 'unplugged');
    // Ladezeit ist kürzer als Steckzeit — die Pause ist getrennt gezählt.
    assert.ok(s.chargingSeconds < s.connectedSeconds);
    // Der Verlauf hält die Stufen fest, ohne eigene Sessions zu erzeugen.
    assert.ok((s.verlauf?.length ?? 0) >= 4, `Verlauf hatte ${s.verlauf?.length} Stufen`);
  });

  it('übersteht einen Aussetzer der Tuya-Cloud ohne neue Session', () => {
    const log = new Protokoll(tempDir());
    const laedt = charger({ connected: true, powerW: 5000 });
    const weg = charger({ connected: null, powerW: null, state: 'offline' });
    const schritte: { minute: number; ev: EvChargerSnapshot }[] = [];
    for (let m = 0; m <= 10; m++) schritte.push({ minute: m, ev: laedt });
    // Drei Minuten Cloud-Loch.
    for (let m = 11; m <= 13; m++) schritte.push({ minute: m, ev: weg });
    for (let m = 14; m <= 25; m++) schritte.push({ minute: m, ev: laedt });
    fahre(log, schritte);

    assert.equal(log.list(50).length, 0, 'Session wurde vorzeitig geschlossen');
    assert.ok(log.current() !== null, 'Session sollte noch offen sein');
  });

  it('Szenario J — Abstecken schliesst die Session ab', () => {
    const log = new Protokoll(tempDir());
    const schritte: { minute: number; ev: EvChargerSnapshot }[] = [];
    for (let m = 0; m <= 30; m++) {
      schritte.push({ minute: m, ev: charger({ connected: true, powerW: 6000 }) });
    }
    for (let m = 31; m <= 50; m++) {
      schritte.push({ minute: m, ev: charger({ connected: false, powerW: 0 }) });
    }
    fahre(log, schritte);

    const sessions = log.list(50);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.endReason, 'unplugged');
    assert.ok((sessions[0]?.energyWh ?? 0) > 2500);
    assert.equal(log.current(), null);
  });
});

describe('Migration: Bruchstücke zusammenführen', () => {
  const leer = { pvWh: 0, gridWh: 0, batteryWh: {}, unknownWh: 0 };
  function stueck(vonMin: number, bisMin: number, wh: number): ChargeSession {
    const basis = new Date('2026-09-06T12:00:00Z').getTime();
    return {
      id: `s${vonMin}`,
      startedAt: new Date(basis + vonMin * 60_000).toISOString(),
      endedAt: new Date(basis + bisMin * 60_000).toISOString(),
      chargingSeconds: (bisMin - vonMin) * 60,
      connectedSeconds: (bisMin - vonMin) * 60,
      energyWh: wh,
      maxPowerW: 5000,
      avgPowerW: 5000,
      socStartPercent: null,
      socEndPercent: null,
      split: leer,
      endReason: 'interrupted',
      faultText: null,
      hasGaps: false,
    };
  }

  it('fasst unmittelbar aneinander anschliessende Bruchstücke zusammen', () => {
    const zusammen = fuehreZusammen([
      stueck(0, 20, 1500),
      stueck(21, 40, 1400),
      stueck(42, 60, 1300),
    ]);
    assert.equal(zusammen.length, 1);
    assert.equal(zusammen[0]?.energyWh, 4200);
    assert.equal(zusammen[0]?.teile, 3);
    assert.equal(zusammen[0]?.hasGaps, true);
  });

  it('lässt echte getrennte Ladevorgänge getrennt', () => {
    // Zwei Stunden Abstand — das war zweimal Laden.
    const zusammen = fuehreZusammen([stueck(0, 20, 1500), stueck(140, 160, 1500)]);
    assert.equal(zusammen.length, 2);
  });

  it('kommt mit einer leeren Historie zurecht', () => {
    assert.deepEqual(fuehreZusammen([]), []);
  });
});

describe('Ladeprotokoll — geprüfte Ladeleistung', () => {
  it('nimmt die übergebene Leistung statt der gemeldeten', () => {
    // Der Fall vom 8.9.: Die Tuya-Cloud meldete unverändert 2007 W, während der
    // Hauszähler für das ganze Haus 1203 W zeigte. Die Anzeige rechnete das
    // längst heraus, das Protokoll integrierte weiter — für denselben Tag
    // standen so zwei verschiedene Kilowattstunden in der App.
    const log = new Protokoll(tempDir());
    const ev = charger({ connected: true, powerW: 2000 });
    for (let m = 0; m <= 10; m++) log.integrate(tick({ at: at(m), ev }), 0);

    const laufend = log.current();
    assert.ok(laufend, 'keine Session offen');
    assert.equal(laufend.energyWh, 0, 'der ungeprüfte Cloud-Wert wurde integriert');
    assert.equal(laufend.chargingSeconds, 0);
  });

  it('weist unbekannte Leistung als Lücke aus, nicht als null Watt', () => {
    const log = new Protokoll(tempDir());
    const ev = charger({ connected: true, powerW: null, state: 'connected' });
    for (let m = 0; m <= 5; m++) log.integrate(tick({ at: at(m), ev }));

    const laufend = log.current();
    assert.ok(laufend, 'keine Session offen');
    assert.equal(laufend.hasGaps, true, 'unbekannte Leistung wurde nicht als Lücke vermerkt');
    assert.equal(laufend.energyWh, 0);
    assert.ok(laufend.connectedSeconds > 0, 'die Steckzeit zählt trotzdem');
  });
});

describe('Ladeprotokoll — Tage, Monate und Steckereignisse', () => {
  /** Lädt von `von` bis kurz vor `bis` alle 10 s mit `watt` — ab `bis` gilt der nächste Zustand. */
  function lade(log: ChargeSessionLog, von: Date, bis: Date, watt: number): void {
    for (let t = von.getTime(); t < bis.getTime(); t += 10_000) {
      log.integrate(tick({ at: new Date(t), ev: charger({ connected: true, powerW: watt }), grid: watt }));
    }
  }
  function steckAbAb(log: ChargeSessionLog, ab: Date, sekunden: number): void {
    for (let t = ab.getTime(); t <= ab.getTime() + sekunden * 1000; t += 10_000) {
      log.integrate(tick({ at: new Date(t), ev: charger({ connected: false, powerW: 0 }) }));
    }
  }

  test('23:30 bis 00:30 mit 6 kW: je 3 kWh pro Tag, eine Session mit 6 kWh', () => {
    const log = new ChargeSessionLog(tempDir());
    lade(log, new Date(2026, 7, 26, 23, 30), new Date(2026, 7, 27, 0, 30), 6000);
    steckAbAb(log, new Date(2026, 7, 27, 0, 30), 90);

    assert.equal(log.list().length, 1);
    const s = log.list()[0]!;
    assert.ok(Math.abs(s.energyWh - 6000) < 1, `Session ${s.energyWh} Wh`);
    const a = log.stats('day', '2026-08-26') as { energyWh: number; sessionCount: number };
    const b = log.stats('day', '2026-08-27') as { energyWh: number; sessionCount: number };
    assert.ok(Math.abs(a.energyWh - 3000) < 1, `26.8.: ${a.energyWh}`);
    assert.ok(Math.abs(b.energyWh - 3000) < 1, `27.8.: ${b.energyWh}`);
    assert.equal(a.sessionCount, 1);
    assert.equal(b.sessionCount, 1);
  });

  test('über die Monatsgrenze landet die Energie im richtigen Monat', () => {
    const log = new ChargeSessionLog(tempDir());
    lade(log, new Date(2026, 7, 31, 23, 0), new Date(2026, 8, 1, 1, 0), 3000);
    steckAbAb(log, new Date(2026, 8, 1, 1, 0), 90);
    const aug = log.stats('month', '2026-08-15') as { energyWh: number };
    const sep = log.stats('month', '2026-09-15') as { energyWh: number };
    assert.ok(Math.abs(aug.energyWh - 3000) < 1, `August ${aug.energyWh}`);
    assert.ok(Math.abs(sep.energyWh - 3000) < 1, `September ${sep.energyWh}`);
  });

  test('ein kurzes, eindeutiges Abstecken ergibt zwei Ladevorgänge', () => {
    // Früher verschmolzen die, weil jede Abwesenheit zehn Minuten Frist hatte.
    const log = new ChargeSessionLog(tempDir());
    lade(log, new Date(2026, 7, 26, 18, 0), new Date(2026, 7, 26, 18, 20), 3000);
    steckAbAb(log, new Date(2026, 7, 26, 18, 20, 10), 5 * 60);
    lade(log, new Date(2026, 7, 26, 18, 26), new Date(2026, 7, 26, 18, 46), 3000);
    steckAbAb(log, new Date(2026, 7, 26, 18, 46, 10), 90);
    assert.equal(log.list().length, 2);
  });

  test('ein Cloud-Ausfall ist kein Steckereignis', () => {
    const log = new ChargeSessionLog(tempDir());
    lade(log, new Date(2026, 7, 26, 18, 0), new Date(2026, 7, 26, 18, 20), 3000);
    for (let t = new Date(2026, 7, 26, 18, 20, 10).getTime(); t < new Date(2026, 7, 26, 18, 25).getTime(); t += 10_000) {
      log.integrate(tick({ at: new Date(t), ev: charger({ connected: null, powerW: null, state: 'offline' }) }));
    }
    lade(log, new Date(2026, 7, 26, 18, 25), new Date(2026, 7, 26, 18, 45), 3000);
    steckAbAb(log, new Date(2026, 7, 26, 18, 45, 10), 90);
    assert.equal(log.list().length, 1);
    assert.equal(log.list()[0]!.hasGaps, true, 'die Ausfallzeit wurde nicht als Lücke vermerkt');
  });

  test('ein Messaussetzer von Minuten wird Lücke, nicht Energie', () => {
    const log = new ChargeSessionLog(tempDir());
    lade(log, new Date(2026, 7, 26, 18, 0), new Date(2026, 7, 26, 18, 10), 3000);
    // Zehn Minuten keine Messung, dann weiter.
    lade(log, new Date(2026, 7, 26, 18, 20), new Date(2026, 7, 26, 18, 30), 3000);
    const s = log.current()!;
    // Zweimal 590 s gemessenes Laden mit 3 kW; die zehn Minuten dazwischen nicht.
    assert.ok(Math.abs(s.energyWh - (2 * 590 * 3000) / 3600) < 1, `${s.energyWh} Wh — die Lücke wurde mitgezählt`);
    assert.equal(s.hasGaps, true);
  });

  test('Altbestand ohne Tagesaufteilung zählt als Näherung zum Starttag', () => {
    const dir = tempDir();
    const alt: ChargeSession = {
      id: 'alt', startedAt: new Date(2026, 7, 20, 23, 0).toISOString(),
      endedAt: new Date(2026, 7, 21, 2, 0).toISOString(),
      chargingSeconds: 10800, connectedSeconds: 10800, energyWh: 9000, maxPowerW: 3000,
      avgPowerW: 3000, socStartPercent: null, socEndPercent: null,
      split: { pvWh: 0, gridWh: 9000, batteryWh: {}, unknownWh: 0 },
      endReason: 'unplugged', faultText: null, hasGaps: false,
    };
    writeFileSync(join(dir, 'ev-sessions.json'), JSON.stringify({ version: 2, sessions: [alt], open: null }));
    const log = new ChargeSessionLog(dir);
    const tag = log.stats('day', '2026-08-20') as { energyWh: number; naeherungWh: number };
    assert.equal(tag.energyWh, 9000);
    assert.equal(tag.naeherungWh, 9000);
  });

  test('ungültige Einträge werden verworfen und die Datei aufbewahrt', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ev-sessions.json'), JSON.stringify({
      version: 3,
      sessions: [{ id: 'x', startedAt: 'gestern', energyWh: -5 }],
      open: null,
    }));
    const log = new ChargeSessionLog(dir);
    assert.equal(log.list().length, 0);
    assert.ok(readdirSync(dir).some((f) => f.includes('beschaedigt')), 'Originaldatei nicht aufbewahrt');
  });
});
