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

function speicher(socPercent: number, entladenW: number, ladenW = 0): BatterySnapshot {
  return {
    deviceId: 'gross',
    displayName: 'Grosser Speicher',
    socPercent,
    chargeW: ladenW,
    dischargeW: entladenW,
    storedEnergyWh: null,
    usableCapacityWh: 20_000,
    ratedCapacityWh: null,
    state: entladenW > 0 ? 'discharging' : ladenW > 0 ? 'charging' : 'idle',
    provenance: prov,
  };
}

function wallboxZustand(opts: {
  angesteckt: boolean | null;
  leistungW: number | null;
  stromA?: number | null;
  schalterAn?: boolean | null;
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
    schalterAn: opts.schalterAn ?? null,
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

  /** Den Messtakt auslösen — der Dienst hängt daran und lernt daraus. */
  melde(): void {
    if (this.state) for (const h of this.hoerer) h(this.state);
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
    laden?: number;
    schalterAn?: boolean | null;
    offline?: boolean;
  }): void {
    const entladen = lage.entladen ?? 0;
    const laden = lage.laden ?? 0;
    const bedarf = lage.hausOhneAuto + lage.ev + laden;
    const angebot = lage.pv + entladen;
    const snapshot: EnergySnapshot = {
      timestamp: new Date(),
      solarProductionW: metrik(lage.pv),
      houseConsumptionW: metrik(lage.hausOhneAuto + lage.ev),
      gridImportW: metrik(Math.max(0, bedarf - angebot)),
      gridExportW: metrik(Math.max(0, angebot - bedarf)),
      batteries: [speicher(lage.soc ?? 80, entladen, laden)],
      evCharger: wallboxZustand({
        angesteckt: lage.angesteckt ?? true,
        leistungW: lage.ev,
        stromA: lage.stromA ?? null,
        schalterAn: lage.schalterAn ?? null,
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
      senkenBeiBezugSekunden: 0,
      pausierenNachSekunden: 0,
      startenNachSekunden: 0,
      haushaltMaxA: 10,
      speicherEntladenErlaubt: false,
      speicher: {},
      speicherStandard: { minSocPercent: 50, entladenMaxW: 0, autoVorrangAbSocPercent: 80 },
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

/** So viele Freigaben ohne Ladung, bis die Regelung aufgibt (siehe Dienst). */
const VERSUCHE = 3;

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

describe('Handbetrieb auf dem Höchstwert (früher "Volladung")', () => {
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
    assert.equal(steuerung.zustand().betriebsart, 'manuell');
    assert.match(steuerung.zustand().grund, /Handbetrieb/);
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

describe('Die Speicher als Überschussquelle', () => {
  /** Speicher gross, fast voll, Entladen erlaubt. */
  const MIT_SPEICHER = {
    speicherEntladenErlaubt: true,
    speicher: {
      gross: { minSocPercent: 40, entladenMaxW: 4000, autoVorrangAbSocPercent: 80 },
    },
  } as const;

  it('holt sich die Ladeleistung des vollen Speichers — der Fall vom 8.9.', async () => {
    // Sonne 7,3 kW, Haus 1,3 kW, und der Rest verschwindet im Speicher: keine
    // Einspeisung, kein Netzbezug. Genau hier sah die alte Rechnung nichts.
    const { engine, wallbox, zyklus } = aufbau(MIT_SPEICHER);
    engine.setze({ pv: 7325, hausOhneAuto: 1250, ev: 0, soc: 96, laden: 6075, stromA: 0 });
    await zyklus();

    const strom = wallbox.befehle.find((b) => b.art === 'strom');
    assert.ok(strom, 'kein Ladestrom gesetzt — der Speicherüberschuss blieb ungenutzt');
    assert.ok(
      (strom.wert as number) >= 8,
      `nur ${String(strom.wert)} A — die 6 kW im Speicher wurden nicht erkannt`,
    );
  });

  it('lässt den Speicher in Ruhe, solange er nicht voll ist', async () => {
    // Dieselbe Lage, aber der Speicher steht bei 55 %. Dann hat er Vorrang:
    // Was abends fehlt, käme aus dem Netz.
    const { engine, wallbox, zyklus } = aufbau(MIT_SPEICHER);
    engine.setze({ pv: 7325, hausOhneAuto: 1250, ev: 0, soc: 55, laden: 6075, stromA: 0 });
    await zyklus();

    assert.equal(
      wallbox.befehle.some((b) => b.art === 'strom'),
      false,
      'hat dem halbvollen Speicher den Überschuss weggenommen',
    );
  });

  it('plant Entladeleistung erst ein, wenn der Speicher sie bewiesen hat', async () => {
    // Nichts gelernt: Der Speicher steht still, die Sonne reicht allein nicht
    // für den Mindestladestrom. Die konfigurierten 4000 W sind ein Versprechen
    // und dürfen nicht zählen.
    const ohne = aufbau(MIT_SPEICHER);
    ohne.engine.setze({ pv: 3000, hausOhneAuto: 500, ev: 0, soc: 100, stromA: 0 });
    await ohne.zyklus();
    assert.equal(
      ohne.wallbox.befehle.some((b) => b.art === 'strom'),
      false,
      'hat auf ein Versprechen hin geladen',
    );

    // Derselbe Moment, aber der Speicher hat heute schon 4000 W geliefert.
    const mit = aufbau(MIT_SPEICHER);
    mit.steuerung.lerneAus([{ id: 'gross', entladenW: 4000, tMs: Date.now() - 60_000 }]);
    mit.engine.setze({ pv: 3000, hausOhneAuto: 500, ev: 0, soc: 100, stromA: 0 });
    await mit.zyklus();
    const strom = mit.wallbox.befehle.find((b) => b.art === 'strom');
    assert.ok(strom, 'hat den nachgewiesenen Speicher nicht eingeplant');
    // 0 + 2500 Einspeisung - 200 Reserve + 4000 nachgewiesen = 6300 W -> 9 A.
    assert.equal(strom.wert, 9);
  });

  it('vergisst einen Nachweis, der älter als einen Tag ist', async () => {
    // Gestern konnte der Speicher 4000 W. Das ist keine Zusage für heute:
    // Zellen altern, Wechselrichtergrenzen ändern sich, und die Regelung soll
    // sich lieber neu überzeugen lassen.
    const { engine, wallbox, steuerung, zyklus } = aufbau(MIT_SPEICHER);
    steuerung.lerneAus([
      { id: 'gross', entladenW: 4000, tMs: Date.now() - 25 * 60 * 60 * 1000 },
    ]);
    engine.setze({ pv: 3000, hausOhneAuto: 500, ev: 0, soc: 100, stromA: 0 });
    await zyklus();

    assert.equal(
      wallbox.befehle.some((b) => b.art === 'strom'),
      false,
      'hat sich auf einen Nachweis von gestern verlassen',
    );
  });
});

describe('Abgleich mit der Wirklichkeit, beide Richtungen', () => {
  it('startet neu, wenn die Wallbox abgeschaltet ist, obwohl Strom gesetzt wäre', async () => {
    // Der echte Fund vom 8.9.: charge_cur_set 16, switch false. Die Wallbox
    // hatte sich selbst abgeschaltet — kein Befehl von uns. Die Regelung hielt
    // 16 A für gesetzt und schwieg, während 11 kW Überschuss dastanden.
    // Regelabstand null, damit der Schutz gegen zu frühes Nachfassen (siehe
    // nächster Test) hier nicht im Weg steht — geprüft wird der Abgleich selbst.
    const { engine, wallbox, zyklus } = aufbau({ intervallSekunden: 0 });
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 11_085, stromA: 16, schalterAn: true });
    await zyklus();
    wallbox.befehle.length = 0;
    await new Promise((fertig) => setTimeout(fertig, 5));

    // Ab jetzt meldet das Gerät den Schalter als aus, ohne dass wir das wollten.
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 16, schalterAn: false });
    await zyklus();

    assert.deepEqual(
      wallbox.befehle,
      [{ art: 'strom', wert: 16 }, { art: 'schalter', wert: true }],
      'die Wallbox blieb aus, obwohl der Überschuss da war',
    );
  });

  it('fasst nicht nach, solange der eigene Befehl noch frisch ist', async () => {
    // Die Tuya-Cloud meldet den alten Schalterzustand nach dem Einschalten noch
    // eine Weile. Würde die Regelung darauf hereinfallen, setzte sie sich
    // sofort selbst zurück und käme nie über den Start hinaus.
    const { engine, wallbox, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 6, schalterAn: false });
    await zyklus();
    const nachErstem = wallbox.befehle.length;

    // Gleich noch ein Zyklus, Gerät meldet weiterhin "aus".
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 16, schalterAn: false });
    await zyklus();

    assert.equal(
      wallbox.befehle.length,
      nachErstem,
      'hat den eigenen, gerade erst gesendeten Befehl nicht abgewartet',
    );
  });

  it('lässt eine Wallbox ohne Schaltermeldung in Ruhe', async () => {
    // Nicht jedes Gerät meldet einen Schalter. null darf nie als "aus" gelten.
    const { engine, wallbox, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 11_085, stromA: 16, schalterAn: null });
    await zyklus();
    wallbox.befehle.length = 0;
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 11_085, stromA: 16, schalterAn: null });
    await zyklus();
    assert.deepEqual(wallbox.befehle, [], 'hat grundlos nachgefasst');
  });
});

