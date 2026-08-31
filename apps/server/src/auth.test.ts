import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clearCookie,
  hashPassword,
  herkunftVon,
  istHttps,
  LoginThrottle,
  parseCookies,
  sessionCookie,
  SESSION_TTL_MS,
  sicheresZiel,
  verifyPassword,
} from './auth.ts';

describe('Passwort', () => {
  it('erkennt das richtige Passwort wieder', () => {
    const hash = hashPassword('korrektes-pferd-batterie');
    assert.equal(verifyPassword('korrektes-pferd-batterie', hash), true);
  });

  it('lehnt ein falsches Passwort ab', () => {
    const hash = hashPassword('korrektes-pferd-batterie');
    assert.equal(verifyPassword('korrektes-pferd-batterei', hash), false);
  });

  it('speichert das Passwort nirgends im Klartext', () => {
    const hash = hashPassword('geheimnis-123456');
    assert.equal(hash.includes('geheimnis'), false);
  });

  it('erzeugt für dasselbe Passwort zwei verschiedene Hashes', () => {
    // Unterschiedliches Salz. Sonst verriete ein Blick in zwei Anlagen, dass
    // dort dasselbe Passwort benutzt wird.
    assert.notEqual(hashPassword('gleiches-passwort'), hashPassword('gleiches-passwort'));
  });

  it('stürzt bei kaputtem gespeichertem Hash nicht ab, sondern sagt nein', () => {
    for (const kaputt of ['', 'unsinn', 'scrypt$nur-ein-teil', 'md5$a$b', 'scrypt$$']) {
      assert.equal(verifyPassword('egal', kaputt), false, kaputt);
    }
  });
});

describe('Keks', () => {
  it('ist für Skripte unsichtbar und lange gültig', () => {
    const keks = sessionCookie('tok', false);
    assert.match(keks, /HttpOnly/);
    assert.match(keks, /SameSite=Lax/);
    assert.match(keks, new RegExp(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`));
  });

  it('setzt Secure nur bei HTTPS', () => {
    // Im Heimnetz läuft die App über http://…:4173. Ein Secure-Keks käme dort
    // nie an, und niemand könnte sich anmelden.
    assert.equal(sessionCookie('tok', false).includes('Secure'), false);
    assert.equal(sessionCookie('tok', true).includes('Secure'), true);
  });

  it('löscht mit Max-Age=0', () => {
    assert.match(clearCookie(false), /Max-Age=0/);
  });

  it('liest Kekse aus dem Kopf', () => {
    const k = parseCookies('a=1; sh_session=xy.z; leer');
    assert.equal(k['a'], '1');
    assert.equal(k['sh_session'], 'xy.z');
    assert.equal(Object.keys(k).length, 2);
  });

  it('kommt ohne Keks-Kopf zurecht', () => {
    assert.deepEqual(parseCookies(undefined), {});
  });
});

describe('Ziel nach der Anmeldung', () => {
  it('lässt eigene Pfade durch', () => {
    assert.equal(sicheresZiel('/verlauf'), '/verlauf');
    assert.equal(sicheresZiel('/kosten?monat=8'), '/kosten?monat=8');
  });

  it('wehrt Weiterleitungen auf fremde Adressen ab', () => {
    // Ohne diese Prüfung wäre ein Link auf die eigene Anmeldeseite ein Weg,
    // jemanden unbemerkt woanders hin zu schicken.
    for (const boese of ['//boese.example', 'https://boese.example', 'javascript:alert(1)']) {
      assert.equal(sicheresZiel(boese), '/', boese);
    }
  });

  it('schickt nicht auf die Anmeldeseite zurück', () => {
    assert.equal(sicheresZiel('/login'), '/');
    assert.equal(sicheresZiel(undefined), '/');
  });
});

describe('Bremse gegen Durchprobieren', () => {
  it('lässt die ersten Versuche durch', () => {
    const b = new LoginThrottle();
    for (let i = 0; i < 5; i++) b.fehlversuch('1.2.3.4');
    assert.equal(b.gesperrtFuer('1.2.3.4'), 0);
  });

  it('sperrt nach zu vielen Fehlversuchen', () => {
    const b = new LoginThrottle();
    for (let i = 0; i < 6; i++) b.fehlversuch('1.2.3.4');
    assert.ok(b.gesperrtFuer('1.2.3.4') > 0);
  });

  it('verlängert die Sperre mit jedem weiteren Versuch', () => {
    const b = new LoginThrottle();
    const jetzt = Date.now();
    for (let i = 0; i < 6; i++) b.fehlversuch('1.2.3.4', jetzt);
    const erste = b.gesperrtFuer('1.2.3.4', jetzt);
    b.fehlversuch('1.2.3.4', jetzt);
    assert.ok(b.gesperrtFuer('1.2.3.4', jetzt) > erste);
  });

  it('sperrt höchstens eine Viertelstunde', () => {
    const b = new LoginThrottle();
    const jetzt = Date.now();
    for (let i = 0; i < 40; i++) b.fehlversuch('1.2.3.4', jetzt);
    assert.ok(b.gesperrtFuer('1.2.3.4', jetzt) <= 15 * 60_000);
  });

  it('vergisst die Fehlversuche nach erfolgreicher Anmeldung', () => {
    const b = new LoginThrottle();
    for (let i = 0; i < 8; i++) b.fehlversuch('1.2.3.4');
    b.erfolg('1.2.3.4');
    assert.equal(b.gesperrtFuer('1.2.3.4'), 0);
  });

  it('sperrt nur die betroffene Herkunft', () => {
    const b = new LoginThrottle();
    for (let i = 0; i < 8; i++) b.fehlversuch('1.2.3.4');
    assert.equal(b.gesperrtFuer('5.6.7.8'), 0);
  });
});

describe('Herkunft und Protokoll hinter dem Tunnel', () => {
  it('nimmt die Cloudflare-Adresse, nicht die des Tunnels', () => {
    // Sonst hätten alle Anfragen aus dem Internet dieselbe Herkunft, und ein
    // einziger Angreifer würde damit alle anderen aussperren.
    const h = herkunftVon({ 'cf-connecting-ip': '9.9.9.9' }, '127.0.0.1');
    assert.equal(h, '9.9.9.9');
  });

  it('nimmt sonst den ersten Eintrag aus X-Forwarded-For', () => {
    assert.equal(herkunftVon({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, '127.0.0.1'), '9.9.9.9');
  });

  it('fällt auf die Verbindungsadresse zurück', () => {
    assert.equal(herkunftVon({}, '192.168.178.50'), '192.168.178.50');
  });

  it('erkennt HTTPS nur am Kopf des Tunnels', () => {
    assert.equal(istHttps({ 'x-forwarded-proto': 'https' }), true);
    assert.equal(istHttps({ 'x-forwarded-proto': 'https,http' }), true);
    assert.equal(istHttps({ 'x-forwarded-proto': 'http' }), false);
    assert.equal(istHttps({}), false);
  });
});
