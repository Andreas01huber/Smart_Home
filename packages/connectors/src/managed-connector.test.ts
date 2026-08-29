import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ManagedConnector } from './managed-connector.ts';
import type { EnergyConnector, ConnectorDiagnostics } from './types.ts';
import type { ConnectorReading } from '@energy/core';

/** Steuerbarer Fake-Connector für die Statustests (STEP 59). */
class FakeConnector implements EnergyConnector {
  readonly id = 'fake';
  readonly displayName = 'Fake';
  online = true;
  reads = 0;

  async read(): Promise<ConnectorReading> {
    this.reads++;
    const q = this.online ? 'live' : 'offline';
    const metric = {
      valueW: this.online ? 1000 : null,
      provenance: { connectorId: this.id, deviceId: 'x', measuredAt: new Date(), ageMs: 0, quality: q as 'live' | 'offline' },
    };
    return {
      connectorId: this.id,
      timestamp: new Date(),
      solarProductionW: metric,
      houseConsumptionW: metric,
      gridImportW: metric,
      gridExportW: metric,
      batteries: [],
    };
  }

  diagnostics(): ConnectorDiagnostics {
    return {
      connectorId: this.id,
      displayName: this.displayName,
      online: this.online,
      responseTimeMs: this.online ? 10 : null,
      lastSuccessAt: this.online ? new Date() : null,
      detectedDevices: 1,
      availableMetrics: this.online ? 4 : 0,
      missingMetrics: [],
      errorCount: this.online ? 0 : 1,
      lastError: this.online ? null : 'timeout',
      mode: 'fake',
      endpoint: 'fake',
    };
  }
}

describe('ManagedConnector — Statusmodell (STEP 38/59)', () => {
  test('erste Messung -> online', async () => {
    const m = new ManagedConnector(new FakeConnector());
    await m.read();
    assert.equal(m.diagnostics().status, 'online');
  });

  test('erster Ausfall -> stale, nicht sofort offline', async () => {
    const fake = new FakeConnector();
    const m = new ManagedConnector(fake);
    await m.read(); // online
    fake.online = false;
    await m.read(); // 1. Fehler
    assert.equal(m.diagnostics().status, 'stale');
  });

  test('mehrere Ausfälle -> offline', async () => {
    const fake = new FakeConnector();
    const m = new ManagedConnector(fake);
    await m.read();
    fake.online = false;
    await m.read(); // 1
    await m.read(); // 2
    await m.read(); // 3 -> offline
    assert.equal(m.diagnostics().status, 'offline');
    assert.ok(m.diagnostics().consecutiveFailures >= 3);
  });

  test('offline blockiert nicht: liefert sofort letzte Messung ohne neue Abfrage', async () => {
    const fake = new FakeConnector();
    const m = new ManagedConnector(fake);
    await m.read();
    fake.online = false;
    await m.read(); await m.read(); await m.read(); // offline, nextProbe in 30s
    const before = fake.reads;
    await m.read(); // sollte NICHT sofort erneut abfragen (Backoff)
    assert.equal(fake.reads, before, 'kein zusätzlicher Netzzugriff während Backoff');
  });

  test('manueller Reconnect erfolgreich -> online', async () => {
    const fake = new FakeConnector();
    const m = new ManagedConnector(fake);
    await m.read();
    fake.online = false;
    await m.read(); await m.read(); await m.read(); // offline
    fake.online = true; // Gerät wieder da
    const diag = await m.reconnect();
    assert.equal(diag.status, 'online');
  });

  test('manueller Reconnect fehlgeschlagen -> bleibt offline', async () => {
    const fake = new FakeConnector();
    const m = new ManagedConnector(fake);
    await m.read();
    fake.online = false;
    await m.read(); await m.read(); await m.read();
    const diag = await m.reconnect(); // Gerät weiterhin offline
    assert.ok(diag.status === 'offline' || diag.status === 'stale');
    assert.equal(diag.online, false);
  });
});