describe('Betriebsarten: autark, Handbetrieb, Volladung', () => {
  it('ist beim Start autark — die sichere Vorgabe', async () => {
    const { engine, zyklus, steuerung } = aufbau();
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 4157, stromA: 6 });
    await zyklus();
    assert.equal(steuerung.zustand().betriebsart, 'intelligent');
    // Und autark heisst: Bei Nacht wird abgeschaltet, nicht geladen.
    assert.equal(steuerung.zustand().zielA, 0);
  });

  it('lädt im Handbetrieb mit dem eingestellten Strom, auch ohne Sonne', async () => {
    const { engine, wallbox, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 0, stromA: 0 });
    await zyklus();
    wallbox.befehle.length = 0;

    steuerung.setzeBetriebsart('manuell', 10);
    await zyklus();

    assert.deepEqual(
      wallbox.befehle.filter((b) => b.art === 'strom'),
      [{ art: 'strom', wert: 10 }],
      'der eingestellte Ladestrom kam nicht an der Wallbox an',
    );
    assert.ok(
      wallbox.befehle.some((b) => b.art === 'schalter' && b.wert === true),
      'es wurde nicht eingeschaltet',
    );
  });

  it('hält sich auch von Hand an die Grenzen des Geräts', async () => {
    // 25 A gibt es nicht. Die Regelung darf niemals einen Wert setzen, den
    // Wallbox oder Fahrzeug nicht zulassen — auch nicht auf Zuruf.
    const { engine, wallbox, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 0 });
    steuerung.setzeBetriebsart('manuell', 25);
    await zyklus();
    assert.equal(wallbox.befehle.find((b) => b.art === 'strom')?.wert, 16);

    const zweiter = aufbau();
    zweiter.engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 0 });
    zweiter.steuerung.setzeBetriebsart('manuell', 2);
    await zweiter.zyklus();
    assert.equal(zweiter.wallbox.befehle.find((b) => b.art === 'strom')?.wert, 6);
  });

  it('geht beim Abstecken von selbst auf autark zurück', async () => {
    const { engine, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 0 });
    steuerung.setzeBetriebsart('manuell', 16);
    await zyklus();
    assert.equal(steuerung.zustand().betriebsart, 'manuell');

    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, angesteckt: false });
    await zyklus();
    assert.equal(
      steuerung.zustand().betriebsart,
      'intelligent',
      'die Übersteuerung galt still für den nächsten Ladevorgang weiter',
    );
  });

  it('wartet von Hand keine Beobachtungszeit ab', async () => {
    // Mit den echten Fristen: Nach einer Pause verlangt die Beruhigung zwei
    // Minuten, bevor sie wieder startet. Das ist gegen Wolken gedacht, nicht
    // gegen Menschen — wer den Regler bewegt, will es sofort sehen.
    const { engine, wallbox, steuerung, zyklus } = aufbau({
      startenNachSekunden: 120,
      erhoehenNachSekunden: 90,
      mindestabstandSekunden: 60,
    });
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 4157, stromA: 6 });
    await zyklus();
    wallbox.befehle.length = 0;

    steuerung.setzeBetriebsart('manuell', 12);
    await zyklus();
    assert.equal(
      wallbox.befehle.find((b) => b.art === 'strom')?.wert,
      12,
      'der Handbefehl wurde von der Beobachtungszeit aufgehalten',
    );
  });

  it('sendet nicht bei jedem Zyklus denselben Handbefehl noch einmal', async () => {
    const { engine, wallbox, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 0, schalterAn: true });
    steuerung.setzeBetriebsart('manuell', 10);
    await zyklus();
    const nachErstem = wallbox.befehle.length;

    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 6930, stromA: 10, schalterAn: true });
    await zyklus();
    await zyklus();
    assert.equal(wallbox.befehle.length, nachErstem, 'hat unnötig nachgesendet');
  });

  it('meldet Betriebsart und Ladestrom an die Oberfläche', async () => {
    const { engine, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 0 });
    steuerung.setzeBetriebsart('manuell', 11);
    await zyklus();
    const z = steuerung.zustand();
    assert.equal(z.betriebsart, 'manuell');
    assert.equal(z.manuellA, 11);
    assert.equal(z.volladung, false);
    const k = steuerung.kurz();
    assert.equal(k.betriebsart, 'manuell');
    assert.equal(k.manuellA, 11);
    assert.equal(k.minA, 6);
    assert.equal(k.maxA, 16);
  });
});

