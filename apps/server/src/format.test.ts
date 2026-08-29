import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Testet die zentralen Frontend-Formatter direkt (Anforderung 58).
import {
  formatSoc,
  formatPercentage,
  formatPower,
  formatEnergy,
  formatCurrency,
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
