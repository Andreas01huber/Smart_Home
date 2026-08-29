/**
 * Discovery-CLI: findet Fronius- und Victron-Systeme und berichtet, was
 * tatsächlich vorhanden ist (Anforderungen 4W und 4X).
 *
 * Aufruf:
 *   npm run discover                 vollständige Suche im lokalen Netz
 *   npm run discover -- --fronius 192.168.1.50   nur diesen Fronius abfragen
 *   npm run discover -- --gx 192.168.1.51        nur dieses GX-Gerät abfragen
 *   npm run discover -- --skip-scan              kein Netzscan, nur .env-Hosts
 *   npm run discover -- --vrm                    nur die VRM-Cloud abfragen
 *
 * Der Bericht wird zusätzlich als discovery-report.json abgelegt. Diese Datei
 * ist in .gitignore ausgeschlossen, weil sie Seriennummern und IP-Adressen
 * enthalten kann. Zugangstokens landen niemals darin.
 */

import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { localSubnets } from './net.ts';
import { inspectFronius, scanForFronius, type FroniusProbeResult } from './fronius.ts';
import { inspectVictronGx, scanForVictronGx, type VictronLanFinding } from './victron-lan.ts';
import {
  inspectVictronModbus,
  scanForVictronModbus,
  type VictronModbusFinding,
} from './victron-modbus.ts';
import { inspectVrm, type VrmFinding } from './victron-vrm.ts';

interface Options {
  froniusHost: string | null;
  gxHost: string | null;
  portalId: string | null;
  skipScan: boolean;
  vrmOnly: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    froniusHost: process.env['FRONIUS_HOST'] || null,
    gxHost: process.env['VICTRON_GX_HOST'] || null,
    portalId: process.env['VICTRON_PORTAL_ID'] || null,
    skipScan: false,
    vrmOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fronius') options.froniusHost = argv[++i] ?? null;
    else if (arg === '--gx') options.gxHost = argv[++i] ?? null;
    else if (arg === '--portal-id') options.portalId = argv[++i] ?? null;
    else if (arg === '--skip-scan') options.skipScan = true;
    else if (arg === '--vrm') options.vrmOnly = true;
  }
  return options;
}

function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

function heading(text: string): void {
  console.log(`\n${'═'.repeat(70)}\n${text}\n${'═'.repeat(70)}`);
}

function section(text: string): void {
  console.log(`\n── ${text} ${'─'.repeat(Math.max(0, 66 - text.length))}`);
}

