/**
 * Die Stufen nach der Rechnung: Wer überstimmt wen?
 *
 * Jede Stufe einzeln und die Reihenfolge als Ganzes — damit eine künftige
 * Stufe (Zeitplan, Mindestladung) hier eingeordnet und nicht irgendwo in einem
 * Zyklus angeflanscht wird.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { begrenzeAufDose, uebersteuere, type Dosengrenzen, type Reglerwahl } from './ladeentscheidung.ts';
import type { Ladeentscheidung, Messwerte } from './ueberschuss.ts';

const DREIPHASIG: Dosengrenzen = { minA: 6, maxA: 16, anschluss: { phasen: 3, spannungV: 400 }, haushaltMaxA: 10 };
const HAUSHALT: Dosengrenzen = { minA: 6, maxA: 16, anschluss: { phasen: 1, spannungV: 230 }, haushaltMaxA: 10 };

const berechnet = (zielA: number, zustand: Ladeentscheidung['zustand'] = zielA > 0 ? 'laedt' : 'pausiert-leistung'): Ladeentscheidung => ({
  zustand, zielA, zielLeistungW: zielA * 690, verfuegbarW: zielA * 690, hausOhneAutoW: 500, speicherbeitragW: 0, grund: 'Rechnung',
});

const messwerte = (angesteckt: boolean | null = true, erreichbar = true): Messwerte => ({
  pvW: 5000, hausMitAutoW: 500, netzbezugW: 0, netzeinspeisungW: 1000, evLeistungW: 0, evAngesteckt: angesteckt,
  evStromA: 6, speicher: [], messalterMs: 0, wallboxErreichbar: erreichbar,
});

const wahl = (w: Partial<Reglerwahl> = {}): Reglerwahl => ({
  betriebsart: 'intelligent', manuellA: 0, gestoppt: false, fordertNicht: false, ...w,
});

describe('begrenzeAufDose', () => {
  it('rundet und hält die Gerätegrenzen', () => {
    assert.equal(begrenzeAufDose(3, DREIPHASIG), 6);
    assert.equal(begrenzeAufDose(20, DREIPHASIG), 16);
    assert.equal(begrenzeAufDose(11.4, DREIPHASIG), 11);
  });
  it('kappt einphasig zusätzlich auf die Haushaltsgrenze', () => {
    assert.equal(begrenzeAufDose(16, HAUSHALT), 10);
    assert.equal(begrenzeAufDose(16, DREIPHASIG), 16);
  });
});

describe('uebersteuere — Reihenfolge der Stufen', () => {
  it('lässt eine Rechnung ohne Übersteuerung unverändert, mit Beobachtungszeit', () => {
    const u = uebersteuere(berechnet(12), messwerte(), wahl(), DREIPHASIG);
    assert.equal(u.entscheidung.zielA, 12);
    assert.equal(u.sofort, false);
    assert.equal(u.regelbar, true);
  });

  it('Fahrzeug fordert nicht → 0 A, aber nur wenn angesteckt', () => {
    assert.equal(uebersteuere(berechnet(12), messwerte(), wahl({ fordertNicht: true }), DREIPHASIG).entscheidung.zustand, 'fordert-nicht');
    const ohne = uebersteuere(berechnet(0, 'nicht-verbunden'), messwerte(false), wahl({ fordertNicht: true }), DREIPHASIG);
    assert.equal(ohne.entscheidung.zustand, 'nicht-verbunden');
    assert.equal(ohne.regelbar, false);
  });

  it('Handbetrieb überstimmt die Rechnung und wartet nicht', () => {
    const u = uebersteuere(berechnet(0), messwerte(), wahl({ betriebsart: 'manuell', manuellA: 14 }), DREIPHASIG);
    assert.equal(u.entscheidung.zustand, 'laedt');
    assert.equal(u.entscheidung.zielA, 14);
    assert.equal(u.sofort, true);
    assert.match(u.entscheidung.grund, /Handbetrieb/);
  });

  it('Handbetrieb an der Haushaltsdose wird gekappt und sagt es', () => {
    const u = uebersteuere(berechnet(0), messwerte(), wahl({ betriebsart: 'manuell', manuellA: 16 }), HAUSHALT);
    assert.equal(u.entscheidung.zielA, 10);
    assert.match(u.entscheidung.grund, /16 A gewünscht/);
  });

  it('Handbetrieb greift nicht bei unerreichbarer Wallbox', () => {
    const u = uebersteuere(berechnet(0, 'gestoert'), messwerte(true, false), wahl({ betriebsart: 'manuell', manuellA: 16 }), DREIPHASIG);
    assert.equal(u.entscheidung.zustand, 'gestoert');
  });

  it('ohne Wahl wird nicht geladen — auch nicht intelligent', () => {
    const u = uebersteuere(berechnet(12), messwerte(), wahl({ betriebsart: null }), DREIPHASIG);
    assert.equal(u.entscheidung.zustand, 'wahl-fehlt');
    assert.equal(u.entscheidung.zielA, 0);
    assert.equal(u.sofort, true);
  });

  it('Stopp überstimmt alles, auch den Handbetrieb', () => {
    const u = uebersteuere(berechnet(12), messwerte(), wahl({ betriebsart: 'manuell', manuellA: 16, gestoppt: true }), DREIPHASIG);
    assert.equal(u.entscheidung.zustand, 'gestoppt');
    assert.equal(u.entscheidung.zielA, 0);
    assert.equal(u.sofort, true);
  });

  it('die Dose setzt auch im intelligenten Betrieb die letzte Grenze', () => {
    const u = uebersteuere(berechnet(16), messwerte(), wahl(), HAUSHALT);
    assert.equal(u.entscheidung.zielA, 10);
    assert.match(u.entscheidung.grund, /Haushaltssteckdose höchstens 10 A/);
  });

  it('fehlende Messwerte schalten sofort ab', () => {
    const u = uebersteuere(berechnet(0, 'pausiert-messwerte'), messwerte(), wahl(), DREIPHASIG);
    assert.equal(u.sofort, true);
    assert.equal(u.regelbar, true);
  });
});
