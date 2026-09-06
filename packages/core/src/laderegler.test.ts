/**
 * Tests der Beruhigung.
 *
 * Hier geht es nicht um richtige Zahlen, sondern um ruhiges Verhalten: nicht
 * bei jedem Wölkchen einen Befehl an die Tuya-Cloud, nicht zwischen zwei
 * Amperewerten hin- und herspringen — aber sofort reagieren, wenn wirklich
 * Strom aus dem Netz fliesst.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  beruhige,
  neueHistorie,
  type Reglerhistorie,
  type Zeitparameter,
} from './laderegler.ts';

const ZEIT: Zeitparameter = {
  mindestabstandMs: 60_000,
  erhoehenNachMs: 90_000,
  senkenNachMs: 20_000,
  pausierenNachMs: 30_000,
  startenNachMs: 120_000,
  notbremseAbW: 300,
  netzTotzoneW: 150,
};

/** Lässt den Wunsch `wunschA` über `dauerMs` anliegen und regelt dabei. */
function laufe(
  start: Reglerhistorie,
  wunschA: number,
  netzbezugW: number,
  vonMs: number,
  bisMs: number,
  schrittMs = 10_000,
): { historie: Reglerhistorie; befehle: { tMs: number; a: number }[] } {
  let historie = start;
  const befehle: { tMs: number; a: number }[] = [];
  for (let t = vonMs; t <= bisMs; t += schrittMs) {
    const e = beruhige({ wunschA, netzbezugW, jetztMs: t, historie, zeit: ZEIT });
    historie = e.historie;
    if (e.senden) befehle.push({ tMs: t, a: e.stromA });
  }
  return { historie, befehle };
}

describe('Nichts tun, wenn nichts zu tun ist', () => {
  it('sendet keinen Befehl, wenn der Sollwert schon stimmt', () => {
    const e = beruhige({
      wunschA: 10,
      netzbezugW: 0,
      jetztMs: 1_000_000,
      historie: { gesetztA: 10, gesetztAtMs: 0, wunschA: 10, wunschSeitMs: 0 },
      zeit: ZEIT,
    });
    assert.equal(e.senden, false);
  });
});

describe('Erhöhen ist langsam, Senken ist schnell', () => {
  it('erhöht erst nach der langen Haltezeit', () => {
    const start: Reglerhistorie = { gesetztA: 8, gesetztAtMs: 0, wunschA: 8, wunschSeitMs: 0 };
    const { befehle } = laufe(start, 10, -800, 0, 80_000);
    assert.equal(befehle.length, 0, 'zu früh erhöht');

    const spaeter = laufe(start, 10, -800, 0, 200_000);
    assert.equal(spaeter.befehle.length, 1);
    assert.equal(spaeter.befehle[0]?.a, 10);
    assert.ok((spaeter.befehle[0]?.tMs ?? 0) >= 90_000);
  });

  it('senkt schon nach kurzer Beobachtung', () => {
    const start: Reglerhistorie = { gesetztA: 12, gesetztAtMs: 0, wunschA: 12, wunschSeitMs: 0 };
    // Netzbezug 200 W liegt unter der Notbremse, aber ausserhalb der Totzone.
    const { befehle } = laufe(start, 9, 200, 0, 60_000);
    assert.equal(befehle.length, 1);
    assert.equal(befehle[0]?.a, 9);
    assert.ok((befehle[0]?.tMs ?? 0) <= 30_000, 'Senken dauerte zu lange');
  });
});

describe('Notbremse', () => {
  it('senkt sofort, wenn wirklich Strom aus dem Netz kommt', () => {
    const start: Reglerhistorie = {
      gesetztA: 14,
      gesetztAtMs: 1_000_000,
      wunschA: 14,
      wunschSeitMs: 1_000_000,
    };
    const e = beruhige({
      wunschA: 8,
      netzbezugW: 900,
      jetztMs: 1_001_000, // eine Sekunde später - jede Frist wäre verletzt
      historie: start,
      zeit: ZEIT,
    });
    assert.equal(e.senden, true);
    assert.equal(e.stromA, 8);
    assert.match(e.grund, /Netzbezug/);
  });

  it('gilt nicht für das Erhöhen', () => {
    const start: Reglerhistorie = {
      gesetztA: 8,
      gesetztAtMs: 1_000_000,
      wunschA: 8,
      wunschSeitMs: 1_000_000,
    };
    const e = beruhige({
      wunschA: 12,
      netzbezugW: 900,
      jetztMs: 1_001_000,
      historie: start,
      zeit: ZEIT,
    });
    assert.equal(e.senden, false);
  });
});

