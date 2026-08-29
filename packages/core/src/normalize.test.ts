import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitGridPower,
  splitBatteryPower,
  normalizeHouseConsumption,
  storedEnergyWh,
} from './normalize.ts';

describe('splitGridPower — Fronius P_Grid: "+ from grid, - to grid"', () => {
  test('positiver Wert wird zu Netzbezug', () => {
    assert.deepEqual(splitGridPower(2000, 'positiveIsImport'), {
      importW: 2000,
      exportW: 0,
    });
  });

  test('negativer Wert wird zu Einspeisung, nicht zu negativem Bezug', () => {
    assert.deepEqual(splitGridPower(-2300, 'positiveIsImport'), {
      importW: 0,
      exportW: 2300,
    });
  });

  test('umgekehrte Konvention dreht die Zuordnung', () => {
    assert.deepEqual(splitGridPower(2000, 'positiveIsExport'), {
      importW: 0,
      exportW: 2000,
    });
  });

  test('null bleibt null — "kein Smart Meter" ist nicht 0 W', () => {
    assert.deepEqual(splitGridPower(null, 'positiveIsImport'), {
      importW: null,
      exportW: null,
    });
  });

  test('NaN wird nicht als Zahl durchgereicht', () => {
    assert.deepEqual(splitGridPower(Number.NaN, 'positiveIsImport'), {
      importW: null,
      exportW: null,
    });
  });
});

describe('splitBatteryPower — Fronius P_Akku: "- charge, + discharge"', () => {
  test('negativer P_Akku bedeutet Laden', () => {
    const result = splitBatteryPower(-2900, 'positiveIsDischarge');
    assert.equal(result.chargeW, 2900);
    assert.equal(result.dischargeW, 0);
    assert.equal(result.state, 'charging');
  });

  test('positiver P_Akku bedeutet Entladen', () => {
    const result = splitBatteryPower(3400, 'positiveIsDischarge');
    assert.equal(result.chargeW, 0);
    assert.equal(result.dischargeW, 3400);
    assert.equal(result.state, 'discharging');
  });

  test('Fronius Current_DC nutzt die umgekehrte Konvention', () => {
    const result = splitBatteryPower(1700, 'positiveIsCharge');
    assert.equal(result.chargeW, 1700);
    assert.equal(result.state, 'charging');
  });

  test('nahe null gilt als idle', () => {
    assert.equal(splitBatteryPower(0.4, 'positiveIsCharge').state, 'idle');
  });

  test('fehlender Wert ergibt unknown, nicht idle', () => {
    assert.equal(splitBatteryPower(null, 'positiveIsCharge').state, 'unknown');
  });
});

describe('normalizeHouseConsumption — Fronius P_Load: "+ generator, - consumer"', () => {
  test('negativer P_Load ist positiver Hausverbrauch', () => {
    assert.equal(normalizeHouseConsumption(-3800, 'negativeIsConsumption'), 3800);
  });

  test('Verbrauch wird nie negativ ausgegeben', () => {
    assert.equal(normalizeHouseConsumption(500, 'negativeIsConsumption'), 0);
  });

  test('null bleibt null', () => {
    assert.equal(normalizeHouseConsumption(null, 'negativeIsConsumption'), null);
  });
});

describe('storedEnergyWh', () => {
  test('rechnet SOC und Kapazität korrekt um', () => {
    assert.equal(storedEnergyWh(73, 50_000), 36_500);
  });

  test('begrenzt SOC auf 0..100', () => {
    assert.equal(storedEnergyWh(120, 50_000), 50_000);
    assert.equal(storedEnergyWh(-5, 50_000), 0);
  });

  test('ohne Kapazität kein Ergebnis', () => {
    assert.equal(storedEnergyWh(73, null), null);
  });
});
