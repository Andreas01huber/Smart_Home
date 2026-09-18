/**
 * Tests des Wachhunds gegen hängende Zusicherungen.
 *
 * Der Anlass: An der echten Anlage blieb ein Cloud-Aufruf hängen, obwohl jeder
 * einzelne HTTP-Request ein eigenes Timeout hatte — die Wallbox-Anzeige fror
 * über Stunden auf dem letzten Stand ein. Diese Tests stellen sicher, dass der
 * Wachhund genau das nicht mehr zulässt, ohne echte Netzwerkaufrufe zu
 * brauchen: eine hängende Zusicherung wird hier durch eine, die absichtlich
 * nie erfüllt wird, nachgestellt.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mitWachhund } from './wachhund.ts';

/** Eine Zusicherung, die absichtlich nie erfüllt wird — der nachgestellte Hänger. */
function haengtEwig<T>(): Promise<T> {
  return new Promise(() => {
    /* löst absichtlich nie auf */
  });
}

describe('mitWachhund', () => {
  it('liefert das Ergebnis, wenn die Arbeit rechtzeitig fertig wird', async () => {
    const ergebnis = await mitWachhund(Promise.resolve('fertig'), 50, 'zeit-abgelaufen');
    assert.equal(ergebnis, 'fertig');
  });

  it('greift ein, wenn die Arbeit hängen bleibt — der eigentliche Fall', async () => {
    const start = Date.now();
    const ergebnis = await mitWachhund(haengtEwig<string>(), 30, 'zeit-abgelaufen');
    assert.equal(ergebnis, 'zeit-abgelaufen');
    // Und zwar spätestens nach der eingestellten Zeit, nicht irgendwann später.
    assert.ok(Date.now() - start < 200, 'der Wachhund selbst hat zu lange gebraucht');
  });

  it('greift auch ein, wenn die Arbeit ablehnt statt zu hängen', async () => {
    const ergebnis = await mitWachhund(
      Promise.reject(new Error('Netzwerkfehler')),
      50,
      'ersatzwert',
    );
    assert.equal(ergebnis, 'ersatzwert');
  });

  it('wirft nichts nach aussen — der Aufrufer braucht kein eigenes try/catch', async () => {
    await assert.doesNotReject(mitWachhund(Promise.reject(new Error('x')), 20, null));
  });

  it('lässt eine spät ankommende Arbeit unbeachtet, statt ein zweites Ergebnis zu liefern', async () => {
    // Kommt die Arbeit NACH dem Timeout doch noch durch, darf das den bereits
    // gelieferten Ersatzwert nicht mehr verändern — genau das wäre in
    // `refresh()` sonst ein zweiter, überraschender Seiteneffekt.
    let aufgeloest: ((wert: string) => void) | null = null;
    const spaet = new Promise<string>((resolve) => { aufgeloest = resolve; });

    const ergebnisPromise = mitWachhund(spaet, 20, 'zeit-abgelaufen');
    const ergebnis = await ergebnisPromise;
    assert.equal(ergebnis, 'zeit-abgelaufen');

    // Jetzt kommt die ursprüngliche Arbeit doch noch an — mitWachhund selbst
    // hat dafür nichts mehr zu tun, es gibt nur diese eine Instanz von `await`.
    assert.doesNotThrow(() => aufgeloest?.('kommt zu spät'));
  });
});
