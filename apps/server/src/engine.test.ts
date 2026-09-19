import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorReading } from '@energy/core';
import type { EnergyConnector } from '@energy/connectors';
import { EnergyEngine } from './engine.ts';
import type { AppConfig } from './config.ts';

const config = {
  sources: {}, pollIntervalMs: 2000,
  sourceMapping: { solarProductionW: 'test', houseConsumptionW: 'derived', gridImportW: 'test', gridExportW: 'test' },
} as AppConfig;
const lesen = (watt: number): ConnectorReading => {
  const p = { connectorId: 'test', deviceId: 'test', measuredAt: new Date(), ageMs: 0, quality: 'live' as const };
  return { connectorId: 'test', timestamp: new Date(),
    solarProductionW: { valueW: watt, provenance: p }, houseConsumptionW: null,
    gridImportW: { valueW: 0, provenance: p }, gridExportW: { valueW: 0, provenance: p }, batteries: [],
  };
};
const poll = (engine: EnergyEngine) => (engine as unknown as { poll(): Promise<void> }).poll();

it('startet bei einer langsamen Quelle keinen überholenden zweiten Poll', async () => {
  let aufrufe = 0;
  let abschliessen!: (r: ConnectorReading) => void;
  const connector = { id: 'test', diagnostics: () => ({}), read: () => {
    aufrufe++;
    return new Promise<ConnectorReading>((resolve) => { abschliessen = resolve; });
  } } as unknown as EnergyConnector;
  const engine = new EnergyEngine([connector], config);
  const erster = poll(engine);
  await poll(engine);
  assert.equal(aufrufe, 1);
  abschliessen(lesen(1000)); await erster;
  const zweiter = poll(engine);
  abschliessen(lesen(2000)); await zweiter;
  assert.equal(aufrufe, 2);
  assert.equal(engine.current()?.resolution.snapshot.solarProductionW.valueW, 2000);
});

it('erkennt einen ausbleibenden konfigurierten Speicher bereits beim ersten Poll', async () => {
  const connector = { id: 'test', diagnostics: () => ({}), read: async () => lesen(4000) } as unknown as EnergyConnector;
  const engine = new EnergyEngine([connector], { ...config,
    sources: { victron: { enabled: true, host: 'unused', usableCapacityWh: 50000 } },
  });
  await poll(engine);
  assert.equal(engine.current()?.resolution.snapshot.houseConsumptionW.valueW, null);
  assert.ok(engine.current()?.resolution.unavailable.includes('battery:victron-modbus'));
});
