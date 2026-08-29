/**
 * Victron-Zugriff über Modbus TCP am GX-Gerät.
 *
 * Alle hier verwendeten Registeradressen stammen aus der offiziellen
 * Registerliste `CCGX-Modbus-TCP-register-list.xlsx` (victronenergy/dbus_modbustcp).
 * Es wird kein Register geraten.
 *
 * Laut offiziellem GX Modbus-TCP Manual ist Unit-ID 100 der systemweite
 * Dienst `com.victronenergy.system` und gegenüber Unit-ID 0 zu bevorzugen.
 *
 * Zugriff ist ausschließlich lesend (Funktionscode 3).
 */

import { Socket } from 'node:net';
import { mapWithConcurrency, tcpProbe } from './net.ts';

export const MODBUS_TCP_PORT = 502;
const SYSTEM_UNIT_ID = 100;

/**
 * Verifizierte Register des Dienstes com.victronenergy.system (Unit-ID 100).
 * `scale` ist der Divisor aus der Spalte "Scalefactor" der offiziellen Liste.
 */
export const SYSTEM_REGISTERS = {
  serial: { address: 800, words: 6, type: 'string' },
  batteryVoltage: { address: 840, words: 1, type: 'uint16', scale: 10, unit: 'V' },
  batteryCurrent: { address: 841, words: 1, type: 'int16', scale: 10, unit: 'A' },
  batteryPower: { address: 842, words: 1, type: 'int16', scale: 1, unit: 'W' },
  batterySoc: { address: 843, words: 1, type: 'uint16', scale: 1, unit: '%' },
  batteryState: { address: 844, words: 1, type: 'uint16', scale: 1, unit: '' },
  pvDcCoupledW: { address: 850, words: 1, type: 'uint16', scale: 1, unit: 'W' },
  pvAcOnOutputW: { address: 884, words: 6, type: 'uint32x3', unit: 'W' },
  pvAcOnGridW: { address: 890, words: 6, type: 'uint32x3', unit: 'W' },
  acConsumptionW: { address: 902, words: 6, type: 'uint32x3', unit: 'W' },
  gridW: { address: 908, words: 6, type: 'int32x3', unit: 'W' },
} as const;

/** Register 844: 0=idle;1=charging;2=discharging (laut offizieller Liste). */
const BATTERY_STATE_LABELS: Record<number, string> = {
  0: 'idle',
  1: 'charging',
  2: 'discharging',
};

export interface VictronModbusFinding {
  readonly host: string;
  readonly systemSerial: string | null;
  readonly battery: {
    readonly voltageV: number | null;
    readonly currentA: number | null;
    /** Rohwert. Victron-Konvention: positiv = Laden, negativ = Entladen. */
    readonly powerW: number | null;
    readonly socPercent: number | null;
    readonly state: string | null;
  };
  readonly gridPerPhaseW: readonly number[] | null;
  readonly acConsumptionPerPhaseW: readonly number[] | null;
  readonly pvAcOnGridPerPhaseW: readonly number[] | null;
  readonly pvAcOnOutputPerPhaseW: readonly number[] | null;
  readonly pvDcCoupledW: number | null;
  readonly batteryServices: readonly VictronBatteryService[];
  readonly pvInverterServices: readonly VictronPvInverterService[];
  readonly notes: readonly string[];
}

export interface VictronBatteryService {
  readonly unitId: number;
  readonly voltageV: number | null;
  readonly socPercent: number | null;
  /** Register 309 /Capacity in Ah. 0 bedeutet: Gerät meldet keine Kapazität. */
  readonly capacityAh: number | null;
}

export interface VictronPvInverterService {
  readonly unitId: number;
  readonly serial: string | null;
  readonly position: string;
  readonly totalPowerW: number | null;
  readonly perPhaseW: readonly number[] | null;
}

/** Register 1026 /Position laut offizieller Liste. */
const PV_POSITION_LABELS: Record<number, string> = {
  0: 'AC input 1',
  1: 'AC output',
  2: 'AC input 2',
};

