/**
 * Die Szenarien aus dem Betrieb, als Test.
 *
 * Jeder Fall hier ist eine Situation, die an der echten Anlage vorkommt. Wenn
 * einer davon rot wird, würde das Auto entweder Strom aus dem Netz ziehen oder
 * grundlos nicht laden — beides merkt man draussen erst auf der Stromrechnung.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  berechneLadeziel,
  speicherFreigabeW,
  stromAusLeistungA,
  type Messwerte,
  type Reglerparameter,
  type SpeicherZustand,
} from './ueberschuss.ts';
import { LADEANSCHLUSS_STANDARD } from './ladeleistung.ts';

const GROSS = 'victron-modbus:system';
const KLEIN = 'fronius-gen24:0';

function parameter(ueber: Partial<Reglerparameter> = {}): Reglerparameter {
  return {
    anschluss: LADEANSCHLUSS_STANDARD,
    minA: 6,
    maxA: 16,
    schrittA: 1,
    reserveW: 200,
    netzTotzoneW: 150,
    speicher: {
      [GROSS]: { minSocPercent: 30, entladenMaxW: 3000 },
      [KLEIN]: { minSocPercent: 40, entladenMaxW: 2000 },
    },
    speicherStandard: { minSocPercent: 50, entladenMaxW: 0 },
    speicherEntladenErlaubt: true,
    maxMessalterMs: 30_000,
    ...ueber,
  };
}

function speicher(
  socGross: number | null,
  socKlein: number | null,
  entladenGross = 0,
  entladenKlein = 0,
): SpeicherZustand[] {
  return [
    { id: GROSS, name: 'Grosser Speicher', socPercent: socGross, ladenW: 0, entladenW: entladenGross },
    { id: KLEIN, name: 'Kleiner Speicher', socPercent: socKlein, ladenW: 0, entladenW: entladenKlein },
  ];
}

/**
 * Baut Messwerte aus einer physikalisch stimmigen Lage.
 *
 * Wichtig: `hausMitAutoW` enthält das Auto — genau so, wie die Bilanz der App
 * den Wert liefert. Wer hier "Haus ohne Auto" einsetzt, testet etwas anderes
 * als die Anlage tut.
 */
function messwerte(lage: {
  pv: number;
  hausOhneAuto: number;
  ev: number;
  angesteckt?: boolean;
  speicher?: SpeicherZustand[];
  alterMs?: number;
  erreichbar?: boolean;
}): Messwerte {
  const speicherliste = lage.speicher ?? speicher(80, 80);
  const entladung = speicherliste.reduce((s, b) => s + (b.entladenW ?? 0), 0);
  const ladung = speicherliste.reduce((s, b) => s + (b.ladenW ?? 0), 0);
  // Bilanz schliessen: Was PV und Speicher nicht decken, kommt aus dem Netz;
  // was übrig bleibt, geht hinein.
  const bedarf = lage.hausOhneAuto + lage.ev + ladung;
  const angebot = lage.pv + entladung;
  const netzbezug = Math.max(0, bedarf - angebot);
  const einspeisung = Math.max(0, angebot - bedarf);
  return {
    pvW: lage.pv,
    hausMitAutoW: lage.hausOhneAuto + lage.ev,
    netzbezugW: netzbezug,
    netzeinspeisungW: einspeisung,
    evLeistungW: lage.ev,
    evAngesteckt: lage.angesteckt ?? true,
    evStromA: null,
    speicher: speicherliste,
    messalterMs: lage.alterMs ?? 1000,
    wallboxErreichbar: lage.erreichbar ?? true,
  };
}

describe('Umrechnung Leistung zu Ladestrom', () => {
  it('rundet immer ab, niemals auf', () => {
    // 7000 W wären 10,1 A. Aufgerundet auf 11 A wären es 7620 W - die fehlenden
    // 620 W kämen aus dem Netz.
    assert.equal(stromAusLeistungA(7000, parameter()), 10);
    assert.equal(stromAusLeistungA(11_084, parameter()), 15);
  });

  it('hält die Obergrenze der Wallbox ein', () => {
    assert.equal(stromAusLeistungA(50_000, parameter()), 16);
  });

  it('beachtet die Schrittweite', () => {
    assert.equal(stromAusLeistungA(7000, parameter({ schrittA: 2 })), 10);
    assert.equal(stromAusLeistungA(6300, parameter({ schrittA: 2 })), 8);
  });
});

