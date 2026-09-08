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

export interface HausAnteil {
  /** Hausverbrauch ohne Auto, in Watt. `null` = nicht bestimmbar. */
  readonly wattW: number | null;
  /** Was davon dem Auto zugerechnet wurde. */
  readonly autoW: number;
  /** false = aus der gemerkten Grundlast geschätzt, nicht frisch gerechnet. */
  readonly frisch: boolean;
}

export class Hausverbrauch {
  private grundlastW: number | null = null;
  private grundlastAtMs = 0;

  /**
   * Aufteilen, was der Zähler misst.
   *
   * @param hausW   Hausverbrauch samt Auto, aus dem Zähler.
   * @param autoW   Ladeleistung laut Wallbox; `null`, wenn unbekannt.
   * @param jetztMs Jetzt-Zeitpunkt.
   */
  teile(hausW: number | null, autoW: number | null, jetztMs: number): HausAnteil {
    if (hausW === null || !Number.isFinite(hausW)) {
      return { wattW: null, autoW: 0, frisch: false };
    }
    const haus = Math.max(0, hausW);
    const auto = autoW !== null && Number.isFinite(autoW) ? Math.max(0, autoW) : 0;

    // Stimmig: Das Auto passt in den Zählerwert hinein. Das ist der Normalfall,
    // und er liefert die Grundlast frei Haus.
    if (auto <= haus) {
      this.grundlastW = haus - auto;
      this.grundlastAtMs = jetztMs;
      return { wattW: haus - auto, autoW: auto, frisch: true };
    }

    // Widerspruch. Die gemerkte Grundlast einsetzen — aber nie mehr, als der
    // Zähler überhaupt hergibt.
    const haltbar =
      this.grundlastW !== null && jetztMs - this.grundlastAtMs <= HALTBARKEIT_MS;
    if (!haltbar) return { wattW: null, autoW: 0, frisch: false };

    const basis = Math.min(this.grundlastW ?? 0, haus);
    return { wattW: basis, autoW: haus - basis, frisch: false };
  }
}