async function main(): Promise<void> {
  loadEnv();
  const options = parseArgs(process.argv.slice(2));

  heading('Energie-Discovery — Fronius & Victron');
  console.log(`Zeitpunkt: ${new Date().toLocaleString('de-DE')}`);

  const froniusResults: FroniusProbeResult[] = [];
  const victronLanResults: VictronLanFinding[] = [];
  const victronModbusResults: VictronModbusFinding[] = [];
  let vrmResult: VrmFinding | null = null;

  // --- Lokales Netz -------------------------------------------------------
  if (!options.vrmOnly) {
    if (options.froniusHost !== null) {
      section(`Fronius: gezielte Abfrage von ${options.froniusHost}`);
      froniusResults.push(await inspectFronius(options.froniusHost));
    }
    if (options.gxHost !== null) {
      section(`Victron GX: gezielte Abfrage von ${options.gxHost}`);
      victronLanResults.push(
        await inspectVictronGx(options.gxHost, options.portalId),
      );
      victronModbusResults.push(await inspectVictronModbus(options.gxHost));
    }

    const needScan =
      !options.skipScan && (options.froniusHost === null || options.gxHost === null);

    if (needScan) {
      const subnets = localSubnets();
      if (subnets.length === 0) {
        console.log('\nKein privates IPv4-Netz gefunden — Netzscan übersprungen.');
      }

      for (const subnet of subnets) {
        section(
          `Netzscan ${subnet.interfaceName} (${subnet.ownAddress}/${subnet.netmask}, ${subnet.hosts.length} Adressen)`,
        );

        if (options.froniusHost === null) {
          process.stdout.write('  Fronius Solar API ... ');
          const found = await scanForFronius(subnet.hosts);
          console.log(`${found.length} Treffer`);
          froniusResults.push(...found);
        }

        if (options.gxHost === null) {
          process.stdout.write('  Victron GX (MQTT 1883) ... ');
          const mqttHosts = await scanForVictronGx(subnet.hosts);
          console.log(`${mqttHosts.length} Kandidaten`);
          for (const host of mqttHosts) {
            victronLanResults.push(await inspectVictronGx(host, options.portalId));
          }

          // MQTT ist am GX werkseitig aus, Modbus TCP häufig bereits an.
          // Deshalb wird beides gesucht, nicht nur MQTT.
          process.stdout.write('  Victron GX (Modbus TCP 502) ... ');
          const modbusHosts = await scanForVictronModbus(subnet.hosts);
          console.log(`${modbusHosts.length} bestätigt`);
          for (const host of modbusHosts) {
            victronModbusResults.push(await inspectVictronModbus(host));
          }
        }
      }
    }
  }

  // --- VRM Cloud ----------------------------------------------------------
  const token = process.env['VRM_ACCESS_TOKEN'];
  if (token !== undefined && token.trim() !== '') {
    section('Victron VRM (Cloud)');
    vrmResult = await inspectVrm(token.trim());
  } else if (options.vrmOnly) {
    console.log(
      '\nVRM_ACCESS_TOKEN ist nicht gesetzt. Lege .env aus .env.example an und trage einen Access Token aus dem VRM-Portal ein.',
    );
  }

  printReport(froniusResults, victronLanResults, victronModbusResults, vrmResult);

  const reportPath = resolve(process.cwd(), 'discovery-report.json');
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        fronius: froniusResults,
        victronLan: victronLanResults,
        victronModbus: victronModbusResults,
        victronVrm: vrmResult,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\nVollständiger Rohbericht: ${reportPath}`);
  console.log('(Enthält keine Tokens. Ist über .gitignore von Git ausgeschlossen.)');
}

function printReport(
  fronius: readonly FroniusProbeResult[],
  victronLan: readonly VictronLanFinding[],
  victronModbus: readonly VictronModbusFinding[],
  vrm: VrmFinding | null,
): void {
  heading('Ergebnis');

  // --- Fronius ------------------------------------------------------------
  section('Fronius');
  if (fronius.length === 0) {
    console.log('  Nichts gefunden.');
    console.log('  Mögliche Ursachen: Wechselrichter in einem anderen Netz/VLAN,');
    console.log('  Gerät im Nachtmodus, oder Solar API deaktiviert.');
  }
  for (const result of fronius) {
    if (!result.reachable) {
      console.log(`\n  ${result.host}: Solar API DEAKTIVIERT`);
      console.log(`     ${result.hint}`);
      continue;
    }

    console.log(`\n  Host: ${result.host}`);
    console.log(`  Solar API Version: ${result.apiVersion ?? 'unbekannt'}`);
    if (result.compatibilityRange !== null) {
      console.log(`  Compatibility Range: ${result.compatibilityRange}`);
    }

    console.log(`\n  Wechselrichter (${result.inverters.length}):`);
    for (const device of result.inverters) console.log(`    - ${device.label}`);

    console.log(`  Smart Meter (${result.meters.length}):`);
    for (const device of result.meters) console.log(`    - ${device.label}`);

    console.log(`  Batteriespeicher (${result.storages.length}):`);
    for (const device of result.storages) console.log(`    - ${device.label}`);

    if (result.powerFlow !== null) {
      const flow = result.powerFlow;
      console.log('\n  Aktueller Energiefluss (ROHWERTE, noch nicht normalisiert):');
      console.log(`    Mode:            ${flow.mode ?? '—'}`);
      console.log(`    P_PV:            ${fmt(flow.pPv)} W   (+ = Erzeugung)`);
      console.log(`    P_Grid:          ${fmt(flow.pGrid)} W   (+ = Netzbezug, - = Einspeisung)`);
      console.log(`    P_Load:          ${fmt(flow.pLoad)} W   (- = Hausverbrauch!)`);
      console.log(`    P_Akku:          ${fmt(flow.pAkku)} W   (- = Laden, + = Entladen)`);
      console.log(`    Meter_Location:  ${flow.meterLocation ?? '—'}`);
      console.log(`    PowerFlowVersion:${flow.powerFlowVersion ?? '—'}`);
    }

    if (result.generationHints.length > 0) {
      console.log('\n  Hinweise zur Gerätegeneration:');
      for (const hint of result.generationHints) console.log(`    • ${hint}`);
    }
    if (result.warnings.length > 0) {
      console.log('\n  Warnungen:');
      for (const warning of result.warnings) console.log(`    ! ${warning}`);
    }
  }

  // --- Victron lokal, Modbus TCP -----------------------------------------
  section('Victron — lokales GX-Gerät (Modbus TCP)');
  if (victronModbus.length === 0) {
    console.log('  Kein GX-Gerät über Modbus TCP bestätigt.');
    console.log('  Modbus TCP ist am GX werkseitig aus: Einstellungen -> Dienste -> Modbus/TCP.');
  }
  for (const finding of victronModbus) {
    console.log(`\n  Host: ${finding.host}`);
    console.log(`  System-Serial (MAC): ${finding.systemSerial ?? '—'}`);

    console.log('\n  Systembatterie (Unit 100):');
    console.log(`    Spannung [840]: ${fmtUnit(finding.battery.voltageV, 'V')}`);
    console.log(`    Strom    [841]: ${fmtUnit(finding.battery.currentA, 'A')}`);
    console.log(
      `    Leistung [842]: ${fmtUnit(finding.battery.powerW, 'W')}   (+ = Laden, - = Entladen)`,
    );
    console.log(`    SOC      [843]: ${fmtUnit(finding.battery.socPercent, '%')}`);
    console.log(`    Zustand  [844]: ${finding.battery.state ?? '—'}`);

    console.log('\n  Energiefluss (ROHWERTE, Summe über L1/L2/L3):');
    console.log(`    Netz            [908]: ${fmtSum(finding.gridPerPhaseW)}   (+ = Bezug, - = Einspeisung)`);
    console.log(`    Hausverbrauch   [902]: ${fmtSum(finding.acConsumptionPerPhaseW)}`);
    console.log(`    PV AC am Eingang[890]: ${fmtSum(finding.pvAcOnGridPerPhaseW)}`);
    console.log(`    PV AC am Ausgang[884]: ${fmtSum(finding.pvAcOnOutputPerPhaseW)}`);
    console.log(`    PV DC-gekoppelt [850]: ${fmtUnit(finding.pvDcCoupledW, 'W')}`);

    if (finding.batteryServices.length > 0) {
      console.log('\n  Batteriedienste:');
      for (const service of finding.batteryServices) {
        console.log(
          `    - Unit ${service.unitId}: ${fmtUnit(service.voltageV, 'V')}, SOC ${fmtUnit(service.socPercent, '%')}, Kapazität ${fmtUnit(service.capacityAh, 'Ah')}`,
        );
      }
    }
    if (finding.pvInverterServices.length > 0) {
      console.log('\n  AC-gekoppelte PV-Wechselrichter im Victron-System:');
      for (const service of finding.pvInverterServices) {
        console.log(
          `    - Unit ${service.unitId}: Serial ${service.serial ?? '—'}, Position ${service.position}, ${fmtUnit(service.totalPowerW, 'W')}`,
        );
      }
    }
    for (const note of finding.notes) console.log(`    ! ${note}`);
  }

  // --- Victron lokal, MQTT ------------------------------------------------
  section('Victron — lokales GX-Gerät (MQTT)');
  if (victronLan.length === 0) {
    console.log('  Kein GX-Gerät mit offenem MQTT-Port gefunden.');
    console.log('  MQTT ist am GX werkseitig aus: Einstellungen -> Dienste -> MQTT aktivieren.');
    console.log('  MQTT liefert Push statt Polling und wäre für Live-Werte die bessere Quelle.');
  }
  for (const finding of victronLan) {
    console.log(`\n  Host: ${finding.host}`);
    console.log(`  Portal-ID: ${finding.portalId ?? 'nicht ermittelt'}`);
    console.log(`  Empfangene Topics: ${finding.topicCount}`);
    console.log(`  Vollständiger Publish abgeschlossen: ${finding.fullPublishCompleted ? 'ja' : 'nein'}`);

    if (finding.services.length > 0) {
      console.log('\n  Erkannte Dienste:');
      for (const service of finding.services) {
        console.log(
          `    - ${service.serviceType} (Instanzen: ${service.instances.join(', ') || '—'}, ${service.pathCount} Pfade)`,
        );
      }
    }
    for (const note of finding.notes) console.log(`    • ${note}`);
  }

  // --- Victron VRM --------------------------------------------------------
  section('Victron — VRM Cloud');
  if (vrm === null) {
    console.log('  Übersprungen (kein VRM_ACCESS_TOKEN gesetzt).');
  } else {
    console.log(`  Benutzer-ID: ${vrm.idUser ?? 'unbekannt'}`);
    for (const error of vrm.errors) console.log(`    ! ${error}`);

    for (const installation of vrm.installations) {
      console.log(`\n  Installation: ${installation.name} (idSite ${installation.idSite})`);
      console.log(`  Geräte (${installation.devices.length}):`);
      for (const device of installation.devices) {
        const parts = [device.name];
        if (device.productName !== null) parts.push(device.productName);
        if (device.instance !== null) parts.push(`Instance ${device.instance}`);
        if (device.firmwareVersion !== null) parts.push(`FW ${device.firmwareVersion}`);
        console.log(`    - ${parts.join(' | ')}`);
      }

      const battery = installation.liveAttributes.filter((attribute) =>
        /soc|state of charge|battery/i.test(attribute.description),
      );
      if (battery.length > 0) {
        console.log('\n  Batterie-relevante Messwerte:');
        for (const attribute of battery.slice(0, 15)) {
          console.log(
            `    - ${attribute.description}: ${attribute.formattedValue}  [code=${attribute.code}${attribute.dbusPath !== null ? `, ${attribute.dbusPath}` : ''}]`,
          );
        }
      }
      console.log(`\n  Insgesamt ${installation.liveAttributes.length} Messwerte verfügbar.`);
      for (const note of installation.notes) console.log(`    • ${note}`);
    }
  }
}

function fmt(value: number | null): string {
  return value === null ? '   null' : value.toFixed(0).padStart(7);
}

function fmtUnit(value: number | null, unit: string): string {
  return value === null ? '—' : `${value} ${unit}`;
}

function fmtSum(values: readonly number[] | null): string {
  if (values === null) return '—';
  const sum = values.reduce((total, value) => total + value, 0);
  return `${sum} W  (${values.join(' / ')})`;
}

main().catch((error: unknown) => {
  console.error('\nDiscovery abgebrochen:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
