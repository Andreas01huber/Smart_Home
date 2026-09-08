/**
 * Alle Datenpunkte der Wallbox auflisten — rein lesend.
 *
 * Was ein Tuya-Gerät kennt, steht in keinem Datenblatt. Die App zeigt Werte,
 * die in `/status` nicht auftauchen, weil sie aus anderen Datenpunkten kommen.
 * Dieses Werkzeug fragt alles ab, was die Cloud über das Gerät hergibt.
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

const id = encodeURIComponent(ev.deviceId);
const pfade = [
  `/v1.0/devices/${id}/specifications`,
  `/v1.0/iot-03/devices/${id}/specification`,
  `/v2.0/cloud/thing/${id}/shadow/properties`,
  `/v1.0/devices/${id}/status`,
];

for (const pfad of pfade) {
  try {
    const antwort = await client.rohAbfrage<unknown>(pfad);
    console.log(`\n── ${pfad} ──`);
    console.log(antwort.success ? JSON.stringify(antwort.result, null, 1) : `nicht verfügbar: ${antwort.msg ?? ''}`);
  } catch (fehler) {
    console.log(`\n── ${pfad} ──\nFehler: ${fehler instanceof Error ? fehler.message : String(fehler)}`);
  }
}
