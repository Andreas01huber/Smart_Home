/**
 * Die Beruhigung der Ladestromregelung.
 *
 * `berechneLadeziel` in `ueberschuss.ts` sagt, was *jetzt gerade* möglich wäre.
 * Diese Datei entscheidet, ob das auch gesendet wird. Beides zu trennen hat
 * einen praktischen Grund: Die Rechnung ist zeitlos und dadurch prüfbar, das
 * Zeitverhalten ist es nicht — und alles, was hier schiefgeht, äussert sich als
 * nervöses Auf und Ab am Auto, nicht als falsche Zahl.
 *
 * Vier Bremsen wirken zusammen:
 *
 *   1. **Mindestabstand** zwischen zwei Befehlen. Die Tuya-Cloud ist kein
 *      lokaler Bus; jeder Befehl kostet eine Anfrage und das Fahrzeug braucht
 *      ohnehin Sekunden, um einem neuen Sollwert zu folgen.
 *
 *   2. **Asymmetrische Haltezeiten.** Hinunter wird schnell geregelt, hinauf
 *      langsam. Das ist keine Willkür: Zu spät gesenkt heisst Netzbezug — genau
 *      das, was vermieden werden soll. Zu spät erhöht heisst nur, dass ein paar
 *      Sekunden lang etwas weniger geladen wurde.
 *
 *   3. **Totzone am Netzzähler.** Solange der Netzbezug nahe null pendelt, wird
 *      ein Sollwert von einem Ampere Unterschied nicht angefasst. Ohne das
 *      würde die Regelung ewig zwischen zwei Werten hin- und herspringen, weil
 *      jede Wolke die Rechnung um ein halbes Ampere verschiebt.
 *
 *   4. **Notbremse.** Fliesst wirklich Strom aus dem Netz, gelten Mindestabstand
 *      und Haltezeit nicht. Sicherheitsrichtung vor Ruhe.
 */

/** Was die Regelung zuletzt getan hat. Lebt im Arbeitsspeicher des Reglers. */
export interface Reglerhistorie {
  /** Zuletzt an die Wallbox gesendeter Strom. 0 = pausiert. */
  readonly gesetztA: number;
  /** Zeitpunkt des letzten gesendeten Befehls. */
  readonly gesetztAtMs: number;
  /** Letzter roher Wunsch aus der Rechnung. */
  readonly wunschA: number;
  /** Seit wann der Wunsch unverändert in dieselbe Richtung zeigt. */
  readonly wunschSeitMs: number;
}

export interface Zeitparameter {
  /** Kürzester Abstand zwischen zwei Tuya-Befehlen. */
  readonly mindestabstandMs: number;
  /** So lange muss ein höherer Wunsch anhalten, bevor erhöht wird. */
  readonly erhoehenNachMs: number;
  /** So lange muss ein niedrigerer Wunsch anhalten, bevor gesenkt wird. */
  readonly senkenNachMs: number;
  /**
   * Verkürzte Haltezeit fürs Senken, wenn wirklich Strom aus dem Netz kommt.
   *
   * Die zwanzig Sekunden oben sind für den harmlosen Fall gedacht: Die
   * Einspeisung ist geschrumpft, das Auto könnte etwas weniger nehmen, und es
   * eilt nicht. Fliesst dagegen Strom aus dem Netz, eilt es sehr wohl — dann
   * kostet jede Sekunde Beobachtung Geld.
   *
   * Die Notbremse (`notbremseAbW`, 300 W) fängt nur den groben Fall ab. Genau
   * dazwischen entstand der Fehler, den dieser Wert behebt: 60 W Netzbezug,
   * unter der Notbremse und über der Totzone, wurden volle zwanzig Sekunden
   * lang ausgesessen. Sechs Sekunden sind drei Messtakte — genug, um ein
   * einzelnes Zappeln des Zählers nicht ernst zu nehmen, und kurz genug, dass
   * kein nennenswerter Netzbezug entsteht.
   */
  readonly senkenBeiBezugNachMs: number;
  /** So lange muss "es reicht nicht" anhalten, bevor pausiert wird. */
  readonly pausierenNachMs: number;
  /** So lange muss "es reicht wieder" anhalten, bevor neu gestartet wird. */
  readonly startenNachMs: number;
  /** Netzbezug, ab dem sofort gesenkt wird, ohne auf Fristen zu warten. */
  readonly notbremseAbW: number;
  /**
   * Totzone auf der EINSPEISE-Seite: So viel darf ins Netz gehen, ohne dass
   * wegen eines einzelnen Ampereschritts nachgeregelt wird.
   */
  readonly netzTotzoneW: number;
  /**
   * Totzone auf der BEZUGS-Seite. Deutlich kleiner, und das ist der Punkt.
   *
   * Die erste Fassung hatte eine symmetrische Totzone von ±150 W. Im
   * Tagesdurchlauf zeigte sich, was das bedeutet: Weil die Wallbox nur ganze
   * Ampere kennt, bleibt beim Nachregeln fast immer ein Rest — und lag der bei
   * +150 W Netzbezug, sass die Regelung ihn minutenlang aus, statt einen
   * Schritt zurückzugehen. Fünf solche Phasen an einem wolkenlosen Tag ergaben
   * 24 Wh aus dem Netz. Wenig Geld, aber genau das Verhalten, das hier nicht
   * vorkommen darf.
   *
   * Einspeisen darf ruhig ein bisschen daneben liegen. Beziehen nicht.
   */
  readonly netzImportTotzoneW: number;
}

export interface BeruhigungsEingang {
  /** Roher Wunsch aus `berechneLadeziel`; 0 bedeutet Pause. */
  readonly wunschA: number;
  /** Aktuell gemessener Netzbezug in Watt. */
  readonly netzbezugW: number;
  /** Jetzt-Zeitpunkt in Millisekunden. */
  readonly jetztMs: number;
  readonly historie: Reglerhistorie;
  readonly zeit: Zeitparameter;
}

