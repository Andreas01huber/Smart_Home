/**
 * Der Test, um den es eigentlich geht: Das Auto darf niemals der Grund dafür
 * sein, dass Strom aus dem Netz kommt.
 *
 * Die übrigen Tests prüfen einzelne Situationen. Hier läuft stattdessen ein
 * ganzer Tag im geschlossenen Regelkreis: Ein einfaches Modell der Anlage
 * rechnet die Physik, die Regelung sieht nur deren Messwerte, stellt daraufhin
 * den Ladestrom, und das Auto folgt mit Verzögerung. Danach wird für jeden
 * einzelnen Zeitschritt verglichen:
 *
 *     Netzbezug MIT Auto   gegen   Netzbezug OHNE Auto
 *
 * Der Unterschied ist genau das, was das Auto verursacht hat. Er muss null
 * sein — bis auf kurze Übergänge, wenn im Haus etwas Grosses eingeschaltet
 * wird und die Regelung eine Runde braucht, um nachzuziehen. Auch diese
 * Übergänge werden gemessen und begrenzt, statt sie durchgehen zu lassen.
 *
 * Ein Modell ist keine Anlage. Was es nicht beweisen kann: dass die Wallbox
 * Befehle annimmt und wie schnell das Fahrzeug wirklich folgt. Was es beweist:
 * dass die Regel selbst stimmt und die Regelung sie über tausend Schritte
 * hinweg einhält, auch bei Wolken, Lastsprüngen und leerem Speicher.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LADEANSCHLUSS_STANDARD, ladeleistungAusStromW } from './ladeleistung.ts';
import {
  berechneLadeziel,
  type Messwerte,
  type Reglerparameter,
} from './ueberschuss.ts';
import { beruhige, neueHistorie, type Zeitparameter } from './laderegler.ts';

const SCHRITT_MS = 2000;
const SCHRITTE_PRO_STUNDE = 3600_000 / SCHRITT_MS;

const PARAMETER: Reglerparameter = {
  anschluss: LADEANSCHLUSS_STANDARD,
  minA: 6,
  maxA: 16,
  schrittA: 1,
  reserveW: 200,
  netzTotzoneW: 150,
  speicher: { gross: { minSocPercent: 40, entladenMaxW: 3000 } },
  speicherStandard: { minSocPercent: 50, entladenMaxW: 0 },
  speicherEntladenErlaubt: true,
  maxMessalterMs: 30_000,
};

const ZEIT: Zeitparameter = {
  mindestabstandMs: 60_000,
  erhoehenNachMs: 90_000,
  senkenNachMs: 20_000,
  pausierenNachMs: 30_000,
  startenNachMs: 120_000,
  notbremseAbW: 300,
  netzTotzoneW: 150,
  netzImportTotzoneW: 40,
};

/** PV-Tagesgang: nachts null, mittags Spitze, mit Wolkenlöchern. */
function pvW(schritt: number, wolken: boolean): number {
  const stunde = schritt / SCHRITTE_PRO_STUNDE;
  if (stunde < 7 || stunde > 19) return 0;
  const bogen = Math.sin(((stunde - 7) / 12) * Math.PI);
  const klar = 11_000 * bogen;
  if (!wolken) return Math.max(0, klar);
  // Alle zwanzig Minuten eine Wolke, jeweils vier Minuten lang. Zeitbasiert,
  // damit das Muster nicht vom gewählten Zeitraster abhängt.
  const minuten = stunde * 60;
  const wolke = minuten % 20 < 4;
  return Math.max(0, wolke ? klar * 0.15 : klar);
}

/** Hausverbrauch mit Grundlast und ein paar kräftigen Verbrauchern. */
function hausW(schritt: number): number {
  const stunde = schritt / SCHRITTE_PRO_STUNDE;
  let last = 450;
  if (stunde >= 6.5 && stunde < 8) last += 2200; // Frühstück, Wasserkocher
  if (stunde >= 11.5 && stunde < 12.5) last += 3400; // Backrohr
  if (stunde >= 17 && stunde < 19) last += 1800; // Kochen
  if (stunde >= 19 && stunde < 22) last += 700; // Abend
  return last;
}

interface Ergebnis {
  readonly maxUeberschussW: number;
  readonly energieDurchAutoWh: number;
  readonly schritteMitBezug: number;
  /** Längste zusammenhängende Zeit mit Netzbezug durch das Auto, in Sekunden. */
  readonly laengsteDauerS: number;
  readonly geladenWh: number;
  readonly befehle: number;
}

/**
 * Fährt einen Tag und gibt zurück, was das Auto an Netzbezug verursacht hat.
 *
 * `evLeistung` folgt dem Sollwert mit einem Schritt Verzögerung — ein Fahrzeug
 * springt nicht in Nullzeit auf einen neuen Ladestrom.
 */
