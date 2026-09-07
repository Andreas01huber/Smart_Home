/**
 * Tests des Regeldienstes — mit nachgebauter Wallbox.
 *
 * Die Rechnung ist anderswo geprüft (`ueberschuss.test.ts`, `laderegler.test.ts`).
 * Hier geht es um das, was der Dienst mit dem Ergebnis MACHT: Welcher Befehl
 * geht wirklich an die Wallbox hinaus, und wann geht keiner hinaus.
 *
 * Die Wallbox wird nachgebaut und schreibt jeden Befehl mit. Damit lassen sich
 * die drei Fälle prüfen, die man an der echten Anlage nur mit angestecktem Auto
 * und passendem Wetter sähe:
 *
 *   - Pausieren muss ABSCHALTEN, nicht auf den Mindeststrom heruntergehen.
 *     Sechs Ampere sind gut vier Kilowatt; ohne Sonne kämen die aus dem Netz.
 *   - Die erzwungene Volladung muss bis zur Obergrenze gehen, auch wenn die
 *     Rechnung Pause sagt — das ist ihr ganzer Zweck.
 *   - Lädt die Wallbox, obwohl sie abgeschaltet sein sollte, muss der Stopp
 *     erneut hinausgehen. Der Messwert gilt, nicht das Gedächtnis.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type {
  BatterySnapshot,
  EnergySnapshot,
  EvChargerSnapshot,
  PowerMetric,
} from '@energy/core';

import { Ladesteuerung } from './ladesteuerung.ts';
import type { AppConfig } from './config.ts';
import type { EnergyEngine, EngineState } from './engine.ts';

// ── Nachbauten ──────────────────────────────────────────────────────────────

interface Befehl {
  readonly art: 'strom' | 'schalter';
  readonly wert: number | boolean;
}

class WallboxAttrappe {
  readonly befehle: Befehl[] = [];
  fehlerBeimSenden: string | null = null;

  async ladestromGrenzen(): Promise<{ minA: number; maxA: number; schrittA: number }> {
    return { minA: 6, maxA: 16, schrittA: 1 };
  }

  async steuerfunktionen(): Promise<readonly { code: string; type: string; values: string }[]> {
    return [{ code: 'charge_cur_set', type: 'Integer', values: '{}' }];
  }

  async setzeLadestrom(ampere: number): Promise<number> {
    if (this.fehlerBeimSenden) throw new Error(this.fehlerBeimSenden);
    this.befehle.push({ art: 'strom', wert: ampere });
    return ampere;
  }

  async setzeLaden(an: boolean): Promise<void> {
    if (this.fehlerBeimSenden) throw new Error(this.fehlerBeimSenden);
    this.befehle.push({ art: 'schalter', wert: an });
  }
}

const prov = {
  connectorId: 'x',
  deviceId: 'x',
  measuredAt: new Date(),
  ageMs: 0,
  quality: 'live' as const,
};
const metrik = (valueW: number | null): PowerMetric => ({ valueW, provenance: prov });

function speicher(socPercent: number, entladenW: number): BatterySnapshot {
  return {
    deviceId: 'gross',
    displayName: 'Grosser Speicher',
    socPercent,
    chargeW: 0,
    dischargeW: entladenW,
    storedEnergyWh: null,
    usableCapacityWh: 20_000,
    ratedCapacityWh: null,
    state: entladenW > 0 ? 'discharging' : 'idle',
    provenance: prov,
  };
}

function wallboxZustand(opts: {
  angesteckt: boolean | null;
  leistungW: number | null;
  stromA?: number | null;
  offline?: boolean;
}): EvChargerSnapshot {
  return {
    deviceId: 'ev-charger:test',
    displayName: 'Wallbox',
    state: opts.offline ? 'offline' : (opts.leistungW ?? 0) > 50 ? 'charging' : 'idle',
    vehicleConnected: opts.angesteckt,
    chargePowerW: opts.leistungW,
    sessionEnergyWh: null,
    totalEnergyWh: null,
    maxCurrentA: opts.stromA ?? 16,
    temperatureC: null,
    vehicleSocPercent: null,
    faultText: null,
    provenance: prov,
  };
}

/** Eine Engine, deren Messwerte der Test von aussen setzt. */
class EngineAttrappe {
  state: EngineState | null = null;
  private hoerer: ((s: EngineState) => void)[] = [];

  current(): EngineState | null {
    return this.state;
  }

  subscribe(h: (s: EngineState) => void): () => void {
    this.hoerer.push(h);
    return () => {
      this.hoerer = this.hoerer.filter((x) => x !== h);
    };
  }

