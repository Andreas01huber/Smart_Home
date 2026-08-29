/**
 * Energy System Preflight (Phase 2, STEP 8–16).
 *
 * Prüft den GESAMTEN Datenpfad, den die App selbst verwendet: dieselben
 * Connectoren, dieselbe Normalisierung, dieselbe Source-of-Truth-Auflösung.
 * Kein separater Testpfad, damit der Report wirklich das abbildet, was das
 * Dashboard sieht.
 *
 * Aufruf:  npm run preflight
 */

import { readHoldingRegisters, VICTRON_SYSTEM_UNIT_ID } from '@energy/connectors';
import { FroniusLocalConnector, VictronModbusConnector } from '@energy/connectors';
import { resolveSnapshot, checkEnergyBalance, formatAgeDe } from '@energy/core';
import type { ConnectorReading } from '@energy/core';

import { loadConfig } from '../apps/server/src/config.ts';

const OK = '✅';
const FAIL = '❌';
const WARN = '⚠️';

interface Check {
  label: string;
  pass: boolean;
  detail?: string;
}

const checks: Check[] = [];
function check(label: string, pass: boolean, detail?: string): boolean {
  checks.push(detail === undefined ? { label, pass } : { label, pass, detail });
  return pass;
}

function line(label: string, mark: string, detail = ''): void {
  console.log(`  ${label.padEnd(26)} ${mark}${detail ? '  ' + detail : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log('\n' + '═'.repeat(64));
  console.log('  ENERGY SYSTEM PREFLIGHT');
  console.log('  ' + new Date().toLocaleString('de-DE'));
  console.log('═'.repeat(64));

  // ── Fronius Symo (.121) ────────────────────────────────────────────
  const symoCfg = config.sources.fronius;
  const gen24Cfg = config.sources.froniusGen24;
  const victronCfg = config.sources.victron;

  console.log('\n── Fronius ' + '─'.repeat(52));

  let symoReading: ConnectorReading | null = null;
  let symoRaw: FroniusRaw | null = null;
  if (symoCfg?.enabled) {
    symoRaw = await froniusRaw(symoCfg.host);
    const c = new FroniusLocalConnector({ host: symoCfg.host, connectorId: 'fronius-local' });
    symoReading = await c.read();
    const diag = c.diagnostics();
    const online = check('Fronius Inverter 1', diag.online, symoCfg.host);
    line('Fronius Inverter 1', online ? OK : FAIL, `${symoRaw?.inverterName ?? ''} @ ${symoCfg.host}`);
    check('Fronius Inverter 1 Leistung', symoReading.solarProductionW?.valueW !== null);
    line('  → aktuelle PV-Leistung', symoReading.solarProductionW?.valueW !== null ? OK : FAIL,
      fmtW(symoReading.solarProductionW?.valueW ?? null));
  } else {
    line('Fronius Inverter 1', WARN, 'deaktiviert');
  }

  // ── Fronius GEN24 (.39) ─────────────────────────────────────────────
  let gen24Reading: ConnectorReading | null = null;
  let gen24Raw: FroniusRaw | null = null;
  if (gen24Cfg?.enabled) {
    gen24Raw = await froniusRaw(gen24Cfg.host);
    const c = new FroniusLocalConnector({
      host: gen24Cfg.host,
      connectorId: 'fronius-gen24',
      batteryDisplayName: 'Kleiner Speicher',
    });
    gen24Reading = await c.read();
    const diag = c.diagnostics();
    const online = check('Fronius Inverter 2', diag.online, gen24Cfg.host);
    line('Fronius Inverter 2', online ? OK : FAIL, `${gen24Raw?.inverterName ?? ''} @ ${gen24Cfg.host}`);
    check('Fronius Inverter 2 Leistung', gen24Reading.solarProductionW?.valueW !== null);
    line('  → aktuelle PV-Leistung', gen24Reading.solarProductionW?.valueW !== null ? OK : FAIL,
      fmtW(gen24Reading.solarProductionW?.valueW ?? null));

    const hasMeter = gen24Raw?.hasMeter ?? false;
    check('Fronius Smart Meter', hasMeter, gen24Raw?.meterModel ?? '');
    line('Fronius Smart Meter', hasMeter ? OK : FAIL, gen24Raw?.meterModel ?? '');

    const grid = gen24Reading.gridImportW?.valueW !== null && gen24Reading.gridExportW?.valueW !== null;
    check('Netzbezug', grid);
    check('Netzeinspeisung', grid);
    line('Netzbezug', grid ? OK : FAIL, fmtW(gen24Reading.gridImportW?.valueW ?? null));
    line('Netzeinspeisung', grid ? OK : FAIL, fmtW(gen24Reading.gridExportW?.valueW ?? null));

    const bat = gen24Reading.batteries[0];
    const hasBat = bat !== undefined;
    check('Fronius Battery (12 kWh)', hasBat);
    line('Fronius Battery 12 kWh', hasBat ? OK : FAIL,
      hasBat ? `${bat.displayName}, SOC ${bat.socPercent}%, ${fmtWh(bat.usableCapacityWh)}` : '');
    if (hasBat) {
      check('Batterie-SOC', bat.socPercent !== null);
      check('Ladeleistung', bat.chargeW !== null);
      check('Entladeleistung', bat.dischargeW !== null);
    }
  } else {
    line('Fronius Inverter 2', WARN, 'deaktiviert');
  }

  // ── Victron (.73) ───────────────────────────────────────────────────
  console.log('\n── Victron ' + '─'.repeat(52));
  let victronReading: ConnectorReading | null = null;
  let victronMeta: VictronMeta | null = null;
  if (victronCfg?.enabled) {
    victronMeta = await victronRaw(victronCfg.host);
    const c = new VictronModbusConnector({
      host: victronCfg.host,
      connectorId: 'victron-modbus',
      batteryDisplayName: 'Grosser Speicher',
      usableCapacityWh: victronCfg.usableCapacityWh ?? null,
    });
    victronReading = await c.read();
    const diag = c.diagnostics();
    const online = check('Victron System', diag.online, victronCfg.host);
    line('Victron System', online ? OK : FAIL, `GX @ ${victronCfg.host}, Serial ${victronMeta?.serial ?? '?'}`);
    check('GX erreichbar', online);
    line('GX / Modbus TCP', online ? OK : FAIL, `Unit-ID ${VICTRON_SYSTEM_UNIT_ID}`);

    const bat = victronReading.batteries[0];
    const hasBat = bat !== undefined;
    check('Victron 50 kWh Battery', hasBat);
    line('Victron 50 kWh Battery', hasBat ? OK : FAIL,
      hasBat ? `SOC ${bat.socPercent}%, ${fmtWh(bat.usableCapacityWh)}` : '');
    if (hasBat) {
      check('Victron SOC', bat.socPercent !== null);
      check('Victron Batterieleistung', bat.chargeW !== null && bat.dischargeW !== null);
      check('Victron gespeicherte Energie', bat.storedEnergyWh !== null);
      line('  → Laden/Entladen', OK, `${bat.state}, ${fmtW((bat.chargeW ?? 0) - (bat.dischargeW ?? 0))}`);
      line('  → gespeicherte Energie', bat.storedEnergyWh !== null ? OK : WARN, fmtWh(bat.storedEnergyWh));
    }
    check('Zeitstempel aktuell', diag.responseTimeMs !== null && diag.online);
  } else {
    line('Victron System', WARN, 'deaktiviert');
  }

  // ── Aggregation / Source of Truth ───────────────────────────────────
  console.log('\n── Aggregation & Source of Truth ' + '─'.repeat(30));
  const readings = [symoReading, gen24Reading, victronReading].filter(
    (r): r is ConnectorReading => r !== null,
  );
  const resolution = resolveSnapshot(readings, config.sourceMapping);
  const snap = resolution.snapshot;

  // PV-Aggregation prüfen: Summe = Symo + GEN24, kein Victron-Doppelzählen.
  const symoPv = symoReading?.solarProductionW?.valueW ?? 0;
  const gen24Pv = gen24Reading?.solarProductionW?.valueW ?? 0;
  const expectedPv = symoPv + gen24Pv;
  const actualPv = snap.solarProductionW.valueW ?? 0;
  const pvAggOk = Math.abs(actualPv - expectedPv) < 1;
  check('PV aggregation', pvAggOk, `${fmtW(symoPv)} + ${fmtW(gen24Pv)} = ${fmtW(actualPv)}`);
  line('PV aggregation', pvAggOk ? OK : FAIL, `PV1 ${fmtW(symoPv)} + PV2 ${fmtW(gen24Pv)} = ${fmtW(actualPv)}`);

  // Doppelzählung: Victron misst denselben Symo/Netzpunkt. Als Quelle für PV
  // und Netz darf Victron NICHT gewählt sein.
  const solarSources = Array.isArray(config.sourceMapping.solarProductionW)
    ? config.sourceMapping.solarProductionW
    : [config.sourceMapping.solarProductionW];
  const noDup =
    !solarSources.includes('victron-modbus') &&
    config.sourceMapping.gridImportW !== 'victron-modbus';
  check('No duplicate counting', noDup);
  line('No duplicate counting', noDup ? OK : FAIL, 'Victron nicht als PV-/Netzquelle');

  // ── Energy Balance (STEP 15) ────────────────────────────────────────
  const balance = checkEnergyBalance(snap);
  const balanceOk = balance.verdict === 'ok' || balance.verdict === 'incomplete';
  check('Energy balance', balanceOk, balanceDetail(balance));
  line('Energy balance', balanceOk ? OK : WARN, balanceDetail(balance));

  // ── Datenalter ──────────────────────────────────────────────────────
  console.log('\n── Data age ' + '─'.repeat(51));
  const froniusAge = youngest([symoReading, gen24Reading]);
  const victronAge = youngest([victronReading]);
  if (froniusAge !== null) line('Fronius', OK, formatAgeDe(froniusAge));
  if (victronAge !== null) line('Victron', OK, formatAgeDe(victronAge));

  // ── Zusammenfassung ─────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(64));
  const failed = checks.filter((c) => !c.pass);
  const ready = failed.length === 0;
  console.log('  Result:');
  if (ready) {
    console.log(`  ${OK} READY FOR DASHBOARD`);
  } else {
    console.log(`  ${FAIL} NOT READY`);
    console.log('  Fehlgeschlagene Prüfungen:');
    for (const f of failed) console.log(`     - ${f.label}${f.detail ? ` (${f.detail})` : ''}`);
  }
  console.log('═'.repeat(64) + '\n');

  process.exitCode = ready ? 0 : 1;
}

// ── Rohabfragen für Metadaten (Modell, Zähler) ─────────────────────────

interface FroniusRaw {
  inverterName: string | null;
  hasMeter: boolean;
  meterModel: string | null;
}

async function froniusRaw(host: string): Promise<FroniusRaw> {
  const decode = (s: string): string =>
    s.replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
  const j = async (p: string): Promise<unknown> => {
    try {
      const r = await fetch(`http://${host}${p}`, { signal: AbortSignal.timeout(5000) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  const info = (await j('/solar_api/v1/GetInverterInfo.cgi')) as any;
  const active = (await j('/solar_api/v1/GetActiveDeviceInfo.cgi?DeviceClass=System')) as any;
  const meter = (await j('/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System')) as any;

  const invEntry = info?.Body?.Data ? Object.values(info.Body.Data)[0] : null;
  const inverterName = invEntry?.CustomName ? decode(String(invEntry.CustomName)) : null;
  const hasMeter = active?.Body?.Data?.Meter && Object.keys(active.Body.Data.Meter).length > 0;
  const meterEntry = meter?.Body?.Data ? Object.values(meter.Body.Data)[0] : null;
  const meterModel = meterEntry?.Details?.Model ?? null;

  return { inverterName, hasMeter: Boolean(hasMeter), meterModel };
}

interface VictronMeta {
  serial: string | null;
}

async function victronRaw(host: string): Promise<VictronMeta> {
  try {
    const b = await readHoldingRegisters(host, VICTRON_SYSTEM_UNIT_ID, 800, 6, 3000);
    return { serial: b.toString('latin1').replace(/\0/g, '').trim() };
  } catch {
    return { serial: null };
  }
}

// ── Hilfen ─────────────────────────────────────────────────────────────

function fmtW(w: number | null): string {
  if (w === null) return 'null';
  return Math.abs(w) < 1000 ? `${Math.round(w)} W` : `${(w / 1000).toFixed(2)} kW`;
}
function fmtWh(wh: number | null): string {
  if (wh === null) return '—';
  return `${(wh / 1000).toFixed(1)} kWh`;
}
function balanceDetail(b: ReturnType<typeof checkEnergyBalance>): string {
  if (b.verdict === 'ok') return `Residual ${fmtW(b.residualW)} (im Rahmen)`;
  if (b.verdict === 'incomplete') return 'unvollständig (fehlende Größe)';
  return `${b.verdict}: ${fmtW(b.residualW)}`;
}
function youngest(readings: (ConnectorReading | null)[]): number | null {
  let min: number | null = null;
  for (const r of readings) {
    if (r === null) continue;
    for (const m of [r.solarProductionW, r.gridImportW]) {
      if (m && Number.isFinite(m.provenance.ageMs)) {
        min = min === null ? m.provenance.ageMs : Math.min(min, m.provenance.ageMs);
      }
    }
  }
  return min;
}

main().catch((error: unknown) => {
  console.error('\nPreflight abgebrochen:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