function fahreTag(optionen: {
  wolken: boolean;
  speicherSoc: number;
  speicherErlaubt?: boolean;
  angesteckt?: (schritt: number) => boolean;
}): Ergebnis {
  const parameter: Reglerparameter = {
    ...PARAMETER,
    speicherEntladenErlaubt: optionen.speicherErlaubt ?? true,
  };
  let historie = neueHistorie(-1, 0);
  let evLeistungW = 0;
  let sollA = 0;
  let soc = optionen.speicherSoc;
  const kapazitaetWh = 20_000;

  let maxUeberschussW = 0;
  let energieDurchAutoWh = 0;
  let schritteMitBezug = 0;
  let laengsteDauerS = 0;
  let laufendeDauerS = 0;
  let geladenWh = 0;
  let befehle = 0;

  const schritte = 24 * SCHRITTE_PRO_STUNDE;
  for (let i = 0; i < schritte; i++) {
    const jetztMs = i * SCHRITT_MS;
    const pv = pvW(i, optionen.wolken);
    const haus = hausW(i);
    const angesteckt = optionen.angesteckt ? optionen.angesteckt(i) : true;
    if (!angesteckt) evLeistungW = 0;

    // ── Physik: was der Speicher deckt und was ans Netz geht ───────────────
    const darfEntladen = parameter.speicherEntladenErlaubt && soc > 40;
    const bedarfMit = haus + evLeistungW;
    const entladungMit = darfEntladen ? Math.min(3000, Math.max(0, bedarfMit - pv)) : 0;
    const entladungOhne = darfEntladen ? Math.min(3000, Math.max(0, haus - pv)) : 0;

    const netzMit = Math.max(0, bedarfMit - pv - entladungMit);
    const netzOhne = Math.max(0, haus - pv - entladungOhne);
    const einspeisung = Math.max(0, pv - bedarfMit - Math.max(0, -0));

    // Genau das ist die verbotene Grösse: Netzbezug, den es ohne Auto nicht gäbe.
    const durchAuto = Math.max(0, netzMit - netzOhne);
    if (durchAuto > maxUeberschussW) maxUeberschussW = durchAuto;
    // Gezählt wird, was über der zugestandenen Import-Totzone liegt. Ganz ohne
    // Toleranz ginge es nicht: Ein Netzzähler rauscht, und eine Regelung, die
    // auf zwanzig Watt reagiert, würde den ganzen Tag zwischen zwei
    // Amperewerten pendeln. Vierzig Watt sind rund ein Prozent eines ladenden
    // Autos — und sie stehen nie lange an, wie dieser Test zeigt.
    if (durchAuto > 50) {
      schritteMitBezug++;
      laufendeDauerS += SCHRITT_MS / 1000;
      if (laufendeDauerS > laengsteDauerS) laengsteDauerS = laufendeDauerS;
    } else {
      laufendeDauerS = 0;
    }
    energieDurchAutoWh += (durchAuto * SCHRITT_MS) / 3_600_000;
    geladenWh += (evLeistungW * SCHRITT_MS) / 3_600_000;

    // Speicherstand fortschreiben.
    const ladung = Math.max(0, pv - bedarfMit);
    soc += ((Math.min(ladung, 3000) - entladungMit) * (SCHRITT_MS / 3_600_000)) / kapazitaetWh * 100;
    soc = Math.max(0, Math.min(100, soc));

    // ── Regelung sieht nur Messwerte ───────────────────────────────────────
    const messwerte: Messwerte = {
      pvW: pv,
      // Der Hausverbrauch der Anlage ENTHÄLT das Auto — wie im Echtbetrieb.
      hausMitAutoW: haus + evLeistungW,
      netzbezugW: netzMit,
      netzeinspeisungW: einspeisung,
      evLeistungW,
      evAngesteckt: angesteckt,
      evStromA: sollA,
      speicher: [
        {
          id: 'gross',
          name: 'Grosser Speicher',
          socPercent: soc,
          ladenW: Math.min(ladung, 3000),
          entladenW: entladungMit,
        },
      ],
      messalterMs: 2000,
      wallboxErreichbar: true,
    };

    const ziel = berechneLadeziel(messwerte, parameter);
    const ergebnis = beruhige({
      wunschA: ziel.zielA,
      netzbezugW: netzMit,
      jetztMs,
      historie,
      zeit: ZEIT,
    });
    historie = ergebnis.historie;
    if (ergebnis.senden) {
      befehle++;
      sollA = ergebnis.stromA;
    }

    // ── Fahrzeug folgt dem Sollwert (ein Schritt Verzögerung) ─────────────
    evLeistungW = angesteckt
      ? sollA === 0
        ? 0
        : (ladeleistungAusStromW(sollA, LADEANSCHLUSS_STANDARD) ?? 0)
      : 0;
  }

  return {
    maxUeberschussW,
    energieDurchAutoWh,
    schritteMitBezug,
    laengsteDauerS,
    geladenWh,
    befehle,
  };
}