describe('Handbetrieb übernimmt den laufenden Ladestrom', () => {
  it('startet dort, wo die Automatik gerade steht', async () => {
    // Wer bei 16 A auf Hand umschaltet, erwartet 16 A und keinen Sprung auf
    // den Mindestwert.
    const { engine, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 9700, stromA: 14, schalterAn: true });
    await zyklus();
    assert.equal(steuerung.zustand().gesetztA, 16, 'Aufbau stimmt nicht');

    steuerung.setzeBetriebsart('manuell');
    assert.equal(steuerung.zustand().manuellA, 16);
  });

  it('nimmt den Wert vom Gerät, wenn selbst noch nie gesendet wurde', async () => {
    // Im Beobachtungsmodus hat diese Regelung nie einen Befehl geschickt und
    // weiss aus eigener Erinnerung nichts. Das Geraet weiss es.
    const { engine, steuerung, zyklus } = aufbau({ modus: 'beobachten' });
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 9700, stromA: 14, schalterAn: true });
    await zyklus();

    steuerung.setzeBetriebsart('manuell');
    assert.equal(steuerung.zustand().manuellA, 14);
  });

  it('behält den Handwert über einen Wechsel und zurück', async () => {
    const { engine, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 6 });
    await zyklus();
    steuerung.setzeBetriebsart('manuell', 11);
    await zyklus();
    steuerung.setzeBetriebsart('intelligent');
    await zyklus();
    assert.equal(steuerung.zustand().manuellA, 11, 'der Handwert ging verloren');
  });
});

