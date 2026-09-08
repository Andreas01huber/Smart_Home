/**
 * Rein lesende Probe: Was würde die Regelung mit den JETZIGEN Messwerten tun?
 *
 * Fragt die Geräte einmal ab, rechnet mit der echten Konfiguration und dem aus
 * dem Tagesverlauf aufgebauten Speichergedächtnis — und schreibt das Ergebnis
 * hin. Es geht KEIN Befehl an die Wallbox; hier wird ausschliesslich gelesen.
 *
 * Gedacht zum Nachsehen an der laufenden Anlage: Die Regelung selbst zeigt ihre
 * Rechnung nur im Konsolenfenster und in der angemeldeten App.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  berechneLadeziel,
  bewaehrtW,
  gedaechtnisAusMesswerten,
  ladeleistungAusStromW,
  speicherspielraum,
  type Messwerte,
  type Reglerparameter,
} from '@energy/core';
import { FroniusLocalConnector, VictronModbusConnector, TuyaEvseConnector } from '@energy/connectors';

import { ladeanschlussAus, loadConfig } from '../apps/server/src/config.ts';
import { ladeDose } from '../apps/server/src/wallbox-speicher.ts';

const config = loadConfig();
const u = config.ueberschuss;

// ── Speichergedächtnis wie beim Serverstart aus dem Tagesverlauf ────────────
interface Punkt {
  t: number;
  bat: Record<string, { p: number | null; soc: number | null }>;
}
const heute: { series?: Punkt[] } = JSON.parse(
  readFileSync(resolve(process.cwd(), 'data', 'today.json'), 'utf8'),
);
const gedaechtnis = gedaechtnisAusMesswerten(
  (heute.series ?? []).flatMap((p) =>
    Object.entries(p.bat).map(([id, b]) => ({
      id,
      entladenW: Math.max(0, -(b.p ?? 0)),
      tMs: p.t,
    })),
  ),
  Date.now(),
);

// ── Geräte einmal lesen ────────────────────────────────────────────────────
const gen24 = new FroniusLocalConnector({
  host: config.sources.froniusGen24!.host,
  connectorId: 'fronius-gen24',
  batteryDisplayName: 'Kleiner Speicher',
});
const symo = new FroniusLocalConnector({
  host: config.sources.fronius!.host,
  connectorId: 'fronius-local',
});
const victron = new VictronModbusConnector({
  host: config.sources.victron!.host,
  connectorId: 'victron-modbus',
  batteryDisplayName: 'Grosser Speicher',
});
const wallbox = new TuyaEvseConnector({
  deviceId: config.sources.evCharger!.deviceId,
  accessId: config.sources.evCharger!.accessId ?? '',
  accessSecret: config.sources.evCharger!.accessSecret ?? '',
  region: config.sources.evCharger!.region ?? 'eu',
});

// Die Wallbox zweimal lesen. Der erste Aufruf eines frisch gebauten Adapters
// liefert noch den Offline-Stand, weil die Cloud-Antwort erst unterwegs ist —
// sonst stünde hier "Auto 0 W", während es in Wirklichkeit mit 11 kW lädt.
await wallbox.read();
await new Promise((fertig) => setTimeout(fertig, 2500));

const [aGen, aSymo, aVic, aWall] = await Promise.all([
  gen24.read(),
  symo.read(),
  victron.read(),
  wallbox.read(),
]);

const pv =
  (aGen.solarProductionW?.valueW ?? 0) + (aSymo.solarProductionW?.valueW ?? 0);
const netzbezug = aGen.gridImportW?.valueW ?? null;
const einspeisung = aGen.gridExportW?.valueW ?? null;
const batterien = [...(aGen.batteries ?? []), ...(aVic.batteries ?? [])];
const ev = aWall.evCharger ?? null;
const evLeistung = ev?.chargePowerW ?? 0;

// Hausverbrauch wie in der App: abgeleitet, also INKLUSIVE Auto.
const ladung = batterien.reduce((s, b) => s + (b.chargeW ?? 0), 0);
const entladung = batterien.reduce((s, b) => s + (b.dischargeW ?? 0), 0);
const haus = pv + (netzbezug ?? 0) - (einspeisung ?? 0) + entladung - ladung;

// Dieselbe Dose wie der Regeldienst, sonst rechnet die Probe mit 400 V, wo
// 229 V anliegen — und meldet einen Mindestladestrom, den es dort nicht gibt.
const gemerkteDose = ladeDose(resolve(process.cwd(), 'data'));
const dose = gemerkteDose === null
  ? ladeanschlussAus(config)
  : { phasen: gemerkteDose.phasen, spannungV: gemerkteDose.spannungV };

const parameter: Reglerparameter = {
  anschluss: dose,
  minA: 6,
  maxA: 16,
  schrittA: 1,
  reserveW: u.reserveW,
  netzTotzoneW: u.netzTotzoneW,
  speicher: u.speicher,
  speicherStandard: u.speicherStandard,
  speicherEntladenErlaubt: u.speicherEntladenErlaubt,
  maxMessalterMs: u.maxMessalterSekunden * 1000,
};

const speicher = batterien.map((b) => ({
  id: b.deviceId,
  name: b.displayName,
  socPercent: b.socPercent,
  ladenW: b.chargeW,
  entladenW: b.dischargeW,
  bewaehrtEntladenW: bewaehrtW(gedaechtnis, b.deviceId),
}));

const w = (x: number | null): string =>
  x === null ? '—' : `${Math.round(x).toLocaleString('de-AT')} W`;

console.log('── Messwerte, gerade eben ────────────────────────────────');
console.log(`  PV                 ${w(pv)}`);
console.log(`  Haus (mit Auto)    ${w(haus)}`);
console.log(`  Netzbezug          ${w(netzbezug)}`);
console.log(`  Einspeisung        ${w(einspeisung)}`);
console.log(`  Auto               ${w(evLeistung)}   ${ev?.vehicleConnected === true ? 'angesteckt' : ev?.vehicleConnected === false ? 'nicht angesteckt' : 'unbekannt'}`);
for (const s of speicher) {
  console.log(
    `  ${s.name.padEnd(17)} ${String(Math.round(s.socPercent ?? 0)).padStart(3)} %  `
      + `laedt ${w(s.ladenW)}  entlaedt ${w(s.entladenW)}  nachgewiesen ${w(s.bewaehrtEntladenW)}`,
  );
}

const messwerte: Messwerte = {
  pvW: pv,
  hausMitAutoW: haus,
  netzbezugW: netzbezug,
  netzeinspeisungW: einspeisung,
  evLeistungW: evLeistung,
  // Für die Probe wird ein angestecktes Fahrzeug angenommen, wenn keines
  // gemeldet ist — sonst zeigt die Rechnung nur "nicht verbunden".
  evAngesteckt: ev?.vehicleConnected ?? true,
  evStromA: ev?.maxCurrentA ?? null,
  speicher,
  messalterMs: 1000,
  wallboxErreichbar: true,
};

console.log(`
  Wallbox-Zustand    ${ev?.state ?? '—'}   Ladestrom eingestellt ${ev?.maxCurrentA ?? '—'} A   Sitzung ${ev?.sessionEnergyWh ?? '—'} Wh   Stoerung ${ev?.faultText ?? 'keine'}`);

const spiel = speicherspielraum(speicher, parameter);
const e = berechneLadeziel(messwerte, parameter);

console.log('\n── Woraus sich der Überschuss zusammensetzt ──────────────');
console.log(`  Auto jetzt         ${w(evLeistung)}`);
console.log(`  + Einspeisung      ${w(einspeisung)}`);
console.log(`  - Netzbezug        ${w(netzbezug)}`);
console.log(`  - Reserve          ${w(u.reserveW)}`);
console.log(`  + Ladung Speicher  ${w(spiel.ladungFuerAutoW)}   (gemessen)`);
console.log(`  + Entladespielraum ${w(spiel.entladespielraumW)}   (nachgewiesen)`);
console.log(`  - Überentladung    ${w(spiel.ueberEntladungW)}`);
console.log(`  = verfügbar        ${w(e.verfuegbarW)}`);

console.log('\n── Entscheidung ─────────────────────────────────────────');
console.log(`  Zustand            ${e.zustand}`);
console.log(`  Ladestrom          ${e.zielA} A  =  ${w(ladeleistungAusStromW(e.zielA, parameter.anschluss))}`);
console.log(`  Haus ohne Auto     ${w(e.hausOhneAutoW)}`);
console.log(`  Aus den Speichern  ${w(e.speicherbeitragW)}`);
console.log(`  ${e.grund}`);
