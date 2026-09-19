import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyTotals,
  autarkyPercent,
  selfConsumptionPercent,
  consumptionSources,
  productionSinks,
  computeCosts,
  coverage,
  pruefeTotals,
  quoten,
  speicherGesamt,
  zuordneIntervall,
  type EnergyTotals,
  type Zuordnung,
} from './accounting.ts';

function totals(partial: Partial<EnergyTotals>): EnergyTotals {
  return { ...emptyTotals(), ...partial };
}

/** Ein Tag aus der Zeit vor Abdeckung und Zuordnung. */
function altbestand(partial: Partial<EnergyTotals>): EnergyTotals {
  const t = { ...emptyTotals(), ...partial } as Record<string, unknown>;
  delete t['coveredSeconds'];
  delete t['abdeckungJeGroesseS'];
  delete t['erfasstAbMs'];
  delete t['zuordnung'];
  return t as unknown as EnergyTotals;
}

const summeHaus = (z: Zuordnung): number => z.hausAusPvWh + z.hausAusSpeicherWh + z.hausAusNetzWh;

describe('autarkyPercent', () => {
  test('1 - Netzbezug / Verbrauch', () => {
    const t = totals({ houseConsumptionWh: 10000, gridImportWh: 2000 });
    assert.equal(autarkyPercent(t), 80);
  });
  test('ohne Verbrauch kein Wert', () => {
    assert.equal(autarkyPercent(emptyTotals()), null);
  });
});

describe('coverage — fester Nenner', () => {
  test('Anteil der gemessenen Zeit am Zeitraum', () => {
    const c = coverage(totals({ coveredSeconds: 18 * 3600 }), 24 * 3600);
    assert.equal(c.bekannt, true);
    assert.equal(c.percent, 75);
    assert.equal(c.gapSeconds, 6 * 3600);
  });

  test('ein Sommerzeit-Tag hat 23 Stunden, nicht 24', () => {
    const c = coverage(totals({ coveredSeconds: 23 * 3600 }), 23 * 3600);
    assert.equal(c.percent, 100);
  });

  test('ohne Zeitraum wird nichts behauptet', () => {
    assert.equal(coverage(emptyTotals(), 0).percent, null);
  });

  test('Altbestand ohne Abdeckungsdaten heisst "unbekannt", nicht 0 oder 100 %', () => {
    const c = coverage(altbestand({ houseConsumptionWh: 5000 }), 24 * 3600);
    assert.equal(c.bekannt, false);
    assert.equal(c.percent, null);
  });
});

describe('quoten — nur bei vergleichbarer Abdeckung', () => {
  test('gleich lang gemessen: Quote steht', () => {
    const q = quoten(totals({
      houseConsumptionWh: 10000, gridImportWh: 2000,
      abdeckungJeGroesseS: { pv: 3600, haus: 3600, bezug: 3600, einspeisung: 3600 },
    }));
    assert.equal(q.autarkie.percent, 80);
    assert.equal(q.autarkie.status, 'vergleichbar');
  });

  test('Netzzähler eine Stunde länger ausgefallen: Autarkie wird unterdrückt', () => {
    // Fehlt dem Netzbezug eine Stunde, die dem Hausverbrauch nicht fehlt,
    // wäre die Autarkie zu hoch — nicht unscharf, sondern falsch.
    const q = quoten(totals({
      houseConsumptionWh: 10000, gridImportWh: 1500,
      abdeckungJeGroesseS: { pv: 7200, haus: 7200, bezug: 3600, einspeisung: 7200 },
    }));
    assert.equal(q.autarkie.percent, null);
    assert.equal(q.autarkie.status, 'unvollstaendig');
    assert.equal(q.eigenverbrauch.status, 'vergleichbar');
  });
});

describe('selfConsumptionPercent', () => {
  test('1 - Einspeisung / Erzeugung', () => {
    const t = totals({ productionWh: 20000, gridExportWh: 5000 });
    assert.equal(selfConsumptionPercent(t), 75);
  });
});