describe('Fahrzeug nimmt die Freigabe nicht an', () => {
  /**
   * Spielt nach, was an der Anlage wirklich passiert: Die Regelung gibt frei,
   * das Fahrzeug nimmt nichts ab, und die Wallbox lässt den Schütz nach einer
   * Minute von selbst wieder fallen. Beim nächsten Zyklus beginnt das von vorn.
   */
  async function biete(a: ReturnType<typeof aufbau>, male: number): Promise<void> {
    for (let i = 0; i < male; i++) {
      a.engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 16, schalterAn: false });
      // Der Abgleich mit der Wirklichkeit wartet einen Regelabstand ab, bevor
      // er dem gemeldeten Schalterzustand glaubt — hier auf null gesetzt.
      await new Promise((f) => setTimeout(f, 5));
      await a.zyklus();
    }
  }

  it('gibt nach drei erfolglosen Freigaben auf und schaltet ab', async () => {
    const a = aufbau({ intervallSekunden: 0 });
    await biete(a, VERSUCHE + 1);

    assert.equal(a.steuerung.zustand().fordertNicht, true);
    assert.equal(a.steuerung.zustand().zustand, 'fordert-nicht');
    assert.match(a.steuerung.zustand().grund, /nimmt keinen Strom/);

    // Und vor allem: Es geht keine weitere Freigabe mehr hinaus. Genau das war
    // der Zustand an der Anlage — alle paar Minuten ein Schuetz, das gleich
    // wieder abfaellt, und in der App stand die ganze Zeit "laedt".
    a.wallbox.befehle.length = 0;
    await biete(a, 3);
    assert.deepEqual(a.wallbox.befehle, [], 'hat weiter angeboten');
  });

  it('gibt nicht auf, solange das Auto zugreift', async () => {
    const a = aufbau();
    for (let i = 0; i < 5; i++) {
      a.engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 11_085, stromA: 16, schalterAn: true });
      // Sobald Strom fliesst, sind alle Zweifel erledigt.
      await a.zyklus();
    }
    assert.equal(a.steuerung.zustand().fordertNicht, false);
  });

  it('fängt nach dem Abstecken von vorn an', async () => {
    const a = aufbau({ intervallSekunden: 0 });
    await biete(a, VERSUCHE + 1);
    assert.equal(a.steuerung.zustand().fordertNicht, true);

    a.engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, angesteckt: false });
    await a.zyklus();
    assert.equal(a.steuerung.zustand().fordertNicht, false);
  });

  it('versucht es sofort wieder, wenn der Mensch umschaltet', async () => {
    const a = aufbau({ intervallSekunden: 0 });
    await biete(a, VERSUCHE + 1);
    assert.equal(a.steuerung.zustand().fordertNicht, true);

    a.steuerung.setzeBetriebsart('manuell', 10);
    assert.equal(a.steuerung.zustand().fordertNicht, false);
  });
});

describe('An welcher Dose steckt das Auto?', () => {
  it('erkennt die Haushaltssteckdose an der Leistung', async () => {
    const { engine, steuerung, zyklus } = aufbau();
    // 10 A eingestellt, 2300 W gemessen — das kann nur einphasig sein.
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 2300, stromA: 10, schalterAn: true });
    await zyklus();

    const a = steuerung.zustand().anschluss;
    assert.equal(a.phasen, 1);
    assert.equal(a.name, 'Haushaltssteckdose');
    assert.equal(a.wattProAmpere, 230);
  });

  it('erkennt die Starkstromdose und ihre echte Spannung', async () => {
    const { engine, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 14_000, hausOhneAuto: 500, ev: 10_084, stromA: 15, schalterAn: true });
    await zyklus();

    const a = steuerung.zustand().anschluss;
    assert.equal(a.phasen, 3);
    assert.equal(a.name, 'Starkstromdose');
    assert.equal(a.spannungV, 388);
  });

  it('bleibt beim Bekannten, solange nichts fliesst', async () => {
    const { engine, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 2300, stromA: 10, schalterAn: true });
    await zyklus();
    assert.equal(steuerung.zustand().anschluss.phasen, 1);

    // Auto steht: keine Messung, also keine neue Erkenntnis — und die alte
    // Auskunft bleibt richtig.
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 10, schalterAn: false });
    await zyklus();
    assert.equal(steuerung.zustand().anschluss.phasen, 1);
  });
});

