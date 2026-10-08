/**
 * Hausverbrauch ohne das Auto — belastbar, auch wenn die Wallbox nachhinkt.
 *
 * Die Aufgabe klingt nach einer Subtraktion und ist keine. `houseConsumptionW`
 * kommt aus dem Hauszähler und ist zwei Sekunden alt; die Ladeleistung kommt
 * über die Tuya-Cloud und ist manchmal eine halbe Minute alt. Beide beschreiben
 * denselben Moment nicht.
 *
 * Gemessen an der Anlage am 8.9.: Zähler 9338 W, Wallbox meldet 10 084 W. Die
 * blosse Subtraktion ergibt eine negative Zahl. Auf 0 gekappt behauptet sie ein
 * leeres Haus, ungekappt weggelassen zeigt sie einen Strich — und in beiden
 * Fällen flackert die grösste Zahl der Seite im Sekundentakt.
 *
 * Der Ausweg liegt darin, welche der beiden Grössen sich wie schnell ändert:
 *
 *   Die Ladeleistung springt. Von 4 auf 11 kW in einem Regelschritt.
 *   Die Grundlast des Hauses kriecht. Kühlschrank, Router, Licht, Heizung —
 *   das bewegt sich über Minuten, nicht über Sekunden.
 *
 * Gemerkt wird deshalb die GRUNDLAST, nicht die Ladeleistung. Passen beide
 * Messwerte zusammen, wird sie neu bestimmt und weggeschrieben. Passen sie
 * nicht zusammen, gilt die zuletzt bekannte weiter — und weil der Zähler
 * trotzdem frisch bleibt, wird ein Backrohr, das währenddessen angeht, sofort
 * sichtbar: Es steckt im Zählerwert und damit in der abgeleiteten Ladeleistung.
 *
 * Nach `HALTBARKEIT_MS` ohne stimmige Messung wird nichts mehr behauptet. Eine
 * Grundlast von vor einer Viertelstunde ist keine Auskunft mehr, sondern eine
 * Erinnerung.
 */

/**
 * Wie lange eine gemerkte Grundlast gilt.
 *
 * Zwei Minuten. Die beobachtete Verzögerung der Tuya-Cloud liegt bei Sekunden
 * bis zu einer knappen Minute; zwei Minuten decken das mit Abstand ab und sind
 * kurz genug, dass eine wirklich veränderte Grundlast nicht lange
 * durchgeschleppt wird.
 */
export const HALTBARKEIT_MS = 120_000;

/**
 * Kleine negative Zählerwerte sind Rauschen, grosse ein Messfehler.
 *
 * Ein berechneter Hausverbrauch kann durch Rundung der Einzelzähler knapp
 * unter null fallen; das ist kein Befund und wird auf 0 gesetzt. Deutlich
 * darunter stimmt an der Bilanz etwas nicht — dann gibt es keinen Wert.
 */
const RAUSCHEN_W = 50;

/**
 * Wie eine Zahl zustande kam.
 *
 *   gemessen    direkt aus einem Zähler oder einer stimmigen Differenz zweier
 *               Messungen
 *   geschaetzt  aus einer gemerkten Grundlast hergeleitet, weil die aktuellen
 *               Messungen sich widersprechen — befristet gültig
 *   unbekannt   es gibt keine belastbare Aussage; `w` ist dann immer `null`
 */
export type Wertart = 'gemessen' | 'geschaetzt' | 'unbekannt';

export interface Groesse {
  readonly w: number | null;
  readonly art: Wertart;
}

const UNBEKANNT: Groesse = { w: null, art: 'unbekannt' };

export interface HausAnteil {
  /** Hauszähler, Auto inklusive. */
  readonly hausGesamt: Groesse;
  readonly hausOhneAuto: Groesse;
  readonly auto: Groesse;
  /** Nur bei einer Schätzung: worauf sie beruht und wie lange sie gilt. */
  readonly schaetzung: {
    readonly grundlastW: number;
    readonly grundlastAmMs: number;
    readonly gueltigBisMs: number;
  } | null;
}

/** Eine gemerkte, stimmig gemessene Grundlast. */
export interface Grundlast {
  readonly w: number;
  readonly amMs: number;
}

/** Endlich, und nicht deutlich negativ; kleines Rauschen wird zu 0. */
function plausibelW(wert: number | null | undefined): number | null {
  if (typeof wert !== 'number' || !Number.isFinite(wert)) return null;
  if (wert < -RAUSCHEN_W) return null;
  return Math.max(0, wert);
}