describe('zuordneIntervall — Herkunft als Modell', () => {
  test('Netzladung erzeugt keinen erfundenen PV-Anteil — der Fall aus dem Review', () => {
    // PV 0, Haus 1000, Netz 5000, Speicher lädt 4000. Früher: 4000 Wh "PV in
    // den Speicher" und 5000 Wh Netzstrom fürs Haus bei 1000 Wh Verbrauch.
    const z = zuordneIntervall({ pv: 0, haus: 1000, bezug: 5000, einspeisung: 0, laden: 4000, entladen: 0 });
    assert.equal(z.speicherAusPvWh, 0);
    assert.equal(z.hausAusPvWh, 0);
    assert.equal(z.hausAusNetzWh, 1000);
    assert.equal(z.speicherAusNetzWh, 4000);
    assert.equal(z.nichtZuordenbarWh, 0);
  });

  test('keine Senke und keine Quelle bekommt mehr, als gemessen wurde', () => {
    const faelle = [
      { pv: 5000, haus: 1200, bezug: 0, einspeisung: 1800, laden: 2000, entladen: 0 },
      { pv: 0, haus: 800, bezug: 0, einspeisung: 0, laden: 1500, entladen: 2300 },
      { pv: 200, haus: 500, bezug: 0, einspeisung: 1700, laden: 0, entladen: 2000 },
      { pv: 3000, haus: 1000, bezug: 400, einspeisung: 0, laden: 0, entladen: 0 },
    ];
    const eps = 1e-9;
    for (const e of faelle) {
      const z = zuordneIntervall(e);
      assert.ok(summeHaus(z) <= e.haus + eps, JSON.stringify(e));
      assert.ok(z.speicherAusPvWh + z.speicherAusNetzWh + z.speicherAusSpeicherWh <= e.laden + eps);
      assert.ok(z.netzAusPvWh + z.netzAusSpeicherWh <= e.einspeisung + eps);
      assert.ok(z.hausAusPvWh + z.speicherAusPvWh + z.netzAusPvWh <= e.pv + eps);
      assert.ok(z.hausAusSpeicherWh + z.netzAusSpeicherWh + z.speicherAusSpeicherWh <= e.entladen + eps);
      // Quellen = zugeordnet + nicht zuordenbar (Rundungstoleranz 1e-6 Wh).
      const quellen = e.pv + e.entladen + e.bezug;
      const zugeordnet = summeHaus(z) + z.speicherAusPvWh + z.speicherAusNetzWh
        + z.speicherAusSpeicherWh + z.netzAusPvWh + z.netzAusSpeicherWh;
      assert.ok(Math.abs(quellen - zugeordnet - z.nichtZuordenbarWh) < 1e-6, JSON.stringify(e));
    }
  });

  test('ein Speicher lädt, während der andere entlädt', () => {
    const z = zuordneIntervall({ pv: 0, haus: 800, bezug: 0, einspeisung: 0, laden: 1500, entladen: 2300 });
    assert.equal(z.hausAusSpeicherWh, 800);
    assert.equal(z.speicherAusSpeicherWh, 1500);
  });

  test('Batterieeinspeisung wird als solche ausgewiesen', () => {
    const z = zuordneIntervall({ pv: 200, haus: 500, bezug: 0, einspeisung: 1700, laden: 0, entladen: 2000 });
    assert.equal(z.netzAusSpeicherWh, 1700);
    assert.equal(z.hausAusPvWh, 200);
    assert.equal(z.hausAusSpeicherWh, 300);
  });
});

describe('consumptionSources / productionSinks — aus der Intervallzuordnung', () => {
  test('Teile plus nicht zuordenbar ergeben den gemessenen Verbrauch', () => {
    const z = zuordneIntervall({ pv: 0, haus: 1000, bezug: 5000, einspeisung: 0, laden: 4000, entladen: 0 });
    // Tagessumme etwas grösser als die zugeordneten Intervalle: Der Rest war
    // nicht vollständig gemessen.
    const t = totals({ houseConsumptionWh: 1300, gridImportWh: 5000, zuordnung: z });
    const s = consumptionSources(t);
    assert.ok(s);
    assert.equal(s.gridWh, 1000);
    assert.equal(s.pvDirectWh, 0);
    assert.equal(s.nichtZuordenbarWh, 300);
    assert.equal(s.pvDirectWh + s.batteryWh + s.gridWh + s.nichtZuordenbarWh, 1300);
    const p = productionSinks(t);
    assert.ok(p);
    assert.equal(p.batteryWh, 0, 'Netzladung wurde als PV-Verwendung gezählt');
  });

  test('Altbestand ohne Intervalle wird nicht nachträglich zugeordnet', () => {
    const t = altbestand({ houseConsumptionWh: 18640, gridImportWh: 1500, batteryDischargeWh: { a: 5300 } });
    assert.equal(consumptionSources(t), null);
    assert.equal(productionSinks(t), null);
  });
});