describe('Totzone gegen das Pendeln', () => {
  it('sitzt eine Ein-Ampere-Änderung bei ruhigem Netz aus', () => {
    const start: Reglerhistorie = { gesetztA: 10, gesetztAtMs: 0, wunschA: 10, wunschSeitMs: 0 };
    const { befehle } = laufe(start, 11, 50, 0, 600_000);
    assert.equal(befehle.length, 0, 'hat trotz Totzone geregelt');
  });

  it('regelt sehr wohl, wenn die Abweichung grösser ist', () => {
    const start: Reglerhistorie = { gesetztA: 10, gesetztAtMs: 0, wunschA: 10, wunschSeitMs: 0 };
    const { befehle } = laufe(start, 13, 50, 0, 300_000);
    assert.equal(befehle.length, 1);
    assert.equal(befehle[0]?.a, 13);
  });

  it('regelt, sobald das Netz die Totzone verlässt', () => {
    const start: Reglerhistorie = { gesetztA: 10, gesetztAtMs: 0, wunschA: 10, wunschSeitMs: 0 };
    const { befehle } = laufe(start, 9, 250, 0, 120_000);
    assert.equal(befehle.length, 1);
  });
});

describe('Pause und Wiederanlauf', () => {
  it('pausiert erst nach der Pausenfrist', () => {
    const start: Reglerhistorie = { gesetztA: 8, gesetztAtMs: 0, wunschA: 8, wunschSeitMs: 0 };
    const kurz = laufe(start, 0, 0, 0, 20_000);
    assert.equal(kurz.befehle.length, 0);
    const lang = laufe(start, 0, 0, 0, 120_000);
    assert.equal(lang.befehle.length, 1);
    assert.equal(lang.befehle[0]?.a, 0);
  });

  it('startet nach einer Pause erst nach der langen Startfrist', () => {
    const start: Reglerhistorie = { gesetztA: 0, gesetztAtMs: 0, wunschA: 0, wunschSeitMs: 0 };
    const kurz = laufe(start, 10, -3000, 0, 100_000);
    assert.equal(kurz.befehle.length, 0, 'zu früh wieder gestartet');
    const lang = laufe(start, 10, -3000, 0, 200_000);
    assert.equal(lang.befehle.length, 1);
    assert.equal(lang.befehle[0]?.a, 10);
  });

  it('schützt gegen Start-Stopp-Flattern', () => {
    // Der Wunsch springt im Zehn-Sekunden-Takt zwischen Pause und 8 A. Genau
    // dabei darf die Regelung nicht anfangen, das Auto zu quälen.
    let historie = neueHistorie(8, 0);
    let befehle = 0;
    for (let t = 0; t < 600_000; t += 10_000) {
      const wunsch = (t / 10_000) % 2 === 0 ? 0 : 8;
      const e = beruhige({ wunschA: wunsch, netzbezugW: 0, jetztMs: t, historie, zeit: ZEIT });
      historie = e.historie;
      if (e.senden) befehle++;
    }
    assert.equal(befehle, 0, `hat ${befehle} Befehle gesendet`);
  });
});

describe('Mindestabstand zwischen Befehlen', () => {
  it('sendet nicht zweimal kurz hintereinander', () => {
    let historie = neueHistorie(6, 0);
    // Erster Befehl: erhöhen auf 10 nach langer Beobachtung.
    const erster = laufe(historie, 10, -5000, 0, 200_000);
    historie = erster.historie;
    assert.equal(erster.befehle.length, 1);
    const gesendetBei = erster.befehle[0]?.tMs ?? 0;

    // Sofort danach wäre 12 A möglich - der Mindestabstand hält dagegen.
    const zweiter = laufe(historie, 12, -8000, gesendetBei + 10_000, gesendetBei + 50_000);
    assert.equal(zweiter.befehle.length, 0);
  });
});
