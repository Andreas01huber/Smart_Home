/**
 * Minimaler Modbus-TCP-Client, nur lesend (Funktionscode 3).
 *
 * Bewusst ohne Fremdbibliothek: Es wird genau ein Funktionscode benötigt,
 * und die Abhängigkeit wäre grösser als der Code.
 */

import { Socket } from 'node:net';

export const MODBUS_TCP_PORT = 502;

/**
 * Systemweiter Dienst com.victronenergy.system.
 * Laut offiziellem GX Modbus-TCP Manual gegenüber Unit-ID 0 zu bevorzugen.
 */
export const VICTRON_SYSTEM_UNIT_ID = 100;

export function readHoldingRegisters(
  host: string,
  unitId: number,
  startAddress: number,
  wordCount: number,
  timeoutMs = 3000,
  port = MODBUS_TCP_PORT,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const request = Buffer.alloc(12);
    request.writeUInt16BE(1, 0); // Transaction ID
    request.writeUInt16BE(0, 2); // Protocol ID (0 = Modbus)
    request.writeUInt16BE(6, 4); // Länge der folgenden Bytes
    request.writeUInt8(unitId, 6);
    request.writeUInt8(3, 7); // FC 3: Read Holding Registers
    request.writeUInt16BE(startAddress, 8);
    request.writeUInt16BE(wordCount, 10);

    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const succeed = (value: Buffer): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fail(new Error('Modbus-Zeitüberschreitung')));
    socket.once('error', fail);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 9) return;
      const declaredLength = buffer.readUInt16BE(4);
      if (buffer.length < 6 + declaredLength) return;

      const functionCode = buffer.readUInt8(7);
      if ((functionCode & 0x80) !== 0) {
        fail(new Error(`Modbus-Exception ${buffer.readUInt8(8)}`));
        return;
      }
      succeed(buffer.subarray(9, 9 + buffer.readUInt8(8)));
    });

    socket.connect(port, host, () => socket.write(request));
  });
}