/**
 * Die Aufteilung als reine Rechnung — ohne Gedächtnis, ohne Uhr.
 *
 * Grundsatz: Was unbekannt ist, bleibt unbekannt. Ein Hauszähler allein
 * beweist nicht, welchen Anteil das Auto verursacht; eine fehlende
 * Wallboxleistung wird deshalb weder zu 0 W noch zu "alles ist Haus".
 */
export function teileRein(
  hausW: number | null,
  autoW: number | null,
  jetztMs: number,
  grundlast: Grundlast | null,
): HausAnteil {
  const haus = plausibelW(hausW);
  const auto = plausibelW(autoW);
  const hausGesamt: Groesse = haus === null ? UNBEKANNT : { w: haus, art: 'gemessen' };

  // Ohne Zähler weiss man vom Auto trotzdem, was die Wallbox misst — nur
  // gegengeprüft ist es nicht, und vom Haus weiss man nichts.
  if (haus === null) {
    return {
      hausGesamt,
      hausOhneAuto: UNBEKANNT,
      auto: auto === null ? UNBEKANNT : { w: auto, art: 'gemessen' },
      schaetzung: null,
    };
  }
  if (auto === null) {
    return { hausGesamt, hausOhneAuto: UNBEKANNT, auto: UNBEKANNT, schaetzung: null };
  }

  // Stimmig: Das Auto passt in den Zählerwert hinein.
  if (auto <= haus) {
    return {
      hausGesamt,
      hausOhneAuto: { w: haus - auto, art: 'gemessen' },
      auto: { w: auto, art: 'gemessen' },
      schaetzung: null,
    };
  }

  // Widerspruch: Die Wallbox meldet mehr, als das ganze Haus verbraucht. Mit
  // frischer Grundlast lässt sich schätzen — gekennzeichnet und befristet.
  if (grundlast === null || jetztMs - grundlast.amMs > HALTBARKEIT_MS) {
    return { hausGesamt, hausOhneAuto: UNBEKANNT, auto: UNBEKANNT, schaetzung: null };
  }
  const basis = Math.min(grundlast.w, haus);
  return {
    hausGesamt,
    hausOhneAuto: { w: basis, art: 'geschaetzt' },
    auto: { w: haus - basis, art: 'geschaetzt' },
    schaetzung: {
      grundlastW: grundlast.w,
      grundlastAmMs: grundlast.amMs,
      gueltigBisMs: grundlast.amMs + HALTBARKEIT_MS,
    },
  };
}

/**
 * Das Gedächtnis dazu: eine Aufteilung pro Messzyklus.
 *
 * Früher rechnete jede Anzeige selbst nach — jeder offene Browser, jeder
 * Ereignisstrom und die Bilanz. Weil die Rechnung die Grundlast fortschreibt,
 * hing ihr Ergebnis davon ab, wie viele Geräte gerade zusahen. Jetzt wird je
 * Messzeitpunkt genau einmal gerechnet und das Ergebnis für alle aufgehoben.
 */
export class Hausverbrauch {
  private grundlast: Grundlast | null = null;
  private letzterZyklusMs = Number.NEGATIVE_INFINITY;
  private letzte: HausAnteil | null = null;

  /**
   * Die Aufteilung für den Messzeitpunkt `zyklusMs`.
   *
   * Derselbe Zeitpunkt liefert immer dasselbe Ergebnis, egal wie oft gefragt
   * wird. Ein älterer Zeitpunkt wird nur gerechnet, nicht gemerkt — er darf
   * das Gedächtnis nicht zurückdrehen.
   */
  fuerZyklus(zyklusMs: number, hausW: number | null, autoW: number | null): HausAnteil {
    if (zyklusMs === this.letzterZyklusMs && this.letzte !== null) return this.letzte;
    const anteil = teileRein(hausW, autoW, zyklusMs, this.grundlast);
    if (zyklusMs < this.letzterZyklusMs) return anteil;

    // Nur eine stimmige Messung beider Grössen ergibt eine neue Grundlast.
    if (anteil.hausOhneAuto.art === 'gemessen' && anteil.auto.art === 'gemessen') {
      this.grundlast = { w: anteil.hausOhneAuto.w ?? 0, amMs: zyklusMs };
    }
    this.letzterZyklusMs = zyklusMs;
    this.letzte = anteil;
    return anteil;
  }
}