describe('Speicherfreigabe', () => {
  it('gibt nur oberhalb des Mindestladestands frei', () => {
    const p = parameter();
    assert.equal(speicherFreigabeW(speicher(80, 80), p), 5000);
    assert.equal(speicherFreigabeW(speicher(20, 80), p), 2000);
    assert.equal(speicherFreigabeW(speicher(20, 10), p), 0);
  });

  it('gibt nichts frei, wenn Entladen für das Auto gesperrt ist', () => {
    assert.equal(
      speicherFreigabeW(speicher(90, 90), parameter({ speicherEntladenErlaubt: false })),
      0,
    );
  });

  it('zählt einen Speicher ohne bekannten Ladestand mit null', () => {
    assert.equal(speicherFreigabeW(speicher(null, 80), parameter()), 2000);
  });
});

describe('Szenario A — viel Sonne, wenig Haus', () => {
  it('lädt mit hoher Leistung', () => {
    const e = berechneLadeziel(
      messwerte({ pv: 10_000, hausOhneAuto: 2000, ev: 0 }),
      parameter(),
    );
    assert.equal(e.zustand, 'laedt');
    // 10000 - 2000 - 200 Reserve = 7800 W -> 11 A. Speicher liefern nichts,
    // weil sie gerade nicht entladen; ihre Freigabe kommt on top.
    assert.ok(e.zielA >= 11, `zielA war ${e.zielA}`);
    assert.equal(e.hausOhneAutoW, 2000);
  });
});

describe('Szenario B — knapper Überschuss', () => {
  it('lädt nur mit dem, was wirklich übrig ist — nicht mit versprochener Speicherleistung', () => {
    // PV 5 kW, Haus 4 kW: 1 kW echte Einspeisung. Die Speicherfreigabe von
    // 5 kW ändert daran nichts — sie ist ein Versprechen, keine Messung, und
    // ein Versprechen darf nicht zu Netzbezug führen. 1 kW reicht nicht für
    // den Mindestladestrom, also Pause.
    const e = berechneLadeziel(
      messwerte({ pv: 5000, hausOhneAuto: 4000, ev: 0 }),
      parameter(),
    );
    assert.equal(e.zielA, 0);
    assert.ok(e.verfuegbarW < 1000, `verfügbar ${e.verfuegbarW}`);
  });

  it('lädt weiter, wenn der Speicher freiwillig mithilft', () => {
    // Das Auto zieht die 4157 W eines Sechs-Ampere-Ladevorgangs, der Speicher
    // deckt 2 kW davon — innerhalb seiner Freigabe. Der Netzzähler steht auf
    // null, also ist alles in Ordnung und der Ladestrom bleibt.
    //
    // Ohne die Ausnahme für den Mindestladestrom würde hier die Reserve von
    // 200 W das Laden abwürgen: 4157 minus 200 sind rechnerisch 5 A, also
    // unter dem Minimum. Und wieder anfangen ginge dann erst recht nicht.
    const liste = speicher(80, 80, 2000, 0);
    const e = berechneLadeziel(
      // PV plus Speicherbeitrag decken den Bedarf genau — der Netzzähler steht
      // auf null, und darum geht es hier.
      messwerte({ pv: 6157, hausOhneAuto: 4000, ev: 4157, speicher: liste }),
      parameter(),
    );
    assert.equal(e.zustand, 'laedt');
    assert.equal(e.zielA, 6);
  });

  it('pausiert, wenn der Mindestladestrom nicht erreicht wird', () => {
    // Ohne Speicherfreigabe bleiben 800 W - unter 6 A (4157 W).
    const e = berechneLadeziel(
      messwerte({ pv: 5000, hausOhneAuto: 4000, ev: 0 }),
      parameter({ speicherEntladenErlaubt: false }),
    );
    assert.equal(e.zielA, 0);
    assert.match(e.grund, /pausiert/i);
  });
});