describe('Ein ganzer Tag: das Auto verursacht keinen Netzbezug', () => {
  it('klarer Tag, Speicher gut gefüllt', () => {
    const r = fahreTag({ wolken: false, speicherSoc: 80 });
    // Nicht null, sondern "unter zehn Wattstunden am Tag". Null waere gelogen:
    // Wenn im Haus das Backrohr angeht, sind acht Kilowatt schlagartig weg, und
    // kein Regler der Welt weiss das vor dem Messwert. Was zaehlt, ist die
    // Reaktionszeit - hier zwei Sekunden.
    assert.ok(
      r.energieDurchAutoWh < 10,
      `Auto hat ${r.energieDurchAutoWh.toFixed(1)} Wh aus dem Netz gezogen`,
    );
    // Und es hat trotzdem geladen — eine Regelung, die einfach nie einschaltet,
    // wäre auch "netzfrei", aber nutzlos.
    assert.ok(r.geladenWh > 15_000, `nur ${(r.geladenWh / 1000).toFixed(1)} kWh geladen`);
  });

  it('wolkiger Tag mit Lastsprüngen', () => {
    const r = fahreTag({ wolken: true, speicherSoc: 70 });
    // Ein Tag mit sechsunddreissig Wolkendurchgaengen. Jede kostet die zwei
    // Sekunden bis zum naechsten Messwert - in Summe ein paar Dutzend
    // Wattstunden, also im Cent-Bereich.
    assert.ok(
      r.energieDurchAutoWh < 60,
      `Auto hat ${r.energieDurchAutoWh.toFixed(1)} Wh aus dem Netz gezogen `
        + `(Spitze ${Math.round(r.maxUeberschussW)} W in ${r.schritteMitBezug} Schritten)`,
    );
    assert.ok(r.geladenWh > 5000, `nur ${(r.geladenWh / 1000).toFixed(1)} kWh geladen`);
  });

  it('leerer Speicher, Entladen für das Auto gesperrt', () => {
    // Der härteste Fall: 36 Wolkendurchgänge, und kein Speicher, der die Dellen
    // abfängt. Jede Wolke schlägt voll auf den Netzzähler durch, bis die
    // Regelung zwei Sekunden später zurücknimmt. Rund 95 Wh am Tag - bei
    // 28 ct/kWh knapp drei Cent. Weniger geht nicht: Eine Wolke kündigt sich
    // nicht an, und schneller als der Messtakt kann niemand reagieren.
    const r = fahreTag({ wolken: true, speicherSoc: 20, speicherErlaubt: false });
    assert.ok(
      r.energieDurchAutoWh < 150,
      `Auto hat ${r.energieDurchAutoWh.toFixed(1)} Wh aus dem Netz gezogen`,
    );
  });

  it('Auto wird mittags abgesteckt und abends wieder angesteckt', () => {
    const r = fahreTag({
      wolken: true,
      speicherSoc: 70,
      angesteckt: (i) => {
        const stunde = i / SCHRITTE_PRO_STUNDE;
        return !(stunde >= 12 && stunde < 17);
      },
    });
    assert.ok(
      r.energieDurchAutoWh < 60,
      `Auto hat ${r.energieDurchAutoWh.toFixed(1)} Wh aus dem Netz gezogen`,
    );
  });

  it('sitzt Netzbezug niemals aus', () => {
    // Die aussagekräftigere Prüfung als die Summe: Wie LANGE steht Netzbezug
    // durch das Auto an? Ein paar Sekunden sind Reaktionszeit und unvermeidbar.
    // Alles darüber hiesse, dass die Regelung ihn erträgt — und genau das war
    // der Fehler der symmetrischen Totzone, die 150 W minutenlang stehen liess.
    for (const fall of [
      { name: 'klar', o: { wolken: false, speicherSoc: 80 } },
      { name: 'wolkig', o: { wolken: true, speicherSoc: 70 } },
      { name: 'ohne Speicher', o: { wolken: true, speicherSoc: 20, speicherErlaubt: false } },
    ] as const) {
      const r = fahreTag(fall.o);
      assert.ok(
        r.laengsteDauerS <= 10,
        `${fall.name}: Netzbezug stand ${r.laengsteDauerS} s an`,
      );
    }
  });

  it('regelt ruhig — nicht hunderte Befehle am Tag', () => {
    // Ein nervöser Regler wäre technisch korrekt und praktisch unbrauchbar:
    // Er würde die Tuya-Cloud überrennen und das Fahrzeug dauernd umstellen.
    const r = fahreTag({ wolken: true, speicherSoc: 70 });
    assert.ok(r.befehle < 80, `${r.befehle} Befehle an einem Tag ist zu unruhig`);
    assert.ok(r.befehle > 0, 'gar keine Befehle — dann regelt hier nichts');
  });
});