/** Minimaler Modbus-TCP-Client, Funktionscode 3 (Read Holding Registers). */
export function readHoldingRegisters(
  host: string,
  unitId: number,
  startAddress: number,
  wordCount: number,
  timeoutMs = 3000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const request = Buffer.alloc(12);
    request.writeUInt16BE(1, 0); // Transaction ID
    request.writeUInt16BE(0, 2); // Protocol ID (0 = Modbus)
    request.writeUInt16BE(6, 4); // Länge der folgenden Bytes
    request.writeUInt8(unitId, 6);
    request.writeUInt8(3, 7); // FC 3
    request.writeUInt16BE(startAddress, 8);
    request.writeUInt16BE(wordCount, 10);

    let buffer = Buffer.alloc(0);
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fail(new Error('Zeitüberschreitung')));
    socket.once('error', fail);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 9) return;
      const declaredLength = buffer.readUInt16BE(4);
      if (buffer.length < 6 + declaredLength) return;

      socket.destroy();
      const functionCode = buffer.readUInt8(7);
      if ((functionCode & 0x80) !== 0) {
        reject(new Error(`Modbus-Exception ${buffer.readUInt8(8)}`));
        return;
      }
      const byteCount = buffer.readUInt8(8);
      resolve(buffer.subarray(9, 9 + byteCount));
    });

    socket.connect(MODBUS_TCP_PORT, host, () => socket.write(request));
  });
}

/** Sucht im LAN nach GX-Geräten mit offenem Modbus-TCP-Port. */
export async function scanForVictronModbus(
  hosts: readonly string[],
  options: {
    probeTimeoutMs?: number;
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<string[]> {
  const outcomes = await mapWithConcurrency(
    hosts,
    options.concurrency ?? 64,
    async (host) => ({
      host,
      open: await tcpProbe(host, MODBUS_TCP_PORT, options.probeTimeoutMs ?? 1200),
    }),
    options.onProgress,
  );

  const candidates: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.open) continue;
    // Ein offener Port 502 allein beweist noch kein Victron-Gerät. Erst die
    // erfolgreiche Antwort auf Unit-ID 100 bestätigt com.victronenergy.system.
    try {
      await readHoldingRegisters(outcome.host, SYSTEM_UNIT_ID, 800, 1, 2500);
      candidates.push(outcome.host);
    } catch {
      // Kein Victron-System an dieser Adresse.
    }
  }
  return candidates;
}

