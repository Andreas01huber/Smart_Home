/**
 * Minimaler Modbus-TCP-Client, nur lesend (Funktionscode 3).
 *
 * Bewusst ohne Fremdbibliothek: Es wird genau ein Funktionscode benötigt,
 * und die Abhängigkeit wäre grösser als der Code.
 *
 * ── Warum so viele Prüfungen ────────────────────────────────────────────────
 * Die erste Fassung nahm die erste halbwegs passende Antwort: ohne Blick auf
 * Transaktions-ID, Unit-ID oder Bytezahl, ohne Obergrenze, und ohne absolute
 * Frist. `socket.setTimeout` misst nur Stille — ein Gerät, das alle zwei
 * Sekunden ein einzelnes Byte schickt, hielt die Abfrage beliebig lange offen.
 * Und schloss es die Verbindung mit einer halben Antwort, blieb die Zusage für
 * immer offen, und mit ihr der ganze Messzyklus.
 *
 * Jetzt gilt: Jede Antwort muss in allen Kopffeldern zur Anfrage passen, die
 * Länge ist begrenzt, ein vorzeitiges Ende ist ein Fehler, und nach
 * `deadlineMs` ist in jedem Fall Schluss. Socket und Zeitgeber werden auf jedem
 * Weg aufgeräumt.
 */

import { Socket } from 'node:net';

export const MODBUS_TCP_PORT = 502;

/**
 * Systemweiter Dienst com.victronenergy.system.
 * Laut offiziellem GX Modbus-TCP Manual gegenüber Unit-ID 0 zu bevorzugen.
 */
export const VICTRON_SYSTEM_UNIT_ID = 100;

/** Laut Modbus-Spezifikation höchstens 125 Register je Lesebefehl. */
const MAX_REGISTER = 125;
/** MBAP-Kopf (7) + Funktionscode (1) + Bytezahl (1) + 250 Datenbytes. */
const MAX_ANTWORT_BYTES = 7 + 2 + MAX_REGISTER * 2;

let naechsteTransaktion = 1;

export interface ModbusOptionen {
  /** Stille-Grenze zwischen zwei Datenstücken. */
  readonly timeoutMs?: number;
  /** Absolute Frist für die ganze Abfrage, Verbindungsaufbau eingeschlossen. */
  readonly deadlineMs?: number;
  readonly port?: number;
  /** Bricht die Abfrage von aussen ab. */
  readonly signal?: AbortSignal;
}

export function readHoldingRegisters(
  host: string,
  unitId: number,
  startAddress: number,
  wordCount: number,
  timeoutMs = 3000,
  port = MODBUS_TCP_PORT,
  optionen: Omit<ModbusOptionen, 'timeoutMs' | 'port'> = {},
): Promise<Buffer> {
  if (!Number.isInteger(wordCount) || wordCount < 1 || wordCount > MAX_REGISTER) {
    return Promise.reject(new Error(`Modbus: ungültige Registerzahl ${wordCount}`));
  }
  const deadlineMs = optionen.deadlineMs ?? timeoutMs * 2;
  const transaktion = naechsteTransaktion;
  naechsteTransaktion = (naechsteTransaktion % 0xffff) + 1;

  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const request = Buffer.alloc(12);
    request.writeUInt16BE(transaktion, 0);
    request.writeUInt16BE(0, 2); // Protokoll-ID: Modbus
    request.writeUInt16BE(6, 4); // Länge der folgenden Bytes
    request.writeUInt8(unitId, 6);
    request.writeUInt8(3, 7); // FC 3: Read Holding Registers
    request.writeUInt16BE(startAddress, 8);
    request.writeUInt16BE(wordCount, 10);

    let buffer = Buffer.alloc(0);
    let settled = false;
    const frist = setTimeout(() => fail(new Error('Modbus-Frist überschritten')), deadlineMs);
    const abbrechen = (): void => fail(new Error('Modbus-Abfrage abgebrochen'));

    function aufraeumen(): void {
      clearTimeout(frist);
      optionen.signal?.removeEventListener('abort', abbrechen);
      socket.removeAllListeners('data');
      socket.destroy();
    }
    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      aufraeumen();
      reject(error);
    }
    function succeed(value: Buffer): void {
      if (settled) return;
      settled = true;
      aufraeumen();
      resolve(value);
    }

    if (optionen.signal?.aborted) {
      abbrechen();
      return;
    }
    optionen.signal?.addEventListener('abort', abbrechen, { once: true });

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fail(new Error('Modbus-Zeitüberschreitung')));
    socket.once('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
    // Verbindung beendet, bevor die Antwort vollständig war.
    socket.once('end', () => fail(new Error('Modbus: Verbindung vor vollständiger Antwort beendet')));
    socket.once('close', () => fail(new Error('Modbus: Verbindung geschlossen')));

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_ANTWORT_BYTES) {
        fail(new Error('Modbus: Antwort länger als zulässig'));
        return;
      }
      if (buffer.length < 7) return;
      const deklariert = buffer.readUInt16BE(4);
      // Mindestens Unit-ID + Funktionscode + ein Byte; höchstens Maximum.
      if (deklariert < 3 || 6 + deklariert > MAX_ANTWORT_BYTES) {
        fail(new Error(`Modbus: unplausible Längenangabe ${deklariert}`));
        return;
      }
      if (buffer.length < 6 + deklariert) return;
      if (buffer.length > 6 + deklariert) {
        fail(new Error('Modbus: überzählige Bytes nach der Antwort'));
        return;
      }

      if (buffer.readUInt16BE(0) !== transaktion) {
        fail(new Error('Modbus: Transaktions-ID passt nicht zur Anfrage'));
        return;
      }
      if (buffer.readUInt16BE(2) !== 0) {
        fail(new Error('Modbus: falsche Protokoll-ID'));
        return;
      }
      if (buffer.readUInt8(6) !== unitId) {
        fail(new Error('Modbus: Unit-ID passt nicht zur Anfrage'));
        return;
      }
      const funktion = buffer.readUInt8(7);
      if (funktion === (0x80 | 3)) {
        fail(new Error(`Modbus-Exception ${buffer.readUInt8(8)}`));
        return;
      }
      if (funktion !== 3) {
        fail(new Error(`Modbus: unerwarteter Funktionscode ${funktion}`));
        return;
      }
      const bytezahl = buffer.readUInt8(8);
      if (bytezahl !== wordCount * 2 || deklariert !== 3 + bytezahl) {
        fail(new Error(`Modbus: ${bytezahl} Datenbytes statt ${wordCount * 2}`));
        return;
      }
      succeed(Buffer.from(buffer.subarray(9, 9 + bytezahl)));
    });

    socket.connect(port, host, () => socket.write(request));
  });
}