describe('computeCosts (30–34)', () => {
  test('Altbestand: Näherung aus Tagessummen, so gekennzeichnet', () => {
    const t = altbestand({ houseConsumptionWh: 18000, gridImportWh: 0, gridExportWh: 8000 });
    const c = computeCosts(t, { importPricePerKWh: 0.28, exportPricePerKWh: 0.08 });
    assert.equal(c.basis, 'naeherung');
    assert.ok(Math.abs(c.savedGridCostEUR - 5.04) < 1e-9);
    assert.ok(Math.abs(c.feedInRevenueEUR - 0.64) < 1e-9);
    assert.ok(Math.abs(c.totalBenefitEUR - 5.68) < 1e-9);
    assert.equal(c.grundgebuehrEnthalten, false);
  });

  test('Netzstrom über den Speicher ist keine Ersparnis', () => {
    // 4 kWh aus dem Netz geladen, später 4 kWh aus dem Speicher ins Haus.
    const laden = zuordneIntervall({ pv: 0, haus: 0, bezug: 4000, einspeisung: 0, laden: 4000, entladen: 0 });
    const nutzen = zuordneIntervall({ pv: 0, haus: 4000, bezug: 0, einspeisung: 0, laden: 0, entladen: 4000 });
    const z = Object.fromEntries(
      Object.keys(laden).map((k) => [k, laden[k as keyof Zuordnung] + nutzen[k as keyof Zuordnung]]),
    ) as unknown as Zuordnung;
    const t = totals({ houseConsumptionWh: 4000, gridImportWh: 4000, zuordnung: z });
    const c = computeCosts(t, { importPricePerKWh: 0.3, exportPricePerKWh: 0.08 });
    assert.equal(c.basis, 'modell');
    assert.equal(c.savedGridCostEUR, 0);
    assert.ok(Math.abs(c.gridCostActualEUR - 1.2) < 1e-9);
  });

  test('Referenzszenario ohne PV kostet den vollen Verbrauch', () => {
    const t = totals({ houseConsumptionWh: 10000, gridImportWh: 2000 });
    const c = computeCosts(t, { importPricePerKWh: 0.3, exportPricePerKWh: 0.08 });
    assert.ok(Math.abs(c.gridCostWithoutSystemEUR - 3.0) < 1e-9);
    assert.ok(Math.abs(c.gridCostActualEUR - 0.6) < 1e-9);
  });
});

