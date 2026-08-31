/**
 * Text so einsetzen, dass er Text bleibt.
 *
 * Benutzernamen kommen aus einem Formular und landen in der Anmeldeseite und in
 * der Verwaltung wieder im HTML. Ohne diese Umschrift wäre ein Name wie
 * `<img onerror=…>` kein Name mehr, sondern Code, den der Browser des nächsten
 * Betrachters ausführt.
 *
 * Eine gemeinsame Stelle, weil zwei Seiten sie brauchen — und weil eine zweite,
 * leicht abweichende Kopie genau die Art Fehler ist, die lange unbemerkt bleibt.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (zeichen) => ESCAPES[zeichen] ?? zeichen);
}