  setze(lage: {
    pv: number;
    hausOhneAuto: number;
    ev: number;
    angesteckt?: boolean | null;
    stromA?: number | null;
    soc?: number;
    entladen?: number;
    offline?: boolean;
  }): void {
    const entladen = lage.entladen ?? 0;
    const bedarf = lage.hausOhneAuto + lage.ev;
    const angebot = lage.pv + entladen;
    const snapshot: EnergySnapshot = {
      timestamp: new Date(),
      solarProductionW: metrik(lage.pv),
      houseConsumptionW: metrik(lage.hausOhneAuto + lage.ev),
      gridImportW: metrik(Math.max(0, bedarf - angebot)),
      gridExportW: metrik(Math.max(0, angebot - bedarf)),
      batteries: [speicher(lage.soc ?? 80, entladen)],
      evCharger: wallboxZustand({
        angesteckt: lage.angesteckt ?? true,
        leistungW: lage.ev,
        stromA: lage.stromA ?? null,
        ...(lage.offline === true ? { offline: true } : {}),
      }),
    };
    this.state = {
      resolution: { snapshot, unavailable: [], disagreements: [], derivedConsumptionNegative: false },
      readings: [],
      diagnostics: [],
      polledAt: new Date(),
      pollDurationMs: 1,
    };
  }
}

function konfiguration(ueber: Partial<AppConfig['ueberschuss']> = {}): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    pollIntervalMs: 2000,
    sources: { evCharger: { enabled: true, deviceId: 'x', phases: 3, voltageV: 400 } },
    sourceMapping: {
      solarProductionW: 'a',
      houseConsumptionW: 'derived',
      gridImportW: 'a',
      gridExportW: 'a',
    },
    announcedBatteries: [],
    tariff: { importPricePerKWh: 0.28, exportPricePerKWh: 0.08 },
    secretsPfad: 'unbenutzt',
    ueberschuss: {
      modus: 'regeln',
      intervallSekunden: 30,
      reserveW: 200,
      netzTotzoneW: 150,
      netzImportTotzoneW: 40,
      notbremseAbW: 300,
      maxMessalterSekunden: 30,
      // Fristen auf null: Das Zeitverhalten ist in laderegler.test.ts geprüft,
      // hier geht es um den Befehl, nicht um die Wartezeit davor.
      mindestabstandSekunden: 0,
      erhoehenNachSekunden: 0,
      senkenNachSekunden: 0,
      pausierenNachSekunden: 0,
      startenNachSekunden: 0,
      speicherEntladenErlaubt: false,
      speicher: {},
      speicherStandard: { minSocPercent: 50, entladenMaxW: 0 },
      ...ueber,
    },
  };
}

/** Baut Dienst, Engine und Wallbox und lässt so viele Zyklen laufen wie nötig. */
function aufbau(ueber: Partial<AppConfig['ueberschuss']> = {}): {
  engine: EngineAttrappe;
  wallbox: WallboxAttrappe;
  steuerung: Ladesteuerung;
  zyklus: () => Promise<void>;
} {
  const engine = new EngineAttrappe();
  const wallbox = new WallboxAttrappe();
  const steuerung = new Ladesteuerung(
    engine as unknown as EnergyEngine,
    wallbox as unknown as never,
    konfiguration(ueber),
  );
  // `start()` würde einen Zeitgeber aufziehen. Der Test taktet selbst.
  const zyklus = async (): Promise<void> => {
    await (steuerung as unknown as { zyklus: () => Promise<void> }).zyklus();
  };
  return { engine, wallbox, steuerung, zyklus };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Pausieren heisst abschalten', () => {
  let aufbauErgebnis: ReturnType<typeof aufbau>;
  beforeEach(() => {
    aufbauErgebnis = aufbau();
  });

  it('schaltet ab, statt auf den Mindeststrom zu gehen', async () => {
    const { engine, wallbox, zyklus } = aufbauErgebnis;
    // Nacht: keine Sonne, Auto zieht 4,2 kW aus dem Netz.
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 4157, stromA: 6 });
    await zyklus();

    assert.deepEqual(
      wallbox.befehle,
      [{ art: 'schalter', wert: false }],
      'es haette genau ein Abschaltbefehl kommen muessen',
    );
    // Und ganz sicher NICHT der Mindeststrom — das waeren 4,2 kW aus dem Netz.
    assert.equal(
      wallbox.befehle.some((b) => b.art === 'strom'),
      false,
      'hat einen Ladestrom gesetzt, statt abzuschalten',
    );
  });

  it('schaltet beim Wiederanlauf erst den Strom, dann ein', async () => {
    const { engine, wallbox, zyklus } = aufbauErgebnis;
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 4157, stromA: 6 });
    await zyklus();
    wallbox.befehle.length = 0;

    // Sonne kommt: 10 kW Überschuss.
    engine.setze({ pv: 11_000, hausOhneAuto: 500, ev: 0, stromA: 6 });
    await zyklus();

    assert.equal(wallbox.befehle.length, 2, JSON.stringify(wallbox.befehle));
    assert.equal(wallbox.befehle[0]?.art, 'strom', 'zuerst der Strom');
    assert.equal(wallbox.befehle[1]?.art, 'schalter', 'dann einschalten');
    assert.equal(wallbox.befehle[1]?.wert, true);
  });
});

