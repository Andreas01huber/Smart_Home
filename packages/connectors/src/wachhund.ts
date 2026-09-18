/**
 * Eine Zusage erzwingen, dass eine Zusicherung sich niemals ewig hinzieht.
 *
 * `Promise.race` allein reicht dafür nicht ganz: Ohne Aufräumen bliebe der
 * Timer nach einem schnellen Erfolg weiter aktiv, und der Prozess hätte einen
 * offenen Timer mehr, als er bräuchte. Hier wird beides sauber beendet.
 *
 * Der Grund, warum es das überhaupt gibt: An der echten Anlage blieb ein
 * einzelner Cloud-Aufruf hängen, obwohl jeder einzelne HTTP-Request selbst ein
 * Timeout hatte. Die Wallbox-Anzeige fror daraufhin über Stunden auf dem
 * letzten Stand ein — ohne Fehlermeldung, denn nichts hatte je fehlgeschlagen,
 * es war nur nie fertig geworden. `mitWachhund` erzwingt eine Antwort
 * spätestens nach `ms`, unabhängig davon, was mit `arbeit` passiert. Läuft sie
 * im Hintergrund doch noch zu Ende, ist das harmlos — hier interessiert nur,
 * dass der AUFRUFER nicht ewig wartet.
 */
export function mitWachhund<T>(arbeit: Promise<T>, ms: number, beiTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    let entschieden = false;
    const timer = setTimeout(() => {
      if (entschieden) return;
      entschieden = true;
      resolve(beiTimeout);
    }, ms);

    arbeit.then(
      (wert) => {
        if (entschieden) return;
        entschieden = true;
        clearTimeout(timer);
        resolve(wert);
      },
      () => {
        if (entschieden) return;
        entschieden = true;
        clearTimeout(timer);
        resolve(beiTimeout);
      },
    );
  });
}
