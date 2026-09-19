import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { ManagedConnector, type EnergyConnector } from '@energy/connectors';
import { loadConfig } from './config.ts';
import { starteServer } from './index.ts';

function aufbau() {
  const dir = mkdtempSync(join(tmpdir(), 'smarthome-http-test-'));
  const pfad = join(dir, 'config.json');
  writeFileSync(pfad, JSON.stringify({ host: '127.0.0.1', port: 0,
    allowUnauthenticatedAccess: true, sources: {},
    sourceMapping: { solarProductionW: 'fake', gridImportW: 'fake', gridExportW: 'fake', houseConsumptionW: 'derived' },
  }));
  let messungen = 0;
  const quelle: EnergyConnector = {
    id: 'fake', displayName: 'Testquelle',
    async read() {
      messungen++;
      const p = { connectorId: 'fake', deviceId: 'fake', measuredAt: new Date(), ageMs: 0, quality: 'live' as const };
      return { connectorId: 'fake', timestamp: new Date(), solarProductionW: { valueW: 1000, provenance: p },
        gridImportW: { valueW: 0, provenance: p }, gridExportW: { valueW: 0, provenance: p }, houseConsumptionW: null, batteries: [] };
    },
    diagnostics: () => ({ connectorId: 'fake', displayName: 'Testquelle', online: true, responseTimeMs: 0,
      lastSuccessAt: new Date(), detectedDevices: 1, availableMetrics: 3, missingMetrics: [], errorCount: 0,
      lastError: null, mode: 'Test', endpoint: 'in-memory' }),
  };
  return { dir, config: loadConfig(pfad), quellen: { connectors: [new ManagedConnector(quelle)], wallbox: null },
    messungen: () => messungen,
    aufraeumen() {
      assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'smarthome-http-test-'));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

it('startet bei belegtem Port keine Messung im Hintergrund', async () => {
  const a = aufbau();
  const belegt = createServer();
  await new Promise<void>((ok) => belegt.listen(0, '127.0.0.1', ok));
  try {
    await assert.rejects(starteServer({ ...a, datenverzeichnis: a.dir,
      config: { ...a.config, port: (belegt.address() as AddressInfo).port } }), /EADDRINUSE/);
    assert.equal(a.messungen(), 0);
  } finally {
    await new Promise<void>((ok, nein) => belegt.close((e) => e ? nein(e) : ok()));
    a.aufraeumen();
  }
});

it('liefert für zukünftige Tarife denselben aktuellen Stand bei PUT und GET', async () => {
  const a = aufbau();
  const server = await starteServer({ ...a, datenverzeichnis: a.dir });
  const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  try {
    const vorher = await (await fetch(url + '/api/tariff')).json() as { tarif: { importPricePerKWh: number } };
    const put = await fetch(url + '/api/tariff', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ importPricePerKWh: .9, exportPricePerKWh: .2, gueltigAb: '2099-01-01' }) });
    assert.equal(put.status, 200);
    const gespeichert = await put.json();
    const aktuell = await (await fetch(url + '/api/tariff')).json() as { tarif: { importPricePerKWh: number } };
    assert.deepEqual(gespeichert, aktuell);
    assert.equal(aktuell.tarif.importPricePerKWh, vorher.tarif.importPricePerKWh,
      'Ein zukünftiger Preis darf nicht schon heute gelten');
    const falsch = await fetch(url + '/api/tariff', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ importPricePerKWh: -1, exportPricePerKWh: .2 }) });
    assert.equal(falsch.status, 400);
    assert.deepEqual(await (await fetch(url + '/api/tariff')).json(), aktuell);
    for (const pfad of ['/api.js', '/tarif-regeln.js']) assert.equal((await fetch(url + pfad)).status, 200);
    const leer = await (await fetch(url + '/api/history/day?date=2001-01-01')).json() as { hasData: boolean; zeitzone: string };
    assert.equal(leer.hasData, false);
    assert.equal(typeof leer.zeitzone, 'string');
  } finally { await server.stoppe(); a.aufraeumen(); }
});