describe('Haushaltssteckdose begrenzt den Ladestrom', () => {
  /** Bringt den Dienst dazu, die Haushaltsdose zu erkennen. */
  async function anHaushaltsdose(
    ueber: Partial<AppConfig['ueberschuss']> = {},
  ): Promise<ReturnType<typeof aufbau>> {
    const a = aufbau({ haushaltMaxA: 10, ...ueber });
    // 10 A eingestellt, 2300 W gemessen — das kann nur einphasig sein.
    a.engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 2300, stromA: 10, schalterAn: true });
    await a.zyklus();
    assert.equal(a.steuerung.zustand().anschluss.phasen, 1, 'Dose nicht erkannt');
    return a;
  }

  it('geht auch bei viel Überschuss nicht über die Dauergrenze', async () => {
    // Zwölf Kilowatt Sonne — dreiphasig wären das 16 A. An einer Schuko-Dose
    // sind 16 A im Dauerbetrieb die klassische Ursache für geschmolzene
    // Kontakte, deshalb ist bei zehn Schluss.
    const a = await anHaushaltsdose();
    a.wallbox.befehle.length = 0;
    a.engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 2300, stromA: 10, schalterAn: true });
    await a.zyklus();
    assert.ok(a.steuerung.zustand().zielA <= 10, `${a.steuerung.zustand().zielA} A gesetzt`);
  });

  it('begrenzt auch den Handbetrieb', async () => {
    // Von Hand 16 A einzustellen ist ein Wunsch, keine Erlaubnis: Die Regel
    // dieser Anlage lautet, dass die Software nie über das hinausgeht, was die
    // Elektroinstallation zulässt.
    const a = await anHaushaltsdose();
    a.wallbox.befehle.length = 0;
    a.steuerung.setzeBetriebsart('manuell', 16);
    await a.zyklus();
    // Gesetzt wird nur, was sich aendert — geprueft wird deshalb das Ziel, nicht
    // der Befehl: Steht die Wallbox schon auf 10 A, geht zu Recht nichts hinaus.
    assert.equal(a.steuerung.zustand().zielA, 10);
    assert.match(a.steuerung.zustand().grund, /Haushaltssteckdose/);
  });

  it('lässt an der Starkstromdose alles zu', async () => {
    const a = aufbau({ haushaltMaxA: 10 });
    a.engine.setze({ pv: 14_000, hausOhneAuto: 500, ev: 10_084, stromA: 15, schalterAn: true });
    await a.zyklus();
    assert.equal(a.steuerung.zustand().anschluss.phasen, 3);
    a.steuerung.setzeBetriebsart('manuell', 16);
    await a.zyklus();
    assert.equal(a.steuerung.zustand().zielA, 16);
    assert.doesNotMatch(a.steuerung.zustand().grund, /Haushaltssteckdose/);
  });
});

describe('Laden von Hand beenden', () => {
  it('schaltet ab, auch wenn die Sonne scheint', async () => {
    const { engine, wallbox, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 11_085, stromA: 16, schalterAn: true });
    await zyklus();
    wallbox.befehle.length = 0;

    steuerung.setzeGestoppt(true);
    await zyklus();

    assert.equal(steuerung.zustand().gestoppt, true);
    assert.equal(steuerung.zustand().zustand, 'gestoppt');
    assert.deepEqual(wallbox.befehle, [{ art: 'schalter', wert: false }]);
  });

  it('überstimmt auch den Handbetrieb', async () => {
    const { engine, wallbox, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 0, hausOhneAuto: 500, ev: 0, stromA: 6 });
    steuerung.setzeBetriebsart('manuell', 12);
    await zyklus();
    wallbox.befehle.length = 0;

    steuerung.setzeGestoppt(true);
    await zyklus();
    assert.equal(steuerung.zustand().zielA, 0);
    assert.equal(
      wallbox.befehle.some((b) => b.art === 'strom'),
      false,
      'hat trotz Stopp einen Ladestrom gesetzt',
    );
  });

  it('nimmt beim Fortsetzen die eingestellte Betriebsart zurück', async () => {
    const { engine, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, stromA: 6 });
    steuerung.setzeBetriebsart('manuell', 12);
    await zyklus();
    steuerung.setzeGestoppt(true);
    await zyklus();

    steuerung.setzeGestoppt(false);
    await zyklus();
    assert.equal(steuerung.zustand().gestoppt, false);
    assert.equal(steuerung.zustand().betriebsart, 'manuell');
    assert.equal(steuerung.zustand().zielA, 12);
  });

  it('endet beim Abstecken', async () => {
    const { engine, steuerung, zyklus } = aufbau();
    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 11_085, stromA: 16 });
    await zyklus();
    steuerung.setzeGestoppt(true);
    await zyklus();
    assert.equal(steuerung.zustand().gestoppt, true);

    engine.setze({ pv: 12_000, hausOhneAuto: 500, ev: 0, angesteckt: false });
    await zyklus();
    assert.equal(
      steuerung.zustand().gestoppt,
      false,
      'der Stopp galt still für den nächsten Ladevorgang weiter',
    );
  });
});
