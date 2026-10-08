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

describe('ManagedConnector — Fristen, Fehler, Gleichzeitigkeit', () => {
  test('eine nie endende Quelle hält die Abfrage nicht fest', async () => {
    const f = new FakeConnector();
    const m = new ManagedConnector(f, { deadlineMs: 50 });
    await m.read(); // erste Messung gelingt
    f.read = () => new Promise<ConnectorReading>(() => undefined);
    const start = Date.now();
    const r = await m.read();
    assert.ok(Date.now() - start < 1000, 'die Frist hat nicht gegriffen');
    assert.ok(r, 'die frühere Messung wurde nicht zurückgegeben');
    const d = m.diagnostics();
    assert.match(d.lastError ?? '', /keine Antwort/);
    assert.equal(d.consecutiveFailures, 1);
  });

  test('ein geworfener Fehler zählt als Fehlversuch mit Diagnose und Backoff', async () => {
    const f = new FakeConnector();
    const m = new ManagedConnector(f, { backoffScheduleMs: [1000] });
    await m.read();
    f.read = async () => { throw new Error('Socket kaputt'); };
    for (let i = 0; i < 3; i++) await m.read();
    const d = m.diagnostics();
    assert.equal(d.status, 'offline');
    assert.match(d.lastError ?? '', /Socket kaputt/);
    assert.ok((d.nextProbeInMs ?? 0) > 0, 'kein Backoff geplant');
  });

  test('ohne frühere Messung wird der Fehler weitergegeben — nicht verschluckt', async () => {
    const f = new FakeConnector();
    f.read = async () => { throw new Error('nie erreichbar'); };
    const m = new ManagedConnector(f);
    await assert.rejects(m.read(), /nie erreichbar/);
    assert.equal(m.diagnostics().consecutiveFailures, 1);
  });

  test('Poll und Reconnect teilen sich eine laufende Abfrage', async () => {
    const f = new FakeConnector();
    const m = new ManagedConnector(f);
    let freigeben!: () => void;
    const original = f.read.bind(f);
    f.read = () => new Promise<ConnectorReading>((fertig) => { freigeben = () => void original().then(fertig); });
    const a = m.read();
    const b = m.reconnect();
    freigeben();
    await Promise.all([a, b]);
    assert.equal(f.reads, 1, 'das Gerät wurde doppelt abgefragt');
  });
});

describe('ManagedConnector — steuerbares Ladegerät', () => {
  test('ein reiner Messconnector hat kein Ladegerät', () => {
    assert.equal(new ManagedConnector(new FakeConnector()).ladegeraet(), null);
  });

  test('reicht Steuerbefehle durch und merkt sich den letzten Befehlsfehler', async () => {
    let fehler: string | null = null;
    const steuerbar = Object.assign(new FakeConnector(), {
      async ladestromGrenzen() { return { minA: 6, maxA: 16, schrittA: 1 }; },
      async steuerfunktionen() { return []; },
      async setzeLadestrom(a: number) { if (fehler) throw new Error(fehler); return a; },
      async setzeLaden() { if (fehler) throw new Error(fehler); },
    });
    const m = new ManagedConnector(steuerbar);
    const geraet = m.ladegeraet();
    assert.ok(geraet !== null);
    assert.equal(await geraet.setzeLadestrom(10), 10);
    assert.equal(m.diagnostics().letzterBefehlFehler, null);
    fehler = 'Cloud antwortet nicht';
    await assert.rejects(geraet.setzeLaden(false), /Cloud antwortet nicht/);
    assert.equal(m.diagnostics().letzterBefehlFehler, 'Cloud antwortet nicht');
    fehler = null;
    await geraet.setzeLaden(true);
    assert.equal(m.diagnostics().letzterBefehlFehler, null, 'ein Erfolg löscht den Fehler');
  });
});