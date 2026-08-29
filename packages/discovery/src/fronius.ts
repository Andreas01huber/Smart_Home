/**
 * Fronius-Erkennung über die lokale Solar API V1.
 *
 * Alle hier verwendeten Pfade stammen aus der offiziellen Dokumentation
 * "Fronius Solar API V1 Operating Instructions", Dok.-Nr. 42,0410,2012 (Rev. 05/2025).
 * Siehe docs/01-datenquellen-verifikation.md. Es wird nichts geraten.
 */

import { mapWithConcurrency } from './net.ts';

/** Einstiegspunkt laut Doku Abschnitt 2.4.1. */
const API_VERSION_PATH = '/solar_api/GetAPIVersion.cgi';

export interface FroniusDevice {
  readonly id: string;
  readonly label: string;
  readonly details: Record<string, unknown>;
}

export interface FroniusFinding {
  readonly host: string;
  readonly reachable: true;
  readonly apiVersion: number | null;
  readonly baseUrl: string | null;
  readonly compatibilityRange: string | null;
  readonly inverters: readonly FroniusDevice[];
  readonly meters: readonly FroniusDevice[];
  readonly storages: readonly FroniusDevice[];
  readonly powerFlow: FroniusPowerFlowSummary | null;
  /**
   * Belegbare Hinweise auf die Gerätegeneration. Bewusst als Indizien
   * formuliert und nicht als Gewissheit — die Solar API meldet die
   * Generation nicht direkt.
   */
  readonly generationHints: readonly string[];
  readonly warnings: readonly string[];
}

export interface FroniusDisabledFinding {
  readonly host: string;
  readonly reachable: false;
  readonly reason: 'solar-api-disabled';
  readonly hint: string;
}

export type FroniusProbeResult = FroniusFinding | FroniusDisabledFinding;

export interface FroniusPowerFlowSummary {
  readonly mode: string | null;
  /** Rohwert. Doku: "+ from grid, - to grid". */
  readonly pGrid: number | null;
  /** Rohwert. Doku: "+ generator, - consumer" — Verbrauch ist negativ. */
  readonly pLoad: number | null;
  /** Rohwert. Doku: "- charge, + discharge". */
  readonly pAkku: number | null;
  /** Rohwert. Doku: "+ production". Auf GEN24/Symo Hybrid die DC-Seite. */
  readonly pPv: number | null;
  readonly eDay: number | null;
  readonly eTotal: number | null;
  readonly meterLocation: string | null;
  readonly powerFlowVersion: string | null;
  readonly backupModePresent: boolean;
}