describe('speicherGesamt — kapazitätsgewichtet und ehrlich unvollständig (15)', () => {
  test('gewichtet, nicht einfacher Mittelwert', () => {
    const g = speicherGesamt([
      { usableCapacityWh: 12000, socPercent: 100 },
      { usableCapacityWh: 50000, socPercent: 50 },
    ]);
    // (12000*1 + 50000*0,5) / 62000 = 37000/62000 = 59,7 %
    assert.equal(g.kapazitaetBekanntWh, 62000);
    assert.equal(g.energieBekanntWh, 37000);
    assert.ok(Math.abs((g.socPercent ?? 0) - 59.677) < 0.01);
    assert.notEqual(Math.round(g.socPercent ?? 0), 75);
  });

  test('ein Speicher fällt aus: kein Gesamt-SOC, keine Gesamtleistung', () => {
    // Früher stand der verbliebene Speicher allein als "Gesamtspeicher" da.
    const g = speicherGesamt(
      [{ usableCapacityWh: 12000, socPercent: 80, chargeW: 500, dischargeW: 0 }],
      2,
    );
    assert.equal(g.erwartet, 2);
    assert.equal(g.verfuegbar, 1);
    assert.equal(g.vollstaendig, false);
    assert.equal(g.socPercent, null);
    assert.equal(g.nettoLeistungW, null);
    // Die bekannten Werte des erreichbaren Speichers bleiben sichtbar.
    assert.equal(g.energieBekanntWh, 9600);
  });

  test('ein nicht erreichbarer Speicher zählt als fehlend, nicht als leer', () => {
    const g = speicherGesamt([
      { usableCapacityWh: 12000, socPercent: 80, chargeW: 0, dischargeW: 300 },
      { usableCapacityWh: 50000, socPercent: 60, chargeW: 0, dischargeW: 0, erreichbar: false },
    ]);
    assert.equal(g.verfuegbar, 1);
    assert.equal(g.socPercent, null);
  });

  test('fehlende Leistung wird nicht mit null aufgefüllt', () => {
    const g = speicherGesamt([
      { usableCapacityWh: 12000, socPercent: 80, chargeW: 200, dischargeW: 0 },
      { usableCapacityWh: 50000, socPercent: 60, chargeW: null, dischargeW: null },
    ]);
    assert.equal(g.vollstaendig, true);
    assert.equal(g.nettoLeistungW, null);
  });
});

describe('pruefeTotals — gültiges JSON ist noch keine gültige Summe', () => {
  test('nimmt eine korrekte Summe an', () => {
    assert.ok(pruefeTotals(emptyTotals()));
  });
  test('lehnt negative, nicht endliche und falsch typisierte Werte ab', () => {
    for (const kaputt of [
      { ...emptyTotals(), productionWh: -3 },
      { ...emptyTotals(), gridImportWh: 'viel' },
      { ...emptyTotals(), batteryChargeWh: { a: Number.NaN } },
      { ...emptyTotals(), perInverterWh: [] },
      { ...emptyTotals(), coveredSeconds: -1 },
      { ...emptyTotals(), zuordnung: { hausAusPvWh: 5 } },
      null,
      [],
    ]) {
      assert.equal(pruefeTotals(kaputt), null, JSON.stringify(kaputt));
    }
  });
  test('verträgt Altbestand ohne die neuen Felder', () => {
    const t = pruefeTotals(altbestand({ productionWh: 1000 }));
    assert.ok(t);
    assert.equal(t.zuordnung, undefined);
  });
});

/**
 * Synthetische Szenarien (STEP 81). Geprüft wird die Energiebilanz-Konsistenz:
 * PV + Netzbezug + Entladung = Haus + Ladung + EV + Einspeisung.
 */
describe('synthetische Szenarien — Bilanzkonsistenz (81)', () => {
  const balance = (s: {
    pv: number; house: number; charge: number; discharge: number;
    ev: number; gridImport: number; gridExport: number;
  }): number =>
    s.pv + s.gridImport + s.discharge - (s.house + s.charge + s.ev + s.gridExport);

  test('Szenario 1: PV 10, Haus 4, Batterie lädt 4, Export 2', () => {
    assert.equal(balance({ pv: 10, house: 4, charge: 4, discharge: 0, ev: 0, gridImport: 0, gridExport: 2 }), 0);
  });
  test('Szenario 2: PV 0, Haus 5, Batterie liefert 3, Bezug 2', () => {
    assert.equal(balance({ pv: 0, house: 5, charge: 0, discharge: 3, ev: 0, gridImport: 2, gridExport: 0 }), 0);
  });
  test('Szenario 3: PV 15, Haus 3, Bat1 lädt 2, Bat2 lädt 5, Auto 4, Export 1', () => {
    assert.equal(balance({ pv: 15, house: 3, charge: 7, discharge: 0, ev: 4, gridImport: 0, gridExport: 1 }), 0);
  });
  test('Szenario 4: PV 2, Haus 3, Auto 7, Batterie liefert 4, Netz liefert 4', () => {
    assert.equal(balance({ pv: 2, house: 3, charge: 0, discharge: 4, ev: 7, gridImport: 4, gridExport: 0 }), 0);
  });
});
