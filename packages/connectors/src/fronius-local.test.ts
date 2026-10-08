/**
 * Zählerstände aus der Solar API — mit nachgebautem HTTP.
 *
 * Geprüft wird die Zuordnung, nicht das Netzwerk: Welche Felder werden zu
 * welchem Zähler, und wann bleibt ein Zähler bewusst leer.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { FroniusLocalConnector } from './fronius-local.ts';

const echteFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = echteFetch; });

function antworten(karte: Record<string, unknown>): void {
  globalThis.fetch = (async (eingabe: string | URL | Request) => {
    const url = String(eingabe);
    const pfad = Object.keys(karte).find((k) => url.includes(k));
    if (pfad === undefined) return new Response('nicht da', { status: 404 });
    return new Response(JSON.stringify(karte[pfad]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const kopf = { Head: { Timestamp: new Date().toISOString() } };
const powerFlow = (site: Record<string, unknown>) => ({ ...kopf, Body: { Data: { Site: site } } });
const meter = (eintraege: Record<string, unknown>) => ({ ...kopf, Body: { Data: eintraege } });

describe('FroniusLocalConnector — Zählerstände', () => {
  it('Symo ohne Speicher: E_Total ist der PV-Zähler, kein Meter → keine Netzzähler', async () => {
    antworten({
      GetPowerFlowRealtimeData: powerFlow({ P_PV: 1200, P_Grid: null, P_Load: null, E_Total: 12_345_678 }),
    });
    const r = await new FroniusLocalConnector({ host: 'symo', connectorId: 'fronius-local' }).read();
    assert.equal(r.counters?.solarWh?.valueWh, 12_345_678);
    assert.equal(r.counters?.gridImportWh, null);
    assert.equal(r.counters?.gridExportWh, null);
  });

  it('Hybrid mit Speicher: E_Total ist KEIN PV-Zähler, der Meter am Netzpunkt liefert Bezug/Einspeisung', async () => {
    antworten({
      GetPowerFlowRealtimeData: powerFlow({ P_PV: 3000, P_Grid: -1500, P_Load: -900, P_Akku: -600, E_Total: 99_000 }),
      GetStorageRealtimeData: { ...kopf, Body: { Data: { '0': { Controller: { StateOfCharge_Relative: 55, DesignedCapacity: 11_059 } } } } },
      GetMeterRealtimeData: meter({
        '0': { Meter_Location_Current: 0, EnergyReal_WAC_Sum_Consumed: 4_000_000, EnergyReal_WAC_Sum_Produced: 9_000_000 },
      }),
    });
    const r = await new FroniusLocalConnector({ host: 'gen24', connectorId: 'fronius-gen24' }).read();
    assert.equal(r.batteries.length, 1);
    assert.equal(r.counters?.solarWh, null, 'AC-Energie eines Hybrids enthält die Speicherentladung');
    assert.equal(r.counters?.gridImportWh?.valueWh, 4_000_000);
    assert.equal(r.counters?.gridExportWh?.valueWh, 9_000_000);
    assert.equal(r.counters?.gridImportWh?.provenance.quality, 'live');
  });

  it('ein Meter an der Last (Location 1) ist kein Netzzähler', async () => {
    antworten({
      GetPowerFlowRealtimeData: powerFlow({ P_PV: 0 }),
      GetMeterRealtimeData: meter({ '0': { Meter_Location_Current: 1, EnergyReal_WAC_Sum_Consumed: 1, EnergyReal_WAC_Sum_Produced: 2 } }),
    });
    const r = await new FroniusLocalConnector({ host: 'x' }).read();
    assert.equal(r.counters?.gridImportWh, null);
  });

  it('nutzt die Frischegrenzen der Solar API unabhängig von der Connector-ID', async () => {
    antworten({ GetPowerFlowRealtimeData: { Head: { Timestamp: new Date(Date.now() - 20_000).toISOString() }, Body: { Data: { Site: { P_PV: 1 } } } } });
    const r = await new FroniusLocalConnector({ host: 'x', connectorId: 'irgendein-name' }).read();
    assert.equal(r.solarProductionW?.provenance.quality, 'stale', '20 s alt ist für die Solar API veraltet (15 s)');
  });
});