/**
 * Modbus-Client gegen einen lokalen Fake-TCP-Server.
 *
 * Jeder Fall stammt aus dem Review: Eine unvollständige oder falsche Antwort
 * darf keinen Messzyklus hängen lassen und nie als gültige Daten durchgehen.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';

import { readHoldingRegisters } from './modbus-client.ts';

type Antwort = (anfrage: Buffer, socket: Socket) => void;

async function mitServer(antwort: Antwort, test: (port: number) => Promise<void>): Promise<void> {
  const offen = new Set<Socket>();
  const server: Server = createServer((socket) => {
    offen.add(socket);
    socket.on('close', () => offen.delete(socket));
    socket.once('data', (anfrage) => antwort(anfrage, socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((fertig) => server.listen(0, '127.0.0.1', fertig));
  const port = (server.address() as { port: number }).port;
  try {
    await test(port);
  } finally {
    for (const s of offen) s.destroy();
    await new Promise<void>((fertig) => server.close(() => fertig()));
  }
}

/** Eine gültige Antwort auf die Anfrage, mit den Werten `werte`. */
function gueltig(anfrage: Buffer, werte: number[], aenderung: Partial<{ tx: number; proto: number; unit: number; fc: number; bytes: number }> = {}): Buffer {
  const daten = Buffer.alloc(werte.length * 2);
  werte.forEach((w, i) => daten.writeUInt16BE(w, i * 2));
  const kopf = Buffer.alloc(9);
  kopf.writeUInt16BE(aenderung.tx ?? anfrage.readUInt16BE(0), 0);
  kopf.writeUInt16BE(aenderung.proto ?? 0, 2);
  kopf.writeUInt16BE(3 + daten.length, 4);
  kopf.writeUInt8(aenderung.unit ?? anfrage.readUInt8(6), 6);
  kopf.writeUInt8(aenderung.fc ?? 3, 7);
  kopf.writeUInt8(aenderung.bytes ?? daten.length, 8);
  return Buffer.concat([kopf, daten]);
}

const lies = (port: number, opt: { timeoutMs?: number; deadlineMs?: number } = {}) =>
  readHoldingRegisters('127.0.0.1', 100, 820, 2, opt.timeoutMs ?? 500, port, { deadlineMs: opt.deadlineMs ?? 1000 });

describe('Modbus-Client', () => {
  it('liest eine gültige Antwort', async () => {
    await mitServer((a, s) => s.write(gueltig(a, [0x1234, 0xabcd])), async (port) => {
      const b = await lies(port);
      assert.equal(b.readUInt16BE(0), 0x1234);
      assert.equal(b.readUInt16BE(2), 0xabcd);
    });
  });

  it('setzt fragmentierte gültige Frames zusammen', async () => {
    await mitServer((a, s) => {
      const f = gueltig(a, [7, 8]);
      s.write(f.subarray(0, 3));
      setTimeout(() => s.write(f.subarray(3, 8)), 20);
      setTimeout(() => s.write(f.subarray(8)), 40);
    }, async (port) => {
      const b = await lies(port);
      assert.equal(b.readUInt16BE(2), 8);
    });
  });

  for (const [name, aenderung] of [
    ['falsche Transaktions-ID', { tx: 999 }],
    ['falsche Protokoll-ID', { proto: 1 }],
    ['falsche Unit-ID', { unit: 7 }],
    ['falscher Funktionscode', { fc: 4 }],
    ['falsche Bytezahl', { bytes: 2 }],
  ] as const) {
    it(`lehnt ab: ${name}`, async () => {
      await mitServer((a, s) => s.write(gueltig(a, [1, 2], aenderung)), async (port) => {
        await assert.rejects(lies(port), /Modbus/);
      });
    });
  }

  it('meldet eine Modbus-Exception', async () => {
    await mitServer((a, s) => {
      const f = Buffer.alloc(9);
      f.writeUInt16BE(a.readUInt16BE(0), 0);
      f.writeUInt16BE(0, 2);
      f.writeUInt16BE(3, 4);
      f.writeUInt8(a.readUInt8(6), 6);
      f.writeUInt8(0x83, 7);
      f.writeUInt8(2, 8);
      s.write(f);
    }, async (port) => {
      await assert.rejects(lies(port), /Exception 2/);
    });
  });

  it('beendet die Zusage bei vorzeitigem Verbindungsende', async () => {
    await mitServer((a, s) => s.end(gueltig(a, [1, 2]).subarray(0, 6)), async (port) => {
      await assert.rejects(lies(port), /Verbindung/);
    });
  });

  it('lehnt eine überlange Antwort ab', async () => {
    await mitServer((a, s) => s.write(Buffer.alloc(600, 1)), async (port) => {
      await assert.rejects(lies(port), /Modbus/);
    });
  });

  it('eine Tropfantwort hält die Abfrage nicht über die absolute Frist offen', async () => {
    // Alle 100 ms ein Byte: Die Stille-Grenze von 500 ms greift nie. Früher
    // hing die Abfrage damit beliebig lange.
    await mitServer((a, s) => {
      const f = gueltig(a, [1, 2]);
      let i = 0;
      const t = setInterval(() => {
        if (i >= f.length - 1 || s.destroyed) { clearInterval(t); return; }
        s.write(f.subarray(i, i + 1));
        i += 1;
      }, 100);
      s.on('close', () => clearInterval(t));
    }, async (port) => {
      const start = Date.now();
      await assert.rejects(lies(port, { timeoutMs: 500, deadlineMs: 600 }), /Frist/);
      assert.ok(Date.now() - start < 1500, 'Frist nicht eingehalten');
    });
  });

  it('bricht über ein Signal ab und räumt auf', async () => {
    await mitServer(() => undefined, async (port) => {
      const abbruch = new AbortController();
      const p = readHoldingRegisters('127.0.0.1', 100, 820, 2, 5000, port, { deadlineMs: 5000, signal: abbruch.signal });
      setTimeout(() => abbruch.abort(), 50);
      await assert.rejects(p, /abgebrochen/);
    });
  });

  it('lehnt unzulässige Registerzahlen ab, ohne zu verbinden', async () => {
    await assert.rejects(readHoldingRegisters('127.0.0.1', 1, 0, 200), /Registerzahl/);
  });
});
