/** Denselben Connector wie der Server benutzen und wiederholt `read()` aufrufen. */
import { TuyaEvseConnector } from '@energy/connectors';
import { loadConfig } from '../apps/server/src/config.ts';

const config = loadConfig();
const ev = config.sources.evCharger!;
const c = new TuyaEvseConnector({
  accessId: ev.accessId ?? '',
  accessSecret: ev.accessSecret ?? '',
  deviceId: ev.deviceId,
  region: ev.region ?? 'eu',
  idleIntervalMs: 5000,
  activeIntervalMs: 2000,
});

for (let i = 0; i < 15; i++) {
  const r = await c.read();
  const e = r.evCharger;
  console.log(
    `${new Date().toLocaleTimeString('de-AT')}  state=${e?.state}  verbunden=${e?.vehicleConnected}  `
    + `alterMs=${e ? Math.round(e.provenance.ageMs) : '—'}  quality=${e?.provenance.quality}  `
    + `measuredAt=${e?.provenance.measuredAt.toLocaleTimeString('de-AT')}`,
  );
  await new Promise((f) => setTimeout(f, 5000));
}
