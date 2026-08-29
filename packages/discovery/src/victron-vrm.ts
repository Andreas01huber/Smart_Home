/**
 * Victron-Erkennung über die offizielle VRM API.
 *
 * Grundlage: offizielle OpenAPI-3.1-Spec unter vrm-api-docs.victronenergy.com.
 *   Base URL:  https://vrmapi.victronenergy.com/v2
 *   Auth:      Header  x-authorization: Token <wert>
 *              (Bearer ist laut Doku seit 01.06.2026 deprecated.)
 *   Ratelimit: rollierendes Fenster von 200 Requests, alle 0,33 s fällt einer
 *              heraus, im Mittel also max. ~3 Requests/s. Bei 429 nennt
 *              Retry-After die Wartezeit.
 *
 * Der Token wird ausschließlich im Header verwendet, nie geloggt und nie in
 * einen Bericht geschrieben (Anforderungen 4H und 4T).
 */

const BASE_URL = 'https://vrmapi.victronenergy.com/v2';

/** Mindestabstand zwischen zwei Requests, konservativ unter dem Limit. */
const MIN_REQUEST_INTERVAL_MS = 400;

export interface VrmInstallation {
  readonly idSite: number;
  readonly name: string;
  readonly devices: readonly VrmDevice[];
  readonly liveAttributes: readonly VrmAttribute[];
  readonly notes: readonly string[];
}

export interface VrmDevice {
  readonly name: string;
  readonly productName: string | null;
  readonly instance: number | null;
  readonly firmwareVersion: string | null;
  readonly lastConnection: string | null;
}

export interface VrmAttribute {
  readonly code: string;
  readonly description: string;
  readonly dbusServiceType: string | null;
  readonly dbusPath: string | null;
  readonly formattedValue: string;
  readonly instance: number | null;
  readonly timestamp: number | null;
}

export interface VrmFinding {
  readonly idUser: number | null;
  readonly installations: readonly VrmInstallation[];
  readonly errors: readonly string[];
}

class VrmClient {
  private lastRequestAt = 0;

  constructor(private readonly token: string) {}

  async get(path: string): Promise<unknown> {
    await this.throttle();

    const response = await fetch(`${BASE_URL}${path}`, {
      headers: {
        // Laut Doku genau dieses Format. Kein "Bearer".
        'x-authorization': `Token ${this.token}`,
        accept: 'application/json',
      },
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '5');
      throw new Error(
        `VRM-Ratelimit erreicht. Retry-After: ${retryAfter} Sekunden.`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'VRM lehnt den Token ab (HTTP ' +
          response.status +
          '). Prüfe, ob der Access Token noch gültig ist und Zugriff auf die Installation hat.',
      );
    }
    if (!response.ok) {
      throw new Error(`VRM antwortete mit HTTP ${response.status} auf ${path}`);
    }

    return response.json();
  }

  private async throttle(): Promise<void> {
    const waitMs = this.lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.lastRequestAt = Date.now();
  }
}

export async function inspectVrm(
  token: string,
  diagnosticsCount = 200,
): Promise<VrmFinding> {
  const client = new VrmClient(token);
  const errors: string[] = [];

  let idUser: number | null = null;
  try {
    idUser = extractUserId(await client.get('/users/me'));
  } catch (error) {
    errors.push(`Benutzerabfrage fehlgeschlagen: ${describeError(error)}`);
    return { idUser: null, installations: [], errors };
  }

  if (idUser === null) {
    errors.push('VRM lieferte keine Benutzer-ID in /users/me.');
    return { idUser: null, installations: [], errors };
  }

  let sites: Array<{ idSite: number; name: string }> = [];
  try {
    sites = extractInstallations(await client.get(`/users/${idUser}/installations`));
  } catch (error) {
    errors.push(`Installationsliste fehlgeschlagen: ${describeError(error)}`);
    return { idUser, installations: [], errors };
  }

  const installations: VrmInstallation[] = [];
  for (const site of sites) {
    const notes: string[] = [];
    let devices: VrmDevice[] = [];
    let attributes: VrmAttribute[] = [];

    try {
      devices = extractDevices(
        await client.get(`/installations/${site.idSite}/system-overview`),
      );
    } catch (error) {
      notes.push(`Geräteliste fehlgeschlagen: ${describeError(error)}`);
    }

    try {
      attributes = extractAttributes(
        await client.get(
          `/installations/${site.idSite}/diagnostics?count=${diagnosticsCount}`,
        ),
      );
    } catch (error) {
      notes.push(`Diagnosedaten fehlgeschlagen: ${describeError(error)}`);
    }

    installations.push({
      idSite: site.idSite,
      name: site.name,
      devices,
      liveAttributes: attributes,
      notes,
    });
  }

  return { idUser, installations, errors };
}

// --- Defensives Parsen ----------------------------------------------------
// Victron leistet für die VRM API laut eigener Doku keinen Endkundensupport.
// Feldnamen können sich ändern, deshalb wird nichts erzwungen: Was fehlt,
// wird zu null, statt die Erkennung abzubrechen.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function extractUserId(response: unknown): number | null {
  if (!isRecord(response)) return null;
  const user = isRecord(response['user']) ? response['user'] : response;
  return asNumber(user['id']) ?? asNumber(user['idUser']);
}

function extractInstallations(
  response: unknown,
): Array<{ idSite: number; name: string }> {
  if (!isRecord(response)) return [];
  const records = response['records'];
  if (!Array.isArray(records)) return [];

  const sites: Array<{ idSite: number; name: string }> = [];
  for (const record of records) {
    if (!isRecord(record)) continue;
    const idSite = asNumber(record['idSite']);
    if (idSite === null) continue;
    sites.push({
      idSite,
      name: asString(record['name']) ?? `Installation ${idSite}`,
    });
  }
  return sites;
}

function extractDevices(response: unknown): VrmDevice[] {
  if (!isRecord(response)) return [];
  const records = response['records'];
  if (!isRecord(records)) return [];
  const devices = records['devices'];
  if (!Array.isArray(devices)) return [];

  const result: VrmDevice[] = [];
  for (const device of devices) {
    if (!isRecord(device)) continue;
    result.push({
      name:
        asString(device['customName']) ??
        asString(device['name']) ??
        'Unbenanntes Gerät',
      productName: asString(device['productName']),
      instance: asNumber(device['instance']),
      firmwareVersion: asString(device['firmwareVersion']),
      lastConnection: formatTimestamp(device['lastConnection']),
    });
  }
  return result;
}

function extractAttributes(response: unknown): VrmAttribute[] {
  if (!isRecord(response)) return [];
  const records = response['records'];
  const list = Array.isArray(records)
    ? records
    : isRecord(records)
      ? Object.values(records)
      : [];

  const result: VrmAttribute[] = [];
  for (const record of list) {
    if (!isRecord(record)) continue;
    const code = asString(record['code']);
    if (code === null) continue;
    result.push({
      code,
      description: asString(record['description']) ?? code,
      dbusServiceType: asString(record['dbusServiceType']),
      dbusPath: asString(record['dbusPath']),
      formattedValue: asString(record['formattedValue']) ?? '',
      instance: asNumber(record['instance']),
      timestamp: asNumber(record['timestamp']),
    });
  }
  return result;
}

function formatTimestamp(value: unknown): string | null {
  const numeric = asNumber(value);
  if (numeric === null || numeric === 0) return null;
  // VRM liefert Unix-Timestamps teils in Sekunden, teils in Millisekunden.
  const ms = numeric > 1e12 ? numeric : numeric * 1000;
  return new Date(ms).toISOString();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
