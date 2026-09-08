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
      [GROSS]: { minSocPercent: 30, entladenMaxW: 3000, autoVorrangAbSocPercent: 80 },
      [KLEIN]: { minSocPercent: 40, entladenMaxW: 2000, autoVorrangAbSocPercent: 80 },
    },
    speicherStandard: { minSocPercent: 50, entladenMaxW: 0, autoVorrangAbSocPercent: 80 },
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

describe('Der Speicher schluckt den Überschuss — der echte Fall vom 8.9.2026', () => {
  /**
   * Die Lage, die alles ausgelöst hat, mit den echten Messwerten der Anlage:
   * 7325 W Sonne, der kleine Speicher lädt bei 96,6 % noch mit 1898 W, der
   * grosse ist voll. Weil der Speicher alles schluckt, geht nichts ins Netz —
   * und die alte Rechnung sah deshalb null Überschuss, obwohl über 5 kW frei
   * waren.
   */
  function lage(ueber: Partial<Messwerte> = {}): Messwerte {
    return {
      pvW: 7325,
      hausMitAutoW: 1250,
      netzbezugW: 61,
      netzeinspeisungW: 0,
      evLeistungW: 0,
      evAngesteckt: true,
      evStromA: 0,
      speicher: [
        {
          id: GROSS,
          name: 'Grosser Speicher',
          socPercent: 100,
          ladenW: 61,
          entladenW: 0,
          bewaehrtEntladenW: 4222,
        },
        {
          id: KLEIN,
          name: 'Kleiner Speicher',
          socPercent: 96.6,
          ladenW: 1898,
          entladenW: 0,
          bewaehrtEntladenW: 4602,
        },
      ],
      messalterMs: 1000,
      wallboxErreichbar: true,
      ...ueber,
    };
  }

  it('lädt, statt bei null Einspeisung stehen zu bleiben', () => {
    const e = berechneLadeziel(lage(), parameter());
    assert.equal(e.zustand, 'laedt');
    // 0 + 0 - 61 - 200 + 1959 (Ladeleistung beider Speicher)
    // + 3000 + 2000 (Entladefreigabe, gedeckt durch den Nachweis) = 6698 W.
    assert.ok(e.verfuegbarW > 6000, `nur ${Math.round(e.verfuegbarW)} W erkannt`);
    assert.equal(e.zielA, 9);
  });

  it('erkennt ohne die Speicher gar nichts — so war es vorher', () => {
    // Derselbe Moment, nur mit gesperrten Speichern: Netzzähler auf null,
    // also aus seiner Sicht kein Überschuss. Genau das stand in der App.
    const e = berechneLadeziel(lage(), parameter({ speicherEntladenErlaubt: false }));
    assert.equal(e.zielA, 0);
    assert.match(e.grund, /Speicher/);
  });

  it('rechnet den Hausverbrauch ohne Auto heraus', () => {
    const e = berechneLadeziel(lage({ hausMitAutoW: 5426, evLeistungW: 4176 }), parameter());
    assert.equal(e.hausOhneAutoW, 1250);
  });
});

describe('Ladeleistung der Speicher gehört dem Auto — aber erst ab dem Vorrang', () => {
  function mitLadung(soc: number, ladenW: number): Messwerte {
    return {
      pvW: 6000,
      hausMitAutoW: 1000,
      netzbezugW: 0,
      netzeinspeisungW: 0,
      evLeistungW: 0,
      evAngesteckt: true,
      evStromA: 0,
      speicher: [
        { id: GROSS, name: 'Gross', socPercent: soc, ladenW, entladenW: 0 },
        { id: KLEIN, name: 'Klein', socPercent: 10, ladenW: 0, entladenW: 0 },
      ],
      messalterMs: 1000,
      wallboxErreichbar: true,
    };
  }

  it('zählt sie, wenn der Speicher fast voll ist', () => {
    const e = berechneLadeziel(mitLadung(95, 5000), parameter());
    // 0 + 0 - 0 - 200 + 5000 = 4800 W. Ohne Nachweis kommt nichts dazu.
    assert.equal(Math.round(e.verfuegbarW), 4800);
    assert.equal(e.zielA, 6);
  });

  it('zählt sie NICHT, solange der Speicher Vorrang hat', () => {
    // 60 % Ladestand: Was abends fehlt, kommt aus dem Netz. Der Speicher darf
    // erst voll werden.
    const e = berechneLadeziel(mitLadung(60, 5000), parameter());
    assert.equal(e.zielA, 0);
    assert.equal(Math.round(e.verfuegbarW), -200);
  });
});

