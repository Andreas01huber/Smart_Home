/**
 * Victron-Erkennung über das lokale GX-Gerät (MQTT).
 *
 * Grundlage: offizielle Doku zu `dbus-flashmq`, dem seit Venus OS 3.20
 * integrierten MQTT-Dienst. Topic-Schema laut Doku:
 *   <PREFIX>/<portal ID>/<service_type>/<device instance>/<D-Bus path>
 * mit N/ = Notification, W/ = Write, R/ = Read-Request.
 *
 * Es wird ausschließlich gelesen. Der einzige Publish ist das laut Doku
 * zwingende Keepalive auf R/<portal ID>/keepalive (Timeout 60 s).
 */

import mqtt from 'mqtt';
import { mapWithConcurrency, tcpProbe } from './net.ts';

const MQTT_PLAIN_PORT = 1883;

export interface VictronService {
  readonly serviceType: string;
  readonly instances: readonly string[];
  /** Tatsächlich beobachtete D-Bus-Pfade, gekürzt auf eine Auswahl. */
  readonly observedPaths: readonly string[];
  readonly pathCount: number;
}

export interface VictronLanFinding {
  readonly host: string;
  readonly portalId: string | null;
  readonly services: readonly VictronService[];
  readonly topicCount: number;
  readonly fullPublishCompleted: boolean;
  readonly notes: readonly string[];
}

/** Sucht im LAN nach GX-Geräten mit offenem MQTT-Port. */
export async function scanForVictronGx(
  hosts: readonly string[],
  options: {
    probeTimeoutMs?: number;
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<string[]> {
  const probeTimeoutMs = options.probeTimeoutMs ?? 1200;
  const concurrency = options.concurrency ?? 64;

  const outcomes = await mapWithConcurrency(
    hosts,
    concurrency,
    async (host) => ({
      host,
      open: await tcpProbe(host, MQTT_PLAIN_PORT, probeTimeoutMs),
    }),
    options.onProgress,
  );

  return outcomes.filter((outcome) => outcome.open).map((outcome) => outcome.host);
}

/**
 * Verbindet sich mit dem lokalen Broker und erfasst, welche Dienste und
 * Geräte das GX-System tatsächlich meldet.
 *
 * @param portalId Wenn bekannt, wird sofort das Keepalive gesendet. Sonst
 *   versucht die Funktion, die Portal-ID über einen Wildcard-Subscribe zu
 *   ermitteln.
 */
export async function inspectVictronGx(
  host: string,
  portalId: string | null,
  collectMs = 8000,
): Promise<VictronLanFinding> {
  const notes: string[] = [];
  const topics = new Map<string, Set<string>>();
  const instances = new Map<string, Set<string>>();
  let discoveredPortalId = portalId;
  let fullPublishCompleted = false;
  let topicCount = 0;

  const client = mqtt.connect(`mqtt://${host}:${MQTT_PLAIN_PORT}`, {
    connectTimeout: 5000,
    reconnectPeriod: 0,
    clientId: `appsmarthome-discovery-${Math.random().toString(16).slice(2, 10)}`,
  });

  const keepaliveTimers: NodeJS.Timeout[] = [];

  try {
    await once(client, 'connect', 6000);

    // Ohne bekannte Portal-ID zuerst per Wildcard danach horchen.
    if (discoveredPortalId === null) {
      client.subscribe('N/+/system/0/Serial');
      client.subscribe('N/+/system/0/#');
      notes.push(
        'Portal-ID war nicht vorgegeben — es wurde per Wildcard-Subscribe danach gesucht.',
      );
    }

    client.on('message', (topic, payload) => {
      topicCount++;
      const segments = topic.split('/');
      // N / <portalId> / <serviceType> / <instance> / <pfad...>
      if (segments.length < 3) return;

      const [prefix, portal, serviceType, instance, ...rest] = segments;
      if (prefix !== 'N' || portal === undefined) return;

      if (discoveredPortalId === null) {
        discoveredPortalId = portal;
        notes.push(`Portal-ID über MQTT erkannt: ${portal}`);
        startKeepalive(client, portal, keepaliveTimers);
        client.subscribe(`N/${portal}/#`);
      }

      if (serviceType === 'full_publish_completed') {
        fullPublishCompleted = true;
        return;
      }
      if (serviceType === undefined || instance === undefined) return;

      const pathSet = topics.get(serviceType) ?? new Set<string>();
      pathSet.add(rest.join('/'));
      topics.set(serviceType, pathSet);

      const instanceSet = instances.get(serviceType) ?? new Set<string>();
      instanceSet.add(instance);
      instances.set(serviceType, instanceSet);

      void payload;
    });

    if (discoveredPortalId !== null) {
      startKeepalive(client, discoveredPortalId, keepaliveTimers);
      client.subscribe(`N/${discoveredPortalId}/#`);
    }

    await delay(collectMs);

    if (topicCount === 0) {
      notes.push(
        'Der Broker antwortet, hat aber keine Werte gesendet. Das GX-Gerät veröffentlicht seit Venus OS 3.20 nur nach einem Keepalive auf R/<portal ID>/keepalive. Trage die Portal-ID aus "GX -> Einstellungen -> VRM Online Portal" als VICTRON_PORTAL_ID in die .env ein und starte die Suche erneut.',
      );
    }
    if (!fullPublishCompleted && topicCount > 0) {
      notes.push(
        'Kein full_publish_completed innerhalb des Sammelfensters — die Liste kann unvollständig sein.',
      );
    }
  } catch (error) {
    notes.push(`MQTT-Verbindung fehlgeschlagen: ${describeError(error)}`);
  } finally {
    for (const timer of keepaliveTimers) clearInterval(timer);
    client.end(true);
  }

  const services: VictronService[] = [...topics.entries()]
    .map(([serviceType, paths]) => ({
      serviceType,
      instances: [...(instances.get(serviceType) ?? [])].sort(),
      observedPaths: [...paths].sort().slice(0, 25),
      pathCount: paths.size,
    }))
    .sort((a, b) => a.serviceType.localeCompare(b.serviceType));

  return {
    host,
    portalId: discoveredPortalId,
    services,
    topicCount,
    fullPublishCompleted,
    notes,
  };
}

/** Keepalive laut Doku alle < 60 s, hier bewusst deutlich häufiger. */
function startKeepalive(
  client: mqtt.MqttClient,
  portalId: string,
  timers: NodeJS.Timeout[],
): void {
  const send = (): void => {
    client.publish(`R/${portalId}/keepalive`, '');
  };
  send();
  timers.push(setInterval(send, 20_000));
}

function once(
  client: mqtt.MqttClient,
  event: 'connect',
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Zeitüberschreitung')), timeoutMs);
    client.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
