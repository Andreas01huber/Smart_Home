/**
 * Rohe Datenpunkte der Wallbox anzeigen — rein lesend.
 *
 * Wenn das Auto nicht lädt, obwohl die Regelung 16 A gestellt hat, ist die
 * Frage: Liegt es an uns oder am Fahrzeug? Diese Ausgabe beantwortet sie, weil
 * sie zeigt, was das Gerät selbst meldet — Schalter, Betriebszustand und die
 * Pilotleitung zum Fahrzeug.
 */

import { TuyaCloudClient } from '@energy/connectors';

import { loadConfig } from '../apps/server/src/config.ts';

const config = loadConfig();
const ev = config.sources.evCharger;
if (ev === undefined) throw new Error('Keine Wallbox konfiguriert.');

const client = new TuyaCloudClient({
  accessId: ev.accessId ?? '',
  accessSecret: ev.accessSecret ?? '',
  region: ev.region ?? 'eu',
});

const { online, status } = await client.deviceSnapshot(ev.deviceId);
console.log(`Gerät ${online ? 'online' : 'offline'} — ${status.length} Datenpunkte:\n`);
for (const eintrag of [...status].sort((a, b) => a.code.localeCompare(b.code))) {
  console.log(`  ${eintrag.code.padEnd(24)} ${String(eintrag.value)}`);
}
