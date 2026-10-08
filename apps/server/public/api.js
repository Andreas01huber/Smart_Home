/**
 * Datenzugriff der Oberfläche — eine Stelle für alle Anfragen.
 *
 * Vorher las jeder Aufruf `await (await fetch(x)).json()`: Ein 500 mit
 * HTML-Fehlerseite wurde zu einer Ausnahme ohne Aussage, ein 500 mit JSON
 * wurde ungeprüft als Daten übernommen, und zwei überlappende Tagesabfragen
 * konnten sich überholen — die langsame Antwort für "Gestern" landete dann
 * unter "Heute".
 *
 * Die Behandlung abgelaufener Sitzungen (401 → Anmeldung) liegt weiterhin im
 * umschlossenen `fetch` in app.js und greift auch hier.
 */

export class ApiFehler extends Error {
  /**
   * @param {string} message Satz, der sich so anzeigen lässt.
   * @param {number} status HTTP-Status, 0 bei fehlender Verbindung.
   */
  constructor(message, status) {
    super(message);
    this.name = 'ApiFehler';
    this.status = status;
  }
}

/** Eine Antwort, die inzwischen von einer neueren Anfrage überholt wurde. */
export class VeralteteAntwort extends Error {
  constructor() {
    super('Von einer neueren Anfrage überholt.');
    this.name = 'VeralteteAntwort';
  }
}

/** Überholt oder abgebrochen — kein Fehler für den Menschen. */
export function istUeberholt(fehler) {
  return fehler instanceof VeralteteAntwort || fehler?.name === 'AbortError';
}

/**
 * JSON holen und prüfen.
 *
 * Wirft `ApiFehler` mit einem anzeigbaren Satz, wenn keine Verbindung besteht,
 * der Server einen Fehlerstatus meldet oder die Antwort kein JSON-Objekt ist.
 */
export async function holeJson(pfad, optionen = {}, transport = fetch) {
  let antwort;
  try {
    antwort = await transport(pfad, optionen);
  } catch (fehler) {
    if (fehler?.name === 'AbortError') throw fehler;
    throw new ApiFehler('Keine Verbindung zum Server.', 0);
  }
  const typ = antwort.headers?.get?.('content-type') ?? '';
  let daten = null;
  if (typ.includes('application/json')) {
    try {
      daten = await antwort.json();
    } catch {
      daten = null;
    }
  }
  if (!antwort.ok) {
    const text = daten && typeof daten.error === 'string'
      ? daten.error
      : `Anfrage fehlgeschlagen (HTTP ${antwort.status}).`;
    throw new ApiFehler(text, antwort.status);
  }
  if (daten === null || typeof daten !== 'object' || Array.isArray(daten)) {
    throw new ApiFehler('Unerwartete Antwort vom Server.', antwort.status);
  }
  return daten;
}

/**
 * Eine Abfragefolge, in der nur die jeweils letzte Anfrage zählt.
 *
 * Jede neue Anfrage bricht die vorige ab; kommt eine ältere Antwort trotzdem
 * noch an, wird sie als `VeralteteAntwort` verworfen statt angezeigt.
 */
export function letzteAnfrage() {
  let zaehler = 0;
  let abbruch = null;
  return async (pfad, optionen = {}, transport = fetch) => {
    abbruch?.abort();
    const eigene = ++zaehler;
    abbruch = typeof AbortController === 'undefined' ? null : new AbortController();
    try {
      const daten = await holeJson(pfad, { ...optionen, ...(abbruch ? { signal: abbruch.signal } : {}) }, transport);
      if (eigene !== zaehler) throw new VeralteteAntwort();
      return daten;
    } catch (fehler) {
      // Auch ein verspäteter Fehler gehört zur alten Auswahl und darf die
      // inzwischen erfolgreich geladene Ansicht nicht wieder leeren.
      if (eigene !== zaehler) throw new VeralteteAntwort();
      throw fehler;
    }
  };
}