describe('Szenario C — Unterdeckung, Speicher gesperrt', () => {
  it('pausiert und nennt den Speicher als Grund', () => {
    const e = berechneLadeziel(
      messwerte({ pv: 4000, hausOhneAuto: 5000, ev: 0 }),
      parameter({ speicherEntladenErlaubt: false }),
    );
    assert.equal(e.zustand, 'pausiert-speicher');
    assert.equal(e.zielA, 0);
  });

  it('pausiert auch, wenn alle Speicher unter der Reserve liegen', () => {
    const e = berechneLadeziel(
      messwerte({ pv: 4000, hausOhneAuto: 5000, ev: 0, speicher: speicher(10, 10) }),
      parameter(),
    );
    assert.equal(e.zielA, 0);
  });
});

describe('Szenario D — Hausverbrauch springt hoch', () => {
  it('senkt den Sollwert deutlich', () => {
    const p = parameter({ speicherEntladenErlaubt: false });
    // Vorher: 8 kW PV, 2 kW Haus, Auto zieht bereits 5 kW.
    const vorher = berechneLadeziel(
      messwerte({ pv: 8000, hausOhneAuto: 2000, ev: 5000 }),
      p,
    );
    // Nachher: Haus springt auf 6 kW, Auto zieht noch die alten 5 kW ->
    // 3 kW kommen aus dem Netz.
    const nachher = berechneLadeziel(
      messwerte({ pv: 8000, hausOhneAuto: 6000, ev: 5000 }),
      p,
    );
    assert.ok(nachher.zielA < vorher.zielA, `${nachher.zielA} nicht < ${vorher.zielA}`);
    // 8000 - 6000 - 200 = 1800 W -> unter 6 A -> Pause.
    assert.equal(nachher.zielA, 0);
    // Und der Hausverbrauch ohne Auto wird korrekt herausgerechnet.
    assert.equal(nachher.hausOhneAutoW, 6000);
  });

  it('rechnet das Auto nicht doppelt aus dem Hausverbrauch heraus', () => {
    // Der klassische Fehler: Haus enthält das Auto schon. Wer nochmal abzieht,
    // kommt auf zu wenig und lädt viel zu vorsichtig.
    const p = parameter({ speicherEntladenErlaubt: false });
    const e = berechneLadeziel(messwerte({ pv: 9000, hausOhneAuto: 2000, ev: 4000 }), p);
    assert.equal(e.hausOhneAutoW, 2000);
    // 9000 - 2000 - 200 = 6800 W -> 9 A.
    assert.equal(e.zielA, 9);
  });
});

describe('Szenario E — PV bricht ein', () => {
  it('pausiert, statt die Differenz aus dem Netz zu holen', () => {
    const p = parameter({ speicherEntladenErlaubt: false });
    const e = berechneLadeziel(
      messwerte({ pv: 500, hausOhneAuto: 2000, ev: 5000 }),
      p,
    );
    assert.equal(e.zielA, 0);
    assert.ok(e.verfuegbarW < 0);
  });
});

describe('Szenario F — PV steigt wieder', () => {
  it('gibt mehr Strom frei', () => {
    const p = parameter({ speicherEntladenErlaubt: false });
    const wenig = berechneLadeziel(messwerte({ pv: 6000, hausOhneAuto: 1000, ev: 4000 }), p);
    const viel = berechneLadeziel(messwerte({ pv: 11_000, hausOhneAuto: 1000, ev: 4000 }), p);
    assert.ok(viel.zielA > wenig.zielA, `${viel.zielA} nicht > ${wenig.zielA}`);
    assert.equal(viel.zielA, 14); // 11000-1000-200 = 9800 W -> 14 A
  });

  it('überschreitet nie die Wallbox-Obergrenze', () => {
    const e = berechneLadeziel(
      messwerte({ pv: 40_000, hausOhneAuto: 500, ev: 0 }),
      parameter(),
    );
    assert.equal(e.zielA, 16);
  });
});

describe('Szenario G — Messwerte fehlen oder sind alt', () => {
  it('pausiert bei fehlendem Netzzähler', () => {
    const roh = messwerte({ pv: 9000, hausOhneAuto: 1000, ev: 0 });
    const e = berechneLadeziel({ ...roh, netzbezugW: null }, parameter());
    assert.equal(e.zustand, 'pausiert-messwerte');
    assert.equal(e.zielA, 0);
  });

  it('pausiert bei veralteten Messwerten', () => {
    const e = berechneLadeziel(
      messwerte({ pv: 9000, hausOhneAuto: 1000, ev: 0, alterMs: 120_000 }),
      parameter(),
    );
    assert.equal(e.zustand, 'pausiert-messwerte');
    assert.match(e.grund, /alt/);
  });

  it('pausiert, wenn unklar ist, ob ein Fahrzeug angesteckt ist', () => {
    const roh = messwerte({ pv: 9000, hausOhneAuto: 1000, ev: 0 });
    const e = berechneLadeziel({ ...roh, evAngesteckt: null }, parameter());
    assert.equal(e.zielA, 0);
  });
});