async function getJson(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Schneller Erstkontakt: Ist an dieser Adresse eine Fronius Solar API? */
async function probeHost(
  host: string,
  timeoutMs: number,
): Promise<'found' | 'disabled' | 'no'> {
  try {
    const result = await getJson(`http://${host}${API_VERSION_PATH}`, timeoutMs);

    // Doku Abschnitt 3: Bei deaktivierter Solar API antwortet das Gerät mit
    // HTTP 404 und "Solar API disabled by customer config".
    // Am realen GEN24 lautet der Text "SolarAPI disabled by customer config",
    // also ohne Leerzeichen — das Leerzeichen ist deshalb optional.
    if (result.status === 404 && /solar\s?api disabled/i.test(result.text)) {
      return 'disabled';
    }
    if (result.ok && isRecord(result.body) && 'APIVersion' in result.body) {
      return 'found';
    }
    return 'no';
  } catch {
    return 'no';
  }
}

/** Vollständige Abfrage eines bestätigten Fronius-Hosts. */
export async function inspectFronius(
  host: string,
  timeoutMs = 5000,
): Promise<FroniusFinding> {
  const warnings: string[] = [];
  const hints: string[] = [];

  const version = await getJson(`http://${host}${API_VERSION_PATH}`, timeoutMs);
  const versionBody = isRecord(version.body) ? version.body : {};
  const baseUrl = asString(versionBody['BaseURL']) ?? '/solar_api/v1/';
  const base = `http://${host}${baseUrl.replace(/\/$/, '')}`;

  const [inverterInfo, activeDevices, powerFlow, meters, storages] = await Promise.all([
    safeJson(`${base}/GetInverterInfo.cgi`, timeoutMs),
    safeJson(`${base}/GetActiveDeviceInfo.cgi?DeviceClass=System`, timeoutMs),
    safeJson(`${base}/GetPowerFlowRealtimeData.fcgi`, timeoutMs),
    safeJson(`${base}/GetMeterRealtimeData.cgi?Scope=System`, timeoutMs),
    safeJson(`${base}/GetStorageRealtimeData.cgi?Scope=System`, timeoutMs),
  ]);

  const inverters = toDevices(dataOf(inverterInfo), (id, entry) => ({
    id,
    label:
      asDecodedString(entry['CustomName']) ??
      `Wechselrichter ${id}` +
        (entry['DT'] !== undefined ? ` (DT ${String(entry['DT'])})` : ''),
    details: entry,
  }));

  const meterDevices = toDevices(dataOf(meters), (id, entry) => ({
    id,
    label: describeMeter(id, entry),
    details: entry,
  }));

  const storageDevices = toDevices(dataOf(storages), (id, entry) => ({
    id,
    label: describeStorage(id, entry),
    details: entry,
  }));

  const flow = summarizePowerFlow(powerFlow);

  // --- Generationshinweise, jeweils mit Beleg aus der Doku ----------------
  if (flow) {
    if (flow.eDay === null) {
      hints.push(
        'Site.E_Day ist null — laut Doku ist E_Day auf GEN24/Tauro/Verto immer null. Deutet auf GEN24/Tauro/Verto hin.',
      );
    } else {
      hints.push(
        `Site.E_Day liefert einen Wert (${flow.eDay} Wh) — auf GEN24/Tauro/Verto wäre das null. Deutet auf SnapInverter oder Symo Hybrid hin.`,
      );
    }
    if (flow.backupModePresent) {
      hints.push(
        'Site.BackupMode ist vorhanden — laut Doku auf GEN24 immer verfügbar und auf Non-Hybrid nicht vorhanden.',
      );
    }
    if (flow.meterLocation !== null) {
      hints.push(
        `Meter_Location = "${flow.meterLocation}" — entscheidet über die Richtungsinterpretation der Zählerwerte.`,
      );
    }
  }

  const inverterDts = inverters
    .map((device) => device.details['DT'])
    .filter((dt): dt is number => typeof dt === 'number');
  if (inverterDts.length > 0 && inverterDts.every((dt) => dt === 1)) {
    hints.push(
      'Alle Wechselrichter melden DT = 1 — laut Doku melden GEN24/Tauro/Verto genau diesen Wert.',
    );
  }

  const loggerInfo = await safeJson(`${base}/GetLoggerInfo.cgi`, timeoutMs);
  if (loggerInfo !== null) {
    hints.push('GetLoggerInfo antwortet — spricht für einen Datamanager (SnapInverter-Linie).');
  }

  // --- Warnungen ----------------------------------------------------------
  if (inverters.length > 1) {
    warnings.push(
      `${inverters.length} Wechselrichter erkannt. Auf GEN24/Tauro/Verto sind System-Requests über mehrere Geräte laut Doku nicht unterstützt — jeder Wechselrichter muss einzeln abgefragt werden.`,
    );
  }
  if (meterDevices.length === 0) {
    warnings.push(
      'Kein Smart Meter gefunden. Ohne Smart Meter liefert die Solar API laut Doku P_Grid, P_Load, rel_SelfConsumption und rel_Autonomy als null — Hausverbrauch und Netzwerte sind dann nicht verfügbar.',
    );
  }
  if (storageDevices.length === 0) {
    warnings.push('Kein Batteriespeicher über GetStorageRealtimeData gefunden.');
  }
  if (activeDevices === null) {
    warnings.push('GetActiveDeviceInfo lieferte keine verwertbare Antwort.');
  }

  return {
    host,
    reachable: true,
    apiVersion: asNumber(versionBody['APIVersion']),
    baseUrl,
    compatibilityRange: asString(versionBody['CompatibilityRange']),
    inverters,
    meters: meterDevices,
    storages: storageDevices,
    powerFlow: flow,
    generationHints: hints,
    warnings,
  };
}

/** Durchsucht eine Hostliste nach Fronius-Geräten. */
export async function scanForFronius(
  hosts: readonly string[],
  options: {
    probeTimeoutMs?: number;
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<FroniusProbeResult[]> {
  const probeTimeoutMs = options.probeTimeoutMs ?? 1200;
  const concurrency = options.concurrency ?? 64;

  const outcomes = await mapWithConcurrency(
    hosts,
    concurrency,
    async (host) => ({ host, state: await probeHost(host, probeTimeoutMs) }),
    options.onProgress,
  );

  const results: FroniusProbeResult[] = [];
  for (const outcome of outcomes) {
    if (outcome.state === 'found') {
      results.push(await inspectFronius(outcome.host));
    } else if (outcome.state === 'disabled') {
      results.push({
        host: outcome.host,
        reachable: false,
        reason: 'solar-api-disabled',
        hint: 'Das Gerät antwortet, die Solar API ist aber deaktiviert. Im Wechselrichter-WebUI unter "Kommunikation -> Solar API" aktivieren. Auf GEN24 ab Bundle-Version 1.14.1 ist sie werkseitig aus.',
      });
    }
  }
  return results;
}

// --- Hilfsfunktionen ------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Fronius liefert `CustomName` HTML-maskiert, z. B. `&#83;&#121;&#109;&#111;`
 * für "Symo". Ohne Dekodierung landet der Rohtext in der Oberfläche.
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function asDecodedString(value: unknown): string | null {
  const raw = asString(value);
  return raw === null ? null : decodeHtmlEntities(raw);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function safeJson(url: string, timeoutMs: number): Promise<unknown> {
  try {
    const result = await getJson(url, timeoutMs);
    return result.ok ? result.body : null;
  } catch {
    return null;
  }
}

/** Alle Solar-API-Antworten kapseln die Nutzdaten in `Body.Data`. */
function dataOf(response: unknown): Record<string, unknown> | null {
  if (!isRecord(response)) return null;
  const body = response['Body'];
  if (!isRecord(body)) return null;
  const data = body['Data'];
  return isRecord(data) ? data : null;
}

function toDevices(
  data: Record<string, unknown> | null,
  build: (id: string, entry: Record<string, unknown>) => FroniusDevice,
): FroniusDevice[] {
  if (data === null) return [];
  const devices: FroniusDevice[] = [];
  for (const [id, entry] of Object.entries(data)) {
    if (isRecord(entry)) devices.push(build(id, entry));
  }
  return devices;
}

function describeMeter(id: string, entry: Record<string, unknown>): string {
  const details = isRecord(entry['Details']) ? entry['Details'] : {};
  const model = asDecodedString(details['Model']);
  const serial = asDecodedString(details['Serial']);
  const location = entry['Meter_Location_Current'];
  const parts = [model ?? `Smart Meter ${id}`];
  if (serial !== null) parts.push(`S/N ${serial}`);
  if (location !== undefined) parts.push(`Location ${String(location)}`);
  return parts.join(', ');
}

function describeStorage(id: string, entry: Record<string, unknown>): string {
  const controller = isRecord(entry['Controller']) ? entry['Controller'] : {};
  const details = isRecord(controller['Details']) ? controller['Details'] : {};
  const manufacturer = asDecodedString(details['Manufacturer']);
  const model = asDecodedString(details['Model']);
  const capacity = asNumber(controller['DesignedCapacity']);
  const soc = asNumber(controller['StateOfCharge_Relative']);

  const parts = [[manufacturer, model].filter(Boolean).join(' ') || `Speicher ${id}`];
  if (capacity !== null) parts.push(`Nennkapazität ${capacity} Wh`);
  if (soc !== null) parts.push(`SOC ${soc} %`);
  return parts.join(', ');
}

function summarizePowerFlow(response: unknown): FroniusPowerFlowSummary | null {
  const data = dataOf(response);
  if (data === null) return null;
  const site = isRecord(data['Site']) ? data['Site'] : null;
  if (site === null) return null;

  const version = isRecord(response) && isRecord(response['Body'])
    ? asString((response['Body'] as Record<string, unknown>)['Version'])
    : null;

  return {
    mode: asString(site['Mode']),
    pGrid: asNumber(site['P_Grid']),
    pLoad: asNumber(site['P_Load']),
    pAkku: asNumber(site['P_Akku']),
    pPv: asNumber(site['P_PV']),
    eDay: asNumber(site['E_Day']),
    eTotal: asNumber(site['E_Total']),
    meterLocation: asString(site['Meter_Location']),
    powerFlowVersion: version,
    backupModePresent: 'BackupMode' in site,
  };
}
