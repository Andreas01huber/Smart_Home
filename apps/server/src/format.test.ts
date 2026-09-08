import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Testet die zentralen Frontend-Formatter direkt (Anforderung 58).
import {
  formatSoc,
  formatPercentage,
  formatPower,
  formatEnergy,
  formatCurrency,
  formatLadestrom,
  formatLadeleistung,
  dosenText,
  umsteckText,
} from '../public/format.js';

describe('formatSoc — SOC ohne unnötige Nachkommastellen (13/14)', () => {
  test('74 -> "74 %"', () => assert.equal(formatSoc(74), '74 %'));
  test('74.00000 -> "74 %"', () => assert.equal(formatSoc(74.0), '74 %'));
  test('73.986 -> "74 %"', () => assert.equal(formatSoc(73.986), '74 %'));
  test('97.69999694824219 -> "98 %"', () => assert.equal(formatSoc(97.69999694824219), '98 %'));
  test('null -> "—", nicht "NaN %"', () => assert.equal(formatSoc(null), '—'));
  test('undefined -> "—"', () => assert.equal(formatSoc(undefined), '—'));
});

describe('formatPower (16/17)', () => {
  test('unter 1 kW in Watt', () => assert.equal(formatPower(336), '336 W'));
  test('8420 -> "8,4 kW"', () => assert.equal(formatPower(8420), '8,4 kW'));
  test('keine Pseudogenauigkeit', () => assert.equal(formatPower(3183.742), '3,2 kW'));
  test('null -> "—"', () => assert.equal(formatPower(null), '—'));
});

describe('formatEnergy (16)', () => {
  test('42800 Wh -> "42,8 kWh"', () => assert.equal(formatEnergy(42800), '42,8 kWh'));
  test('1420000 Wh -> "1,42 MWh"', () => assert.equal(formatEnergy(1420000), '1,42 MWh'));
});

describe('formatCurrency (16)', () => {
  test('8.42 -> "8,42 €"', () => assert.equal(formatCurrency(8.42), '8,42 €'));
  test('null -> "—"', () => assert.equal(formatCurrency(null), '—'));
});

describe('formatPercentage (16)', () => {
  test('93 -> "93 %"', () => assert.equal(formatPercentage(93), '93 %'));
  test('89.66 -> "90 %"', () => assert.equal(formatPercentage(89.66), '90 %'));
});

describe('Wallbox: Einstellung und Messung auseinanderhalten', () => {
  test('zeigt die Einstellung im Verhaeltnis zur Geraetegrenze', () => {
    // Frueher stand hier "16 A ~ 11,1 kW" - eine aus 400 V gerechnete Zahl, die
    // der gemessenen Ladeleistung in der Nachbarkachel widersprach. Was ein
    // Ampere an dieser Anlage wirklich bedeutet, steht jetzt gemessen daneben.
    assert.equal(formatLadestrom({ maxCurrentA: 15, regelung: { maxA: 16 } }), '15 A von 16 A');
    assert.equal(formatLadestrom({ maxCurrentA: 6, regelung: { maxA: 16 } }), '6 A von 16 A');
  });

  test('zeigt die Ampere allein, wenn die Geraetegrenze fehlt', () => {
    assert.equal(formatLadestrom({ maxCurrentA: 10 }), '10 A');
  });

  test('erfindet nichts, wenn nichts bekannt ist', () => {
    assert.equal(formatLadestrom({ maxCurrentA: null }), '—');
    assert.equal(formatLadestrom(null), '—');
    assert.equal(formatLadeleistung(null), '—');
    assert.equal(formatLadeleistung({ powerW: null }), '—');
  });

  test('zeigt bei der Ladeleistung nur die Messung', () => {
    // Der zurueckgerechnete Ampere-Wert ist hier absichtlich weg: Er stammte
    // aus derselben 400-V-Annahme und machte aus einer Messung eine Mischung.
    assert.equal(formatLadeleistung({ powerW: 10_084, currentFromPowerA: 14.6 }), '10,1 kW');
    assert.equal(formatLadeleistung({ powerW: 3700 }), '3,7 kW');
  });
});

describe('Hinweise rund um die Ladedose', () => {
  const starkstrom = { phasen: 3, name: 'Starkstromdose', wattProAmpere: 672 };
  const haushalt = { phasen: 1, name: 'Haushaltssteckdose', wattProAmpere: 230 };

  test('meldet die Haushaltssteckdose, die Starkstromdose nicht', () => {
    // An der Haushaltsdose bedeuten dieselben Ampere ein Drittel der Leistung.
    // Ohne diesen Satz wundert man sich, warum "10 A" plötzlich 2,3 statt
    // 6,9 kW sind.
    assert.match(dosenText({ anschluss: haushalt }), /Haushaltssteckdose/);
    assert.match(dosenText({ anschluss: haushalt }), /230 W/);
    assert.equal(dosenText({ anschluss: starkstrom }), '');
    assert.equal(dosenText(null), '');
  });

  test('rät abends zum Umstecken, wenn es dort noch reichen würde', () => {
    // Der Abendfall: Sonne weg, Speicher geben keine 4,2 kW mehr her. Für
    // 6 A dreiphasig zu wenig — an der Haushaltsdose wären es 10 A.
    const text = umsteckText({
      betriebsart: 'intelligent',
      zustand: 'pausiert-leistung',
      verfuegbarW: 2400,
      minA: 6,
      maxA: 16,
      anschluss: starkstrom,
    });
    assert.match(text, /Haushaltssteckdose/);
    assert.match(text, /10 A/);
    assert.match(text, /umstecken/);
  });

  test('schweigt, wenn auch die Haushaltsdose nicht reichen würde', () => {
    // Unter 1380 W (6 A an 230 V) hilft auch das Umstecken nichts. Dann wäre
    // der Rat schlicht falsch.
    assert.equal(
      umsteckText({
        betriebsart: 'intelligent',
        zustand: 'pausiert-leistung',
        verfuegbarW: 900,
        minA: 6,
        anschluss: starkstrom,
      }),
      '',
    );
  });

  test('schweigt im Handbetrieb', () => {
    // Dort ist Netzbezug gewollt, und es wird gar nicht abgebrochen.
    assert.equal(
      umsteckText({
        betriebsart: 'manuell',
        zustand: 'pausiert-leistung',
        verfuegbarW: 2400,
        minA: 6,
        anschluss: starkstrom,
      }),
      '',
    );
  });

  test('schweigt, solange geladen wird', () => {
    assert.equal(
      umsteckText({
        betriebsart: 'intelligent',
        zustand: 'laedt',
        verfuegbarW: 2400,
        minA: 6,
        anschluss: starkstrom,
      }),
      '',
    );
  });

  test('schweigt, wenn ohnehin schon einphasig geladen wird', () => {
    // Dann steckt es bereits dort, wo der Rat hinführen würde.
    assert.equal(
      umsteckText({
        betriebsart: 'intelligent',
        zustand: 'pausiert-leistung',
        verfuegbarW: 2400,
        minA: 6,
        anschluss: haushalt,
      }),
      '',
    );
  });
});
