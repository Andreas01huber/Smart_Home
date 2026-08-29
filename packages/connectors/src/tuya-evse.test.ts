/**
 * Tests der Datenpunkt-Zuordnung für das Tuya-EV-Ladegerät.
 *
 * Die Erwartungswerte stammen aus der Geräte-Spezifikation, die der Aimiler EV
 * Charger am 26.08.2026 selbst geliefert hat — nicht aus Annahmen.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evSnapshotFromTuyaStatus } from './tuya-evse.ts';

const META = { connectorId: 'ev-charger', deviceId: 'dev1', displayName: 'Leapmotor C10' };
const snap = (entries: Record<string, unknown>) =>
  evSnapshotFromTuyaStatus(
    Object.entries(entries).map(([code, value]) => ({ code, value })),
    META,
  );

/** Realer Zustand ohne Fahrzeug, wie am Gerät gemessen. */
const IDLE = {
  forward_energy_total: 0,
  work_state: 'charger_free',
  charge_cur_set: 6,
  power_total: 0,
  connection_state: 'controlpi_12v',
  work_mode: 'charge_now',
  switch: false,
  temp_current: 39,
  charge_energy_once: 1,
};

describe('Tuya-EVSE — Zuordnung der Datenpunkte', () => {
  it('erkennt den realen Ruhezustand ohne Fahrzeug', () => {
    const s = snap(IDLE);
    assert.equal(s.state, 'idle');
    assert.equal(s.vehicleConnected, false);
    assert.equal(s.chargePowerW, 0);
    assert.equal(s.temperatureC, 39);
    assert.equal(s.maxCurrentA, 6);
    assert.equal(s.faultText, null);
  });

  it('meldet ohne Fahrzeug KEINE Sitzungsenergie, statt den Restwert zu zeigen', () => {
    // charge_energy_once ist 1 (= 0,01 kWh) obwohl nie geladen wurde.
    assert.equal(snap(IDLE).sessionEnergyWh, null);
  });

  it('gibt den Fahrzeug-Ladestand NIEMALS aus — AC-Laden überträgt ihn nicht', () => {
    for (const state of ['charger_free', 'charger_insert', 'charger_charging']) {
      assert.equal(snap({ ...IDLE, work_state: state }).vehicleSocPercent, null);
    }
  });

  it('rechnet Leistung und Energie korrekt um (kW scale 3, kWh scale 2)', () => {
    const s = snap({
      ...IDLE,
      connection_state: 'controlpi_6v',
      work_state: 'charger_charging',
      power_total: 3680, // 3,680 kW
      forward_energy_total: 1234, // 12,34 kWh
      charge_energy_once: 850, // 8,50 kWh
    });
    assert.equal(s.chargePowerW, 3680); // W
    assert.equal(s.totalEnergyWh, 12_340);
    assert.equal(s.sessionEnergyWh, 8500);
    assert.equal(s.state, 'charging');
    assert.equal(s.vehicleConnected, true);
  });

  it('leitet den Anschlusszustand aus der Control-Pilot-Spannung ab', () => {
    const connected = (cs: string) => snap({ ...IDLE, connection_state: cs }).vehicleConnected;
    assert.equal(connected('controlpi_12v'), false);
    assert.equal(connected('controlpi_12v_pwm'), false);
    assert.equal(connected('controlpi_9v'), true);
    assert.equal(connected('controlpi_9v_pwm'), true);
    assert.equal(connected('controlpi_6v'), true);
    // Fehler heisst "unbekannt", nicht "nicht angeschlossen".
    assert.equal(connected('controlpi_error'), null);
  });

  it('meldet Störungen im Klartext', () => {
    assert.match(snap({ ...IDLE, work_state: 'charger_fault' }).faultText ?? '', /Störung/);
    assert.equal(snap({ ...IDLE, work_state: 'charger_fault' }).state, 'fault');
  });

  it('macht aus fehlenden Feldern null — niemals 0', () => {
    const s = snap({ work_state: 'charger_free', connection_state: 'controlpi_12v' });
    assert.equal(s.chargePowerW, null);
    assert.equal(s.totalEnergyWh, null);
    assert.equal(s.temperatureC, null);
    assert.equal(s.maxCurrentA, null);
  });

  it('verkraftet unbekannte Zustände, ohne zu raten', () => {
    const s = snap({ ...IDLE, work_state: 'irgendwas_neues' });
    assert.equal(s.state, 'unknown');
  });
});