describe('Entladespielraum nur bis zum Nachweis', () => {
  function mitNachweis(bewaehrt: number | null, entladen = 0): Messwerte {
    return {
      pvW: 2000,
      hausMitAutoW: 2000,
      netzbezugW: 0,
      netzeinspeisungW: 0,
      evLeistungW: 0,
      evAngesteckt: true,
      evStromA: 0,
      speicher: [
        {
          id: GROSS,
          name: 'Gross',
          socPercent: 100,
          ladenW: 0,
          entladenW: entladen,
          ...(bewaehrt === null ? {} : { bewaehrtEntladenW: bewaehrt }),
        },
      ],
      messalterMs: 1000,
      wallboxErreichbar: true,
    };
  }

  it('plant nichts ein, solange der Speicher nichts bewiesen hat', () => {
    // Die Freigabe steht bei 3000 W. Ohne Nachweis ist sie ein Versprechen —
    // und Versprechen kosteten diese Anlage schon einmal 2 kWh am Tag.
    const e = berechneLadeziel(mitNachweis(null), parameter());
    assert.equal(Math.round(e.verfuegbarW), -200);
    assert.equal(e.zielA, 0);
  });

  it('plant höchstens den Nachweis ein, nie die volle Freigabe', () => {
    const e = berechneLadeziel(mitNachweis(1500), parameter());
    assert.equal(Math.round(e.verfuegbarW), 1300);
  });

  it('deckelt beim konfigurierten Höchstwert, auch wenn mehr bewiesen ist', () => {
    // Der Speicher kann 8000 W. Erlaubt sind für das Auto trotzdem nur 3000.
    const e = berechneLadeziel(mitNachweis(8000), parameter());
    assert.equal(Math.round(e.verfuegbarW), 2800);
  });

  it('zählt nur den noch ungenutzten Teil', () => {
    // Der Speicher liefert bereits 2000 W von 3000 W Freigabe: Es bleiben 1000.
    // Ohne diese Subtraktion würde dieselbe Leistung zweimal verplant.
    const e = berechneLadeziel(mitNachweis(3000, 2000), parameter());
    assert.equal(Math.round(e.verfuegbarW), 800);
  });
});

