/** Den Datenpunkt `phase_a` mehrfach lesen und dekodieren — rein lesend. */
import { TuyaCloudClient } from '@energy/connectors';
import { loadConfig } from '../apps/server/src/config.ts';

const config = loadConfig();
const ev = config.sources.evCharger!;
const client = new TuyaCloudClient({
  accessId: ev.accessId ?? '',
  accessSecret: ev.accessSecret ?? '',
  region: ev.region ?? 'eu',
});

for (let i = 0; i < 6; i++) {
  const a = await client.rohAbfrage<{
    properties?: { code: string; value: unknown; time: number }[];
  }>(`/v2.0/cloud/thing/${encodeURIComponent(ev.deviceId)}/shadow/properties`);
  const props = a.result?.properties ?? [];
  const p = props.find((x) => x.code === 'phase_a');
  const pt = props.find((x) => x.code === 'power_total');
  const cur = props.find((x) => x.code === 'charge_cur_set');
  if (p && typeof p.value === 'string') {
    const b = Buffer.from(p.value, 'base64');
    const v = b.readUInt16BE(0) / 10;
    const iA = (((b[2] ?? 0) << 16) | ((b[3] ?? 0) << 8) | (b[4] ?? 0)) / 1000;
    const w = ((b[5] ?? 0) << 16) | ((b[6] ?? 0) << 8) | (b[7] ?? 0);
    const alter = Math.round((Date.now() - p.time) / 1000);
    console.log(
      `${new Date().toLocaleTimeString('de-AT')}  ${v.toFixed(1)} V · ${iA.toFixed(2)} A · ${w} W`
      + `   (gesetzt ${String(cur?.value)} A, power_total ${String(pt?.value)} W, Wert ${alter} s alt)`,
    );
  } else {
    console.log('phase_a fehlt');
  }
  await new Promise((f) => setTimeout(f, 4000));
}