describe('Szenario H — Wallbox nicht erreichbar', () => {
  it('meldet Störung und ändert nichts', () => {
    const e = berechneLadeziel(
      messwerte({ pv: 9000, hausOhneAuto: 1000, ev: 0, erreichbar: false }),
      parameter(),
    );
    assert.equal(e.zustand, 'gestoert');
    assert.equal(e.zielA, 0);
  });
});

describe('Kein Fahrzeug', () => {
  it('regelt nicht, wenn nichts angesteckt ist', () => {
    const e = berechneLadeziel(
      messwerte({ pv: 9000, hausOhneAuto: 1000, ev: 0, angesteckt: false }),
      parameter(),
    );
    assert.equal(e.zustand, 'nicht-verbunden');
  });
});

describe('Speicher bedarfsgerecht', () => {
  it('nimmt nur, was fehlt — nicht die volle Entladeleistung', () => {
    // Haus 5 kW, Auto 1 kW, PV 4 kW: es fehlen 2 kW. Der Speicher entlädt
    // gerade genau diese 2 kW. Verfügbar für das Auto bleibt sein eigener
    // Verbrauch plus die Freigabe minus die laufende Entladung.
    const p = parameter();
    const liste = speicher(80, 80, 2000, 0);
    const e = berechneLadeziel(
      messwerte({ pv: 4000, hausOhneAuto: 5000, ev: 1000, speicher: liste }),
      p,
    );
    // Freigabe 5000, laufende Entladung 2000 -> netto 3000 zusätzlich.
    // 1000 (Auto) + 0 - 0 - 200 - 2000 + 5000 = 3800 W -> 5 A -> unter Minimum.
    assert.ok(e.verfuegbarW > 0 && e.verfuegbarW < 5000, `verfügbar ${e.verfuegbarW}`);
  });

  it('verbucht eine laufende Entladung nicht als Überschuss', () => {
    // Ohne die Korrektur würde das Auto den Speicher leersaugen: Der Netzzähler
    // zeigt 0, weil der Speicher das Haus deckt - das ist aber kein Überschuss.
    const p = parameter({ speicherEntladenErlaubt: false });
    const liste = speicher(80, 80, 3000, 0);
    const e = berechneLadeziel(
      messwerte({ pv: 0, hausOhneAuto: 3000, ev: 0, speicher: liste }),
      p,
    );
    assert.ok(e.verfuegbarW <= 0, `verfügbar ${e.verfuegbarW}`);
    assert.equal(e.zielA, 0);
  });
});

describe('Netzbezug als Rückführung', () => {
  it('senkt, wenn trotz Rechnung Strom aus dem Netz kommt', () => {
    // Die Bilanz sagt "genug da", der Zähler sagt 400 W Bezug. Der Zähler gewinnt.
    const p = parameter({ speicherEntladenErlaubt: false });
    const roh = messwerte({ pv: 8000, hausOhneAuto: 2000, ev: 6000 });
    const mitBezug: Messwerte = { ...roh, netzbezugW: 400, netzeinspeisungW: 0 };
    const e = berechneLadeziel(mitBezug, p);
    // 6000 + 0 - 400 - 200 = 5400 W -> 7 A statt der vorher gefahrenen 8.
    assert.equal(e.zielA, 7);
  });

  it('erhöht, wenn dauerhaft eingespeist wird', () => {
    const p = parameter({ speicherEntladenErlaubt: false });
    const roh = messwerte({ pv: 8000, hausOhneAuto: 2000, ev: 4000 });
    const mitEinspeisung: Messwerte = { ...roh, netzbezugW: 0, netzeinspeisungW: 1800 };
    const e = berechneLadeziel(mitEinspeisung, p);
    // 4000 + 1800 - 200 = 5600 W -> 8 A.
    assert.equal(e.zielA, 8);
  });
});