describe('Widersprüchliche Messwerte: Auto gegen Hauszähler', () => {
  /**
   * Der Fall aus dem Protokoll vom 8.9., 16:2x Uhr: Das Auto hatte längst
   * aufgehört, der Hauszähler zeigte 1,5 kW — die Tuya-Cloud meldete aber
   * weiter 9042 W. Die Rechnung addierte diese 9 kW als "läuft ja schon" und
   * kam auf 14,4 kW verfügbar, bei 5,7 kW Sonne.
   */
  function widerspruch(gemeldetesAutoW: number, hausW: number): Messwerte {
    return {
      pvW: 5663,
      hausMitAutoW: hausW,
      netzbezugW: 0,
      netzeinspeisungW: 0,
      evLeistungW: gemeldetesAutoW,
      evAngesteckt: true,
      evStromA: 16,
      speicher: [
        { id: GROSS, name: 'Gross', socPercent: 100, ladenW: 4200, entladenW: 0 },
      ],
      messalterMs: 1000,
      wallboxErreichbar: true,
    };
  }

  it('deckelt den Ladewert am Hausverbrauch', () => {
    const e = berechneLadeziel(widerspruch(9042, 1500), parameter());
    // Ohne Deckel: 9042 + 0 - 0 - 200 + 4200 = 13 042 W und damit 16 A.
    // Mit Deckel: 1500 statt 9042, also 5500 W und 7 A.
    assert.ok(
      e.verfuegbarW < 6000,
      `${Math.round(e.verfuegbarW)} W verfügbar — der veraltete Ladewert wurde geglaubt`,
    );
    assert.equal(e.zielA, 7);
  });

  it('lässt einen stimmigen Ladewert unangetastet', () => {
    // Auto 10 200 W, Haus 11 700 W: passt zusammen, es wird nichts gedeckelt.
    const e = berechneLadeziel(widerspruch(10_200, 11_700), parameter());
    assert.equal(Math.round(e.verfuegbarW), 10_200 - 200 + 4200);
    assert.equal(e.hausOhneAutoW, 1500);
  });

  it('behauptet bei Widerspruch kein leeres Haus', () => {
    // Vorher stand im Protokoll minutenlang "Haus ohne Auto 0 W" — das war kein
    // leeres Haus, sondern der Widerspruch zwischen den beiden Zaehlern. Wer
    // ihn nicht aufloesen kann, soll ihn auch nicht ueberdecken: null wird in
    // der Anzeige zu einem Strich, 0 zu einer Behauptung.
    const e = berechneLadeziel(widerspruch(9042, 1500), parameter());
    assert.equal(e.hausOhneAutoW, null);
  });
});

describe('Eingefrorener Leistungswert der Wallbox', () => {
  /**
   * Gemessen am 8.9. um 16:50: `charge_cur_set` fiel auf 6 A, `power_total`
   * meldete minutenlang unverändert 10 084 W. Die Regelung glaubte, sechs
   * Kilowatt flössen bereits, plante entsprechend gross — und musste jedes Mal
   * mit der Notbremse zurück.
   */
  function eingefroren(gesetztA: number): Messwerte {
    return {
      pvW: 5000,
      hausMitAutoW: 9500,
      netzbezugW: 0,
      netzeinspeisungW: 0,
      evLeistungW: 10_084,
      evAngesteckt: true,
      evStromA: gesetztA,
      speicher: [],
      messalterMs: 1000,
      wallboxErreichbar: true,
    };
  }

  it('glaubt nicht mehr, als die Strombegrenzung hergibt', () => {
    const e = berechneLadeziel(eingefroren(6), parameter());
    // Mit dem eingefrorenen Wert: 10 084 - 200 = 9884 W und damit 14 A.
    // Mit der Schranke: 6 A sind höchstens 4157 W, also 3957 W und 5 A —
    // zu wenig für den Mindestladestrom, aber die Wallbox lädt schon, deshalb
    // bleibt sie beim Minimum stehen statt zu springen.
    assert.ok(
      e.zielA <= 6,
      `Ziel ${e.zielA} A — der eingefrorene Leistungswert wurde geglaubt`,
    );
  });

  it('lässt einen stimmigen Wert unangetastet', () => {
    // 15 A und 10 084 W ergeben 388 V — eine mögliche Netzspannung, also passt
    // das Paar zusammen und die Messung gilt. Der Hauszähler muss dafür gross
    // genug sein, sonst greift die andere Schranke.
    const stimmig: Messwerte = { ...eingefroren(15), hausMitAutoW: 11_500 };
    const e = berechneLadeziel(stimmig, parameter());
    assert.equal(Math.round(e.verfuegbarW), 10_084 - 200);
  });

  it('nimmt die Strombegrenzung auch dann, wenn das Haus grösser ist', () => {
    // Der Hauszähler allein würde hier nichts merken: 10 084 passen bequem in
    // 12 000 W hinein. Erst die Strombegrenzung deckt den Widerspruch auf.
    const gross: Messwerte = { ...eingefroren(6), hausMitAutoW: 12_000 };
    const e = berechneLadeziel(gross, parameter());
    assert.ok(e.zielA <= 6, `Ziel ${e.zielA} A`);
  });
});
