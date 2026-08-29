/**
 * Ermittlung der lokalen Netze und einfache TCP-Erreichbarkeitsprüfung.
 * Gemeinsame Basis für die Fronius- und Victron-Suche im LAN.
 */

import { networkInterfaces } from 'node:os';
import { Socket } from 'node:net';

export interface LocalSubnet {
  readonly interfaceName: string;
  /** Eigene IP-Adresse auf diesem Interface. */
  readonly ownAddress: string;
  readonly netmask: string;
  /** Alle scanbaren Host-Adressen ohne Netz-, Broadcast- und eigene Adresse. */
  readonly hosts: readonly string[];
}

/** Obergrenze, damit ein versehentliches /16 nicht Stunden läuft. */
const MAX_HOSTS_PER_SUBNET = 1024;

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`Ungültige IPv4-Adresse: ${ip}`);
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIp(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

/**
 * Listet die privaten IPv4-Netze auf, in denen dieser Rechner steckt.
 * Loopback und öffentliche Adressen werden übersprungen.
 */
export function localSubnets(): LocalSubnet[] {
  const result: LocalSubnet[] = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (!isPrivateIPv4(address.address)) continue;

      const ownInt = ipToInt(address.address);
      const maskInt = ipToInt(address.netmask);
      const network = (ownInt & maskInt) >>> 0;
      const broadcast = (network | (~maskInt >>> 0)) >>> 0;
      const total = broadcast - network - 1;

      if (total <= 0) continue;
      if (total > MAX_HOSTS_PER_SUBNET) {
        // Zu großes Netz für einen Vollscan. Wir beschränken uns auf das
        // /24 rund um die eigene Adresse — dort steht Hausautomatisierung
        // praktisch immer.
        const localNetwork = (ownInt & ipToInt('255.255.255.0')) >>> 0;
        result.push(
          buildSubnet(name, address.address, '255.255.255.0', localNetwork, localNetwork + 255),
        );
        continue;
      }

      result.push(buildSubnet(name, address.address, address.netmask, network, broadcast));
    }
  }

  return result;
}

function buildSubnet(
  interfaceName: string,
  ownAddress: string,
  netmask: string,
  network: number,
  broadcast: number,
): LocalSubnet {
  const ownInt = ipToInt(ownAddress);
  const hosts: string[] = [];
  for (let current = network + 1; current < broadcast; current++) {
    if (current === ownInt) continue;
    hosts.push(intToIp(current));
  }
  return { interfaceName, ownAddress, netmask, hosts };
}

export function isPrivateIPv4(ip: string): boolean {
  const value = ipToInt(ip);
  const inRange = (from: string, to: string): boolean =>
    value >= ipToInt(from) && value <= ipToInt(to);

  return (
    inRange('10.0.0.0', '10.255.255.255') ||
    inRange('172.16.0.0', '172.31.255.255') ||
    inRange('192.168.0.0', '192.168.255.255')
  );
}

/** Prüft, ob ein TCP-Port erreichbar ist. Antwortet nie mit einem Fehler. */
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Führt eine Aufgabe über viele Hosts mit begrenzter Parallelität aus.
 * Ohne Begrenzung öffnet ein /24-Scan schlagartig 254 Sockets.
 */
export async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  task: (item: TIn) => Promise<TOut>,
  onProgress?: (done: number, total: number) => void,
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let nextIndex = 0;
  let completed = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await task(items[index]!);
      completed++;
      onProgress?.(completed, items.length);
    }
  });

  await Promise.all(workers);
  return results;
}