export async function inspectVictronModbus(
  host: string,
): Promise<VictronModbusFinding> {
  const notes: string[] = [];

  const serial = await tryRead(host, SYSTEM_UNIT_ID, 800, 6, (b) =>
    b.toString('latin1').replace(/\0/g, '').trim(),
  );

  const batteryBlock = await tryRead(host, SYSTEM_UNIT_ID, 840, 5, (b) => ({
    voltageV: b.readUInt16BE(0) / 10,
    currentA: b.readInt16BE(2) / 10,
    powerW: b.readInt16BE(4),
    socPercent: b.readUInt16BE(6),
    state: BATTERY_STATE_LABELS[b.readUInt16BE(8)] ?? String(b.readUInt16BE(8)),
  }));

  const gridPerPhaseW = await tryRead(host, SYSTEM_UNIT_ID, 908, 6, (b) =>
    [0, 1, 2].map((i) => b.readInt32BE(i * 4)),
  );
  const acConsumptionPerPhaseW = await tryRead(host, SYSTEM_UNIT_ID, 902, 6, (b) =>
    [0, 1, 2].map((i) => b.readUInt32BE(i * 4)),
  );
  const pvAcOnGridPerPhaseW = await tryRead(host, SYSTEM_UNIT_ID, 890, 6, (b) =>
    [0, 1, 2].map((i) => b.readUInt32BE(i * 4)),
  );
  const pvAcOnOutputPerPhaseW = await tryRead(host, SYSTEM_UNIT_ID, 884, 6, (b) =>
    [0, 1, 2].map((i) => b.readUInt32BE(i * 4)),
  );
  const pvDcCoupledW = await tryRead(host, SYSTEM_UNIT_ID, 850, 1, (b) =>
    b.readUInt16BE(0),
  );

  const { batteryServices, pvInverterServices } = await enumerateUnits(host);

  if (batteryServices.some((service) => service.capacityAh === 0)) {
    notes.push(
      'Mindestens ein Batteriedienst meldet /Capacity = 0. Das Gerät gibt seine Kapazität nicht über Modbus preis — die nutzbare Kapazität muss laut Anforderung 4J manuell konfiguriert werden.',
    );
  }
  if (pvInverterServices.length > 0) {
    notes.push(
      `Das GX-System kennt ${pvInverterServices.length} AC-gekoppelte(n) PV-Wechselrichter. Deren Leistung steckt bereits in /Ac/PvOnGrid bzw. /Ac/PvOnOutput — sie darf nicht zusätzlich aus der Fronius-Quelle addiert werden.`,
    );
  }

  return {
    host,
    systemSerial: serial,
    battery: batteryBlock ?? {
      voltageV: null,
      currentA: null,
      powerW: null,
      socPercent: null,
      state: null,
    },
    gridPerPhaseW,
    acConsumptionPerPhaseW,
    pvAcOnGridPerPhaseW,
    pvAcOnOutputPerPhaseW,
    pvDcCoupledW,
    batteryServices,
    pvInverterServices,
    notes,
  };
}

/**
 * Ermittelt, welche Unit-IDs am GX antworten und welchem Dienst sie gehören.
 * Die Zuordnung erfolgt über je ein dienstspezifisches Register.
 */
async function enumerateUnits(host: string): Promise<{
  batteryServices: VictronBatteryService[];
  pvInverterServices: VictronPvInverterService[];
}> {
  const batteryServices: VictronBatteryService[] = [];
  const pvInverterServices: VictronPvInverterService[] = [];

  for (let unitId = 0; unitId < 256; unitId++) {
    if (unitId === SYSTEM_UNIT_ID) continue;

    // 259 = com.victronenergy.battery /Dc/0/Voltage
    const voltage = await tryRead(host, unitId, 259, 1, (b) => b.readUInt16BE(0) / 100, 900);
    if (voltage !== null) {
      batteryServices.push({
        unitId,
        voltageV: voltage,
        socPercent: await tryRead(host, unitId, 266, 1, (b) => b.readUInt16BE(0) / 10),
        capacityAh: await tryRead(host, unitId, 309, 1, (b) => b.readUInt16BE(0) / 10),
      });
      continue;
    }

    // 1026 = com.victronenergy.pvinverter /Position
    const position = await tryRead(host, unitId, 1026, 1, (b) => b.readUInt16BE(0), 700);
    if (position !== null) {
      pvInverterServices.push({
        unitId,
        serial: await tryRead(host, unitId, 1039, 7, (b) =>
          b.toString('latin1').replace(/\0/g, '').trim(),
        ),
        position: PV_POSITION_LABELS[position] ?? String(position),
        totalPowerW: await tryRead(host, unitId, 1052, 2, (b) => b.readInt32BE(0)),
        perPhaseW: await tryRead(host, unitId, 1058, 6, (b) =>
          [0, 1, 2].map((i) => b.readUInt32BE(i * 4)),
        ),
      });
    }
  }

  return { batteryServices, pvInverterServices };
}

async function tryRead<T>(
  host: string,
  unitId: number,
  address: number,
  words: number,
  decode: (buffer: Buffer) => T,
  timeoutMs = 3000,
): Promise<T | null> {
  try {
    return decode(await readHoldingRegisters(host, unitId, address, words, timeoutMs));
  } catch {
    return null;
  }
}
