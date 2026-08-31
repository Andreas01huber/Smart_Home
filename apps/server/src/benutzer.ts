/**
 * Konten und Rollen.
 *
 * Warum es das gibt: Bisher gab es genau ein Konto — Benutzername und Passwort
 * lagen direkt unter `auth` in secrets.json. Das reicht, solange nur eine Person
 * zugreift. Sobald mehrere Leute die Adresse benutzen, will man wissen, wer
 * gerade angemeldet ist, und einzelnen Personen den Zugang geben oder wieder
 * nehmen können, ohne allen anderen ein neues Passwort mitteilen zu müssen.
 *
 * Zwei Rollen, mehr nicht:
 *
 *   admin     — darf zusätzlich die Verwaltung öffnen: Konten anlegen, Passwörter
 *               setzen, Geräte abmelden.
 *   benutzer  — sieht das Dashboard, sonst nichts.
 *
 * Feinere Rechte wären hier Ballast. Das ist ein Familien-Dashboard, keine
 * Firmenanwendung.
 *
 * Gespeichert wird in secrets.json, aus demselben Grund wie bisher: Die Datei
 * ist über .gitignore ausgeschlossen, wird vom Deploy ausdrücklich nicht
 * überschrieben und landet damit weder im Repository noch auf GitHub. Passwörter
 * stehen auch dort nur als scrypt-Hash.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { hashPassword, verifyPassword } from './auth.ts';
import { writeJsonAtomic } from './persist.ts';

export type Rolle = 'admin' | 'benutzer';

/**
 * Mindestlänge des Passworts.
 *
 * Über den Tunnel ist die Adresse öffentlich erreichbar. Kurze Passwörter sind
 * dort in überschaubarer Zeit durchprobiert — die Bremse in `LoginThrottle`
 * verlangsamt das, verhindert es aber nicht auf Dauer.
 */
export const MINDESTLAENGE_PASSWORT = 10;

export interface Benutzer {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly rolle: Rolle;
  /** ISO-Zeitpunkt. */
  readonly angelegtAm: string;
  /** Benutzername dessen, der das Konto angelegt hat. `null` beim ersten Konto. */
  readonly angelegtVon: string | null;
  /** ISO-Zeitpunkt der letzten erfolgreichen Anmeldung, `null` wenn noch nie. */
  readonly letzteAnmeldung: string | null;
}

export interface AuthDaten {
  /** Schlüssel, mit dem Sitzungskekse signiert werden. */
  readonly sessionSecret: string;
  readonly benutzer: readonly Benutzer[];
}

/** Warum eine Änderung abgelehnt wurde. Der Text dazu steht in der Oberfläche. */
export type Fehler =
  | 'name-ungueltig'
  | 'name-vergeben'
  | 'passwort-kurz'
  | 'passwort-verschieden'
  | 'unbekannt'
  | 'letzter-admin'
  | 'selbst';

export type Ergebnis =
  | { readonly ok: true; readonly benutzer: Benutzer }
  | { readonly ok: false; readonly fehler: Fehler };

/**
 * Erlaubte Benutzernamen.
 *
 * Buchstaben (auch Umlaute), Ziffern, Leerzeichen, Punkt, Strich, Unterstrich.
 * Bewusst eng: Der Name landet in HTML und in Protokollzeilen, und was gar nicht
 * erst hineinkommt, muss dort auch nicht mühsam entschärft werden.
 */
const NAME_MUSTER = /^[\p{L}\p{N} ._-]{2,32}$/u;

function jetztIso(): string {
  return new Date().toISOString();
}

function neueId(): string {
  return randomBytes(9).toString('base64url');
}

/**
 * Namen vergleichbar machen.
 *
 * Ohne das könnten "Andreas" und "andreas" zwei verschiedene Konten sein — für
 * jeden, der sie sieht, dasselbe, für den Server nicht. Das ist keine
 * theoretische Sorge: Handytastaturen setzen den ersten Buchstaben von selbst
 * gross.
 */