describe('Volladung erzwingen', () => {
  it('lädt bis zur Obergrenze, obwohl die Rechnung Pause sagt', async () => {
    const { engine, wallbox, steuerung, zyklus } = aufbau();
    // Nacht, kein Überschuss — normal wäre das eine Pause.
    engine.setze({ pv: 0, hausOhneAuto: 800, ev: 0, stromA: 6 });
    await zyklus();
    assert.deepEqual(wallbox.befehle, [{ art: 'schalter', wert: false }]);
    wallbox.befehle.length = 0;

    steuerung.setzeVolladung(true);
    await zyklus();

    const strom = wallbox.befehle.find((b) => b.art === 'strom');
    assert.ok(strom, 'kein Ladestrom gesendet');
    assert.equal(strom.wert, 16, 'Volladung muss die Obergrenze setzen');
    assert.ok(
      wallbox.befehle.some((b) => b.art === 'schalter' && b.wert === true),
      'Ladung wurde nicht eingeschaltet',
    );
    assert.equal(steuerung.zustand().volladung, true);
    assert.match(steuerung.zustand().grund, /Volladung/);
  });

  it('endet und regelt wieder, sobald sie ausgeschaltet wird', async () => {
    const { engine, wallbox, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 0, hausOhneAuto: 800, ev: 11_085, stromA: 16 });
    steuerung.setzeVolladung(true);
    await zyklus();
    wallbox.befehle.length = 0;

    steuerung.setzeVolladung(false);
    await zyklus();

    assert.equal(steuerung.zustand().volladung, false);
    assert.ok(
      wallbox.befehle.some((b) => b.art === 'schalter' && b.wert === false),
      'nach dem Ende der Volladung haette abgeschaltet werden muessen',
    );
  });

  it('endet von selbst, wenn das Fahrzeug abgesteckt wird', async () => {
    const { engine, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 0, hausOhneAuto: 800, ev: 11_085, stromA: 16 });
    steuerung.setzeVolladung(true);
    await zyklus();
    assert.equal(steuerung.zustand().volladung, true);

    engine.setze({ pv: 0, hausOhneAuto: 800, ev: 0, angesteckt: false });
    await zyklus();

    assert.equal(
      steuerung.zustand().volladung,
      false,
      'Volladung darf nicht für den naechsten Ladevorgang weitergelten',
    );
  });
});

describe('Abgleich mit der Wirklichkeit', () => {
  it('schickt den Stopp erneut, wenn die Wallbox trotzdem lädt', async () => {
    const { engine, wallbox, zyklus } = aufbau();
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 4157, stromA: 6 });
    await zyklus();
    assert.deepEqual(wallbox.befehle, [{ art: 'schalter', wert: false }]);
    wallbox.befehle.length = 0;

    // Die Wallbox laedt weiter — abgeschaltet ist sie offensichtlich nicht.
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 4157, stromA: 6 });
    await zyklus();

    assert.deepEqual(
      wallbox.befehle,
      [{ art: 'schalter', wert: false }],
      'der Stopp haette wiederholt werden muessen',
    );
  });

  it('wiederholt nichts, wenn die Wallbox wirklich aus ist', async () => {
    const { engine, wallbox, zyklus } = aufbau();
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 4157, stromA: 6 });
    await zyklus();
    wallbox.befehle.length = 0;

    // Jetzt fliesst nichts mehr — es gibt nichts mehr zu tun.
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 0, stromA: 6 });
    await zyklus();
    assert.deepEqual(wallbox.befehle, [], 'hat ohne Not einen Befehl geschickt');
  });
});

describe('Fehler und Betriebsarten', () => {
  it('sendet im Beobachtungsmodus keinen einzigen Befehl', async () => {
    const { engine, wallbox, steuerung, zyklus } = aufbau({ modus: 'beobachten' });
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 4157, stromA: 6 });
    await zyklus();
    assert.deepEqual(wallbox.befehle, []);
    // Gerechnet wird trotzdem — sonst könnte man nicht zusehen.
    assert.match(steuerung.zustand().grund, /pausiert|beobachtet/i);
  });

  it('merkt sich einen Tuya-Fehler und glaubt nicht, gesendet zu haben', async () => {
    const { engine, wallbox, steuerung, zyklus } = aufbau();
    wallbox.fehlerBeimSenden = 'permission deny';
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 4157, stromA: 6 });
    await zyklus();

    assert.equal(steuerung.zustand().letzterFehler, 'permission deny');
    // Der Sollwert gilt NICHT als gesetzt — sonst würde nie wieder versucht.
    assert.notEqual(steuerung.zustand().gesetztA, 0);
  });

  it('rührt eine nicht erreichbare Wallbox nicht an', async () => {
    const { engine, wallbox, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 0, angesteckt: null, offline: true });
    await zyklus();
    assert.deepEqual(wallbox.befehle, []);
    assert.equal(steuerung.zustand().zustand, 'gestoert');
  });
});
