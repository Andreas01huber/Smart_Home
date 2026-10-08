import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KonfigurationsFehler,
  ladeanschlussAus,
  loadConfig,
  quellenNamen,
  speicherquellen,
  wallboxQuelle,
} from './config.ts';

function mitDatei(inhalt: unknown, secrets?: unknown): { pfad: string; weg: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'smarthome-config-'));
  const pfad = join(dir, 'config.json');
  writeFileSync(pfad, typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt));
  if (secrets !== undefined) writeFileSync(join(dir, 'secrets.json'), JSON.stringify(secrets));
  return { pfad, weg: () => rmSync(dir, { recursive: true, force: true }) };
}

const MAPPING = { solarProductionW: ['fronius-local', 'fronius-gen24'], gridImportW: 'fronius-gen24', gridExportW: 'fronius-gen24', houseConsumptionW: 'derived' };

describe('Konfiguration: Quellen als Liste', () => {
  it('liest die bisherige Objektform und leitet feste IDs ab', () => {
    const d = mitDatei({
      sources: {
        fronius: { enabled: true, host: '10.0.0.1', displayName: 'Symo', _hinweis: 'egal' },
        froniusGen24: { enabled: true, host: '10.0.0.2', batteryDisplayName: 'Klein', usableCapacityWh: 11000 },
        victron: { enabled: false, host: '10.0.0.3' },
        evCharger: { enabled: true, deviceId: 'abc', phases: 1, voltageV: 230 },
      },
      sourceMapping: MAPPING,
    }, { tuya: { accessId: 'id', accessSecret: 'geheim' } });
    try {
      const c = loadConfig(d.pfad);
      assert.deepEqual(c.quellen.map((q) => q.id), ['fronius-local', 'fronius-gen24', 'ev-charger']);
      assert.deepEqual(speicherquellen(c), ['fronius-gen24']);
      assert.equal(quellenNamen(c)['fronius-local'], 'Symo');
      const wb = wallboxQuelle(c);
      assert.equal(wb?.accessId, 'id');
      assert.equal(wb?.accessSecret, 'geheim');
      assert.deepEqual(ladeanschlussAus(c), { phasen: 1, spannungV: 230 });
    } finally { d.weg(); }
  });

  it('liest die Listenform mit beliebigen IDs', () => {
    const d = mitDatei({
      sources: [
        { id: 'wr-nord', typ: 'fronius-solar-api', host: '10.0.0.1' },
        { id: 'wr-sued', typ: 'fronius-solar-api', host: '10.0.0.2', batteryDisplayName: 'Speicher' },
        { id: 'gx', typ: 'victron-modbus', host: '10.0.0.3', usableCapacityWh: 50000 },
      ],
      sourceMapping: { solarProductionW: ['wr-nord', 'wr-sued'], gridImportW: 'gx', gridExportW: 'gx', houseConsumptionW: 'derived' },
    });
    try {
      const c = loadConfig(d.pfad);
      assert.deepEqual(c.quellen.map((q) => q.id), ['wr-nord', 'wr-sued', 'gx']);
      assert.deepEqual(speicherquellen(c), ['wr-sued', 'gx']);
      assert.equal(wallboxQuelle(c), null);
      assert.deepEqual(ladeanschlussAus(c), { phasen: 3, spannungV: 400 });
    } finally { d.weg(); }
  });
});

describe('Konfiguration: Prüfung statt stillem Rückfall', () => {
  it('meldet alle Fehler auf einmal, mit Pfad', () => {
    const d = mitDatei({
      port: 'vier',
      sources: { fronius: { enabled: true, hots: '10.0.0.1' } },
      sourceMapping: MAPPING,
      ueberschussladen: { modus: 'vielleicht', reserveW: -5 },
    });
    try {
      assert.throws(() => loadConfig(d.pfad), (e: unknown) => {
        assert.ok(e instanceof KonfigurationsFehler);
        const text = e.probleme.join('\n');
        assert.match(text, /port: muss eine Zahl/);
        assert.match(text, /sources\.fronius\.hots: unbekannter Schlüssel/);
        assert.match(text, /sources\.fronius\.host: fehlt/);
        assert.match(text, /ueberschussladen\.modus/);
        assert.match(text, /ueberschussladen\.reserveW: muss mindestens 0/);
        return true;
      });
    } finally { d.weg(); }
  });

  it('nimmt fehlende Werte als Standard, aber keine falschen', () => {
    const d = mitDatei({ sources: {}, sourceMapping: MAPPING });
    try {
      const c = loadConfig(d.pfad);
      assert.equal(c.port, 4173);
      assert.equal(c.ueberschuss.modus, 'beobachten');
      assert.deepEqual(c.trustedProxies, ['127.0.0.1', '::1']);
    } finally { d.weg(); }
  });

  it('weist doppelte Quellen-IDs ab', () => {
    const d = mitDatei({
      sources: [
        { id: 'a', typ: 'fronius-solar-api', host: 'x' },
        { id: 'a', typ: 'victron-modbus', host: 'y' },
      ],
      sourceMapping: { solarProductionW: 'a', gridImportW: 'a', gridExportW: 'a', houseConsumptionW: 'derived' },
    });
    try {
      assert.throws(() => loadConfig(d.pfad), /ist doppelt/);
    } finally { d.weg(); }
  });

  it('lässt _hinweis-Schlüssel überall zu', () => {
    const d = mitDatei({
      _hinweis: 'oben',
      sources: { _hinweis: 'mitte', fronius: { enabled: true, host: 'x', _hinweis_takt: 'unten' } },
      sourceMapping: { ...MAPPING, _hinweis: 'auch hier' },
      ueberschussladen: { _hinweis_modus: 'ja', modus: 'aus' },
    });
    try {
      assert.equal(loadConfig(d.pfad).ueberschuss.modus, 'aus');
    } finally { d.weg(); }
  });

  it('kein gültiges JSON ist ein verständlicher Fehler', () => {
    const d = mitDatei('{ "port": 4173, ');
    try {
      assert.throws(() => loadConfig(d.pfad), /kein gültiges JSON/);
    } finally { d.weg(); }
  });
});