function schluessel(name: string): string {
  return name.normalize('NFKC').trim().toLocaleLowerCase('de-DE');
}

export function nameGueltig(name: string): boolean {
  return NAME_MUSTER.test(name.normalize('NFKC').trim());
}

export function passwortGueltig(passwort: string): boolean {
  return passwort.length >= MINDESTLAENGE_PASSWORT;
}

export function findeBenutzer(daten: AuthDaten, name: string): Benutzer | null {
  const gesucht = schluessel(name);
  return daten.benutzer.find((b) => schluessel(b.username) === gesucht) ?? null;
}

export function zaehleAdmins(daten: AuthDaten): number {
  return daten.benutzer.filter((b) => b.rolle === 'admin').length;
}

/**
 * Vergleichs-Hash für Anmeldeversuche auf einen Namen, den es nicht gibt.
 *
 * Ohne ihn wäre ein falscher Benutzername messbar schneller beantwortet als ein
 * falsches Passwort — und damit liesse sich von aussen herausfinden, welche
 * Konten existieren. Erst beim ersten Fehlversuch erzeugt, damit der Start des
 * Servers nicht unnötig 100 ms länger dauert.
 */
let blindHash: string | null = null;

export function pruefeAnmeldung(
  daten: AuthDaten,
  name: string,
  passwort: string,
): Benutzer | null {
  const kandidat = findeBenutzer(daten, name);
  if (!kandidat) {
    blindHash ??= hashPassword(randomBytes(16).toString('hex'));
    verifyPassword(passwort, blindHash);
    return null;
  }
  return verifyPassword(passwort, kandidat.passwordHash) ? kandidat : null;
}

// ── Lesen aus secrets.json ──────────────────────────────────────────────────

function leseBenutzer(roh: unknown): Benutzer | null {
  if (typeof roh !== 'object' || roh === null) return null;
  const r = roh as Record<string, unknown>;
  const username = typeof r['username'] === 'string' ? r['username'] : '';
  const passwordHash = typeof r['passwordHash'] === 'string' ? r['passwordHash'] : '';
  if (username.length === 0 || passwordHash.length === 0) return null;
  return {
    id: typeof r['id'] === 'string' && r['id'].length > 0 ? r['id'] : neueId(),
    username,
    passwordHash,
    rolle: r['rolle'] === 'admin' ? 'admin' : 'benutzer',
    angelegtAm: typeof r['angelegtAm'] === 'string' ? r['angelegtAm'] : jetztIso(),
    angelegtVon: typeof r['angelegtVon'] === 'string' ? r['angelegtVon'] : null,
    letzteAnmeldung: typeof r['letzteAnmeldung'] === 'string' ? r['letzteAnmeldung'] : null,
  };
}

/**
 * Liest den `auth`-Abschnitt und bringt ihn auf den heutigen Stand.
 *
 * Drei Fälle sind zu bedienen:
 *
 *   1. Die alte Form `{ username, passwordHash, sessionSecret }` — daraus wird
 *      ein einzelnes Admin-Konto. Wer bisher ein Passwort gesetzt hatte, ist
 *      danach Administrator, ohne etwas tun zu müssen.
 *   2. Die neue Form mit `benutzer: [...]`.
 *   3. Gar nichts oder Unbrauchbares — dann `null`, und der Server läuft wie
 *      bisher ohne Anmeldung weiter.
 *
 * Fehlt das Sitzungsgeheimnis oder ist es zu kurz, wird ein neues erzeugt. Das
 * meldet alle Geräte ab; das ist der richtige Ausgang, denn ohne belastbares
 * Geheimnis wären die bestehenden Kekse ohnehin nichts wert.
 */