export interface BeruhigungsErgebnis {
  /** Soll ein Befehl an die Wallbox gehen? */
  readonly senden: boolean;
  /** Der zu sendende Wert (nur gültig, wenn `senden`). */
  readonly stromA: number;
  /** Klartext fürs Protokoll — auch wenn nichts gesendet wird. */
  readonly grund: string;
  /** Fortgeschriebene Historie. Immer übernehmen. */
  readonly historie: Reglerhistorie;
}

export function neueHistorie(gesetztA = 0, jetztMs = 0): Reglerhistorie {
  return { gesetztA, gesetztAtMs: 0, wunschA: gesetztA, wunschSeitMs: jetztMs };
}

/**
 * Entscheidet, ob der Wunsch jetzt gesendet wird.
 *
 * Ruft die Regelung bei jedem Zyklus auf, auch wenn sich nichts ändert — die
 * Haltezeiten werden hier mitgeführt.
 */
export function beruhige(eingang: BeruhigungsEingang): BeruhigungsErgebnis {
  const { wunschA, netzbezugW, jetztMs, historie, zeit } = eingang;

  // Wunsch gewechselt? Dann läuft die Haltezeit neu.
  const wunschStabilSeit =
    wunschA === historie.wunschA ? historie.wunschSeitMs : jetztMs;
  const fortgeschrieben: Reglerhistorie = {
    ...historie,
    wunschA,
    wunschSeitMs: wunschStabilSeit,
  };

  const bleibt = (grund: string): BeruhigungsErgebnis => ({
    senden: false,
    stromA: historie.gesetztA,
    grund,
    historie: fortgeschrieben,
  });

  if (wunschA === historie.gesetztA) {
    return bleibt('Sollwert unverändert.');
  }

  const runter = wunschA < historie.gesetztA;
  const stabilMs = jetztMs - wunschStabilSeit;
  const seitBefehlMs = jetztMs - historie.gesetztAtMs;

  // ── Notbremse ────────────────────────────────────────────────────────────
  // Es fliesst wirklich Strom aus dem Netz. Jede Frist tritt zurück.
  const notfall = runter && netzbezugW > zeit.notbremseAbW;
  if (notfall) {
    return senden(wunschA, jetztMs, fortgeschrieben,
      `Netzbezug ${Math.round(netzbezugW)} W — sofort auf ${wunschA === 0 ? 'Pause' : `${wunschA} A`}.`);
  }

  // ── Totzone: Ein-Schritt-Zappeln unterdrücken ────────────────────────────
  // Nur wenn beide Werte echtes Laden sind. Start und Pause sind nie "ein
  // Schritt", die sollen die eigenen Fristen unten durchlaufen.
  //
  // Und nur, solange nichts nennenswertes aus dem Netz kommt: Beim Einspeisen
  // ist Ruhe die richtige Antwort, beim Beziehen nicht.
  const beidesLaedt = wunschA > 0 && historie.gesetztA > 0;
  const imRuhebereich =
    netzbezugW >= 0
      ? netzbezugW <= zeit.netzImportTotzoneW
      : -netzbezugW <= zeit.netzTotzoneW;
  if (beidesLaedt && Math.abs(wunschA - historie.gesetztA) <= 1 && imRuhebereich) {
    return bleibt(
      `Netz bei ${Math.round(netzbezugW)} W innerhalb der Totzone — ${historie.gesetztA} A bleibt.`,
    );
  }

  // ── Passende Haltezeit bestimmen ─────────────────────────────────────────
  let noetigMs: number;
  let was: string;
  if (wunschA === 0) {
    noetigMs = zeit.pausierenNachMs;
    was = 'Pause';
  } else if (historie.gesetztA === 0) {
    noetigMs = zeit.startenNachMs;
    was = `Start mit ${wunschA} A`;
  } else if (runter) {
    // Kommt Strom aus dem Netz, gilt die kurze Frist. Sonst die lange: Dann
    // ist nur die Einspeisung geschrumpft, und das kostet nichts.
    noetigMs =
      netzbezugW > zeit.netzImportTotzoneW ? zeit.senkenBeiBezugNachMs : zeit.senkenNachMs;
    was = `Senken auf ${wunschA} A`;
  } else {
    noetigMs = zeit.erhoehenNachMs;
    was = `Erhöhen auf ${wunschA} A`;
  }

  if (stabilMs < noetigMs) {
    const restS = Math.ceil((noetigMs - stabilMs) / 1000);
    return bleibt(`${was} vorgemerkt — noch ${restS} s Beobachtung.`);
  }

  // Der Mindestabstand gilt nur nach oben. Nach unten zu warten hiesse, sehenden
  // Auges Netzbezug zuzulassen - und die eine Regel dieser Anlage lautet, dass
  // das Auto niemals der Grund dafür sein darf. Ein Befehl zu viel ist billiger
  // als eine Minute am Netz.
  if (!runter && seitBefehlMs < zeit.mindestabstandMs) {
    const restS = Math.ceil((zeit.mindestabstandMs - seitBefehlMs) / 1000);
    return bleibt(`${was} wartet noch ${restS} s (Mindestabstand zwischen Befehlen).`);
  }

  return senden(wunschA, jetztMs, fortgeschrieben, `${was}.`);
}

function senden(
  stromA: number,
  jetztMs: number,
  historie: Reglerhistorie,
  grund: string,
): BeruhigungsErgebnis {
  return {
    senden: true,
    stromA,
    grund,
    historie: { ...historie, gesetztA: stromA, gesetztAtMs: jetztMs },
  };
}