export function leseAuth(roh: unknown): AuthDaten | null {
  if (typeof roh !== 'object' || roh === null) return null;
  const r = roh as Record<string, unknown>;

  const liste: Benutzer[] = [];
  if (Array.isArray(r['benutzer'])) {
    for (const eintrag of r['benutzer']) {
      const b = leseBenutzer(eintrag);
      if (b && !liste.some((v) => schluessel(v.username) === schluessel(b.username))) {
        liste.push(b);
      }
    }
  } else {
    // Alte Form: ein Konto, direkt unter `auth`.
    const alt = leseBenutzer(r);
    if (alt) liste.push({ ...alt, rolle: 'admin' });
  }

  if (liste.length === 0) return null;

  // Ohne Administrator käme niemand mehr in die Verwaltung — dann lieber den
  // ältesten Eintrag befördern, als die Tür zumauern.
  if (!liste.some((b) => b.rolle === 'admin')) {
    liste[0] = { ...(liste[0] as Benutzer), rolle: 'admin' };
  }

  const geheim = r['sessionSecret'];
  const sessionSecret =
    typeof geheim === 'string' && geheim.length >= 32
      ? geheim
      : randomBytes(32).toString('hex');

  return { sessionSecret, benutzer: liste };
}

// ── Speicher ────────────────────────────────────────────────────────────────

function leseDatei(pfad: string): Record<string, unknown> {
  if (!existsSync(pfad)) return {};
  try {
    const roh: unknown = JSON.parse(readFileSync(pfad, 'utf8'));
    return typeof roh === 'object' && roh !== null ? (roh as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Die Konten, wie sie in secrets.json stehen — lesend und schreibend.
 *
 * Vor jedem Schreiben wird die Datei frisch gelesen und nur der Abschnitt `auth`
 * ersetzt. Grund: In derselben Datei stehen die Tuya-Zugangsdaten der Wallbox.
 * Würde hier ein beim Start eingelesener Stand zurückgeschrieben, verschwände
 * eine zwischenzeitliche Änderung daran stillschweigend.
 */
export class Kontenspeicher {
  private daten: AuthDaten;

  private constructor(
    private readonly pfad: string,
    daten: AuthDaten,
  ) {
    this.daten = daten;
  }

  /** `null` bedeutet: keine Anmeldung eingerichtet, der Server läuft offen. */
  static laden(pfad: string): Kontenspeicher | null {
    const datei = leseDatei(pfad);
    const daten = leseAuth(datei['auth']);
    if (daten === null) return null;

    const speicher = new Kontenspeicher(pfad, daten);
    // Kam der Stand aus der alten Form oder musste etwas ergänzt werden, gleich
    // in der neuen Form festhalten. Sonst liefe die Umwandlung bei jedem Start
    // erneut - und das frisch erzeugte Sitzungsgeheimnis wäre nach dem nächsten
    // Neustart wieder ein anderes, was alle Geräte abmelden würde.
    if (JSON.stringify(datei['auth']) !== JSON.stringify(speicher.alsJson())) {
      speicher.speichern();
    }
    return speicher;
  }

  /**
   * Wie `laden`, aber ohne vorhandenes Konto kommt ein leerer Speicher zurück
   * statt `null`.
   *
   * Für `npm run passwort`: Dort muss sich das allererste Konto anlegen lassen,
   * gerade weil es noch keines gibt. Der Server benutzt weiterhin `laden` — für
   * ihn ist "kein Konto" eine Aussage, kein Zustand zum Weiterarbeiten.
   */
  static ladenOderNeu(pfad: string): Kontenspeicher {
    return (
      Kontenspeicher.laden(pfad) ??
      new Kontenspeicher(pfad, {
        sessionSecret: randomBytes(32).toString('hex'),
        benutzer: [],
      })
    );
  }

  get sessionSecret(): string {
    return this.daten.sessionSecret;
  }

  alle(): readonly Benutzer[] {
    return [...this.daten.benutzer].sort((a, b) => a.username.localeCompare(b.username, 'de'));
  }

  nachId(id: string): Benutzer | null {
    return this.daten.benutzer.find((b) => b.id === id) ?? null;
  }

  nachName(name: string): Benutzer | null {
    return findeBenutzer(this.daten, name);
  }

  anzahl(): number {
    return this.daten.benutzer.length;
  }

  adminAnzahl(): number {
    return zaehleAdmins(this.daten);
  }

  /** Prüft Name und Passwort und vermerkt bei Erfolg den Zeitpunkt. */
  anmelden(name: string, passwort: string): Benutzer | null {
    const treffer = pruefeAnmeldung(this.daten, name, passwort);
    if (!treffer) return null;
    const aktualisiert: Benutzer = { ...treffer, letzteAnmeldung: jetztIso() };
    this.ersetze(aktualisiert);
    this.speichern();
    return aktualisiert;
  }

  anlegen(wunsch: {
    readonly username: string;
    readonly passwort: string;
    readonly rolle: Rolle;
    readonly angelegtVon: string | null;
  }): Ergebnis {
    const username = wunsch.username.normalize('NFKC').trim();
    if (!nameGueltig(username)) return { ok: false, fehler: 'name-ungueltig' };
    if (findeBenutzer(this.daten, username)) return { ok: false, fehler: 'name-vergeben' };
    if (!passwortGueltig(wunsch.passwort)) return { ok: false, fehler: 'passwort-kurz' };

    const neu: Benutzer = {
      id: neueId(),
      username,
      passwordHash: hashPassword(wunsch.passwort),
      rolle: wunsch.rolle,
      angelegtAm: jetztIso(),
      angelegtVon: wunsch.angelegtVon,
      letzteAnmeldung: null,
    };
    this.daten = { ...this.daten, benutzer: [...this.daten.benutzer, neu] };
    this.speichern();
    return { ok: true, benutzer: neu };
  }

  passwortSetzen(id: string, passwort: string): Ergebnis {
    const vorhanden = this.nachId(id);
    if (!vorhanden) return { ok: false, fehler: 'unbekannt' };
    if (!passwortGueltig(passwort)) return { ok: false, fehler: 'passwort-kurz' };
    const neu: Benutzer = { ...vorhanden, passwordHash: hashPassword(passwort) };
    this.ersetze(neu);
    this.speichern();
    return { ok: true, benutzer: neu };
  }

  /**
   * Rolle ändern.
   *
   * Der letzte Administrator kann sich nicht selbst zurückstufen. Sonst wäre die
   * Verwaltung mit einem Klick unerreichbar, und der einzige Weg zurück führte
   * über die Konsole des Servers.
   */
  rolleSetzen(id: string, rolle: Rolle): Ergebnis {
    const vorhanden = this.nachId(id);
    if (!vorhanden) return { ok: false, fehler: 'unbekannt' };
    if (vorhanden.rolle === 'admin' && rolle !== 'admin' && this.adminAnzahl() <= 1) {
      return { ok: false, fehler: 'letzter-admin' };
    }
    const neu: Benutzer = { ...vorhanden, rolle };
    this.ersetze(neu);
    this.speichern();
    return { ok: true, benutzer: neu };
  }

  loeschen(id: string): Ergebnis {
    const vorhanden = this.nachId(id);
    if (!vorhanden) return { ok: false, fehler: 'unbekannt' };
    if (vorhanden.rolle === 'admin' && this.adminAnzahl() <= 1) {
      return { ok: false, fehler: 'letzter-admin' };
    }
    this.daten = {
      ...this.daten,
      benutzer: this.daten.benutzer.filter((b) => b.id !== id),
    };
    this.speichern();
    return { ok: true, benutzer: vorhanden };
  }

  private ersetze(benutzer: Benutzer): void {
    this.daten = {
      ...this.daten,
      benutzer: this.daten.benutzer.map((b) => (b.id === benutzer.id ? benutzer : b)),
    };
  }

  private alsJson(): unknown {
    return { sessionSecret: this.daten.sessionSecret, benutzer: this.daten.benutzer };
  }

  private speichern(): void {
    const datei = leseDatei(this.pfad);
    writeJsonAtomic(this.pfad, { ...datei, auth: this.alsJson() }, 2);
  }
}
