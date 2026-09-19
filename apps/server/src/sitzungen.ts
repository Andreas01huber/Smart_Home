/**
 * Angemeldete Geräte.
 *
 * Bisher war die Sitzung ein rein gerechneter Keks: Ablaufzeitpunkt plus HMAC,
 * ohne dass der Server sich etwas merken musste. Das ist sparsam, kann aber zwei
 * Dinge grundsätzlich nicht, die jetzt gebraucht werden:
 *
 *   - sagen, WER gerade angemeldet ist (ein gerechneter Keks hinterlässt nichts,
 *     woran man ihn wiedererkennen könnte);
 *   - ein einzelnes Gerät abmelden, ohne alle anderen mitzunehmen.
 *
 * Deshalb liegt hier eine Liste. Der Keks enthält nur noch eine Zufallszahl und
 * deren Signatur; alles Weitere — zu wem sie gehört, seit wann, von wo — steht
 * auf dem Server.
 *
 * Die Liste wird nach data/sitzungen.json geschrieben. Ohne das müsste sich nach
 * jedem Deploy jeder neu anmelden: Der Dienst startet dabei neu, und ein reiner
 * Arbeitsspeicher-Bestand wäre weg.
 *
 * Die Signatur ist keine Zierde. Sie sorgt dafür, dass ein geratener Keks
 * abgelehnt wird, ohne dass überhaupt in der Liste nachgesehen wird — und ein
 * gewechseltes Sitzungsgeheimnis macht mit einem Schlag alle Kekse ungültig.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { SESSION_TTL_MS } from './auth.ts';
import { bewahreBeschaedigt, writeJsonAtomic } from './persist.ts';

export interface Sitzung {
  readonly id: string;
  readonly benutzerId: string;
  /** Zeitpunkt der Anmeldung. */
  readonly angelegtAm: number;
  readonly letzterZugriff: number;
  readonly ablauf: number;
  /**
   * Wann der Keks zuletzt an den Browser geschickt wurde.
   *
   * Die Sitzung verlängert sich auf dem Server bei jedem Zugriff, der Keks im
   * Browser aber nicht: Der läuft ein Jahr nach dem Setzen ab, gleichgültig wie
   * oft die App benutzt wurde. Deshalb wird er von Zeit zu Zeit erneuert — und
   * dieses Feld sagt, wann das fällig ist.
   */
  readonly keksErneuert: number;
  /** Kurzform des User-Agent, z. B. "iPhone · Safari". */
  readonly geraet: string;
  /** IP-Adresse, aus der die Anmeldung kam. */
  readonly herkunft: string;
}

/**
 * Wie oft der Bestand höchstens geschrieben wird, wenn sich nur der Zeitpunkt
 * des letzten Zugriffs geändert hat.
 *
 * Das Dashboard fragt im Sekundentakt Werte ab. Jede dieser Anfragen berührt die
 * Sitzung — würde sie jedes Mal auf die Platte geschrieben, liefe die SSD ohne
 * Not heiss.
 */
const SCHREIBABSTAND_MS = 60_000;

/**
 * Lesbarer Gerätename aus dem User-Agent.
 *
 * Kein Versuch, den User-Agent vollständig zu deuten — das ist ein Fass ohne
 * Boden. Es reicht, dass in der Liste "iPhone · Safari" steht und nicht eine
 * Zeile aus 140 Zeichen, in der man das Gerät suchen muss.
 */
export function geraetName(userAgent: string | undefined): string {
  if (!userAgent || userAgent.trim().length === 0) return 'Unbekanntes Gerät';
  const ua = userAgent;

  const system =
    /iPhone/i.test(ua) ? 'iPhone'
    : /iPad/i.test(ua) ? 'iPad'
    : /Android/i.test(ua) ? 'Android'
    : /Windows/i.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/i.test(ua) ? 'Mac'
    : /CrOS/i.test(ua) ? 'ChromeOS'
    : /Linux/i.test(ua) ? 'Linux'
    : null;

  // Reihenfolge ist wichtig: Edge und Chrome tragen beide "Chrome" im
  // User-Agent, Chrome und Safari beide "Safari". Wer zuerst passt, gewinnt.
  const browser =
    /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Safari\//i.test(ua) ? 'Safari'
    : null;

  if (system && browser) return `${system} · ${browser}`;
  if (system) return system;
  if (browser) return browser;
  return ua.slice(0, 40);
}

interface Gespeichert {
  readonly version: number;
  readonly sitzungen: readonly Sitzung[];
}

export class Sitzungsspeicher {
  private readonly liste = new Map<string, Sitzung>();
  private letzteSchreibung = 0;
  private ungespeichert = false;
  /**
   * Ein Abmelden liess sich nicht dauerhaft festhalten.
   *
   * Dann gilt gar keine Sitzung mehr. Das ist die einzige Richtung, in der man
   * sich hier irren darf: Wer abmeldet — weil das Handy weg ist oder das
   * Passwort gewechselt wurde —, muss sich darauf verlassen können. Bliebe die
   * alte Datei liegen, wären die abgemeldeten Geräte nach dem nächsten Neustart
   * wieder angemeldet, und niemand hätte es gemerkt.
   */
  private gesperrt = false;

  /**
   * @param notfallMarker Datei an einem ZWEITEN Ort (neben secrets.json). Lässt
   *   sich ein Abmelden weder speichern noch die Sitzungsdatei löschen, wird dort
   *   ein Marker hinterlegt; beim nächsten Start gilt dann keine gespeicherte
   *   Sitzung. Erst ein erfolgreicher Schreiblauf räumt ihn wieder weg.
   */
  constructor(
    private readonly pfad: string,
    private readonly geheimnis: string,
    private readonly notfallMarker: string | null = null,
  ) {
    this.laden();
  }

  /** Für die Verwaltung: Ist der Bestand gesperrt, liegt ein Notfall-Marker? */
  betriebszustand(): { gesperrt: boolean; notfallMarker: boolean } {
    return {
      gesperrt: this.gesperrt,
      notfallMarker: this.notfallMarker !== null && existsSync(this.notfallMarker),
    };
  }

  private laden(): void {
    if (this.notfallMarker !== null && existsSync(this.notfallMarker)) {
      // Ein Abmelden konnte beim letzten Mal nicht gespeichert werden. Die
      // Datei darf deshalb nicht geglaubt werden — alle melden sich neu an.
      console.warn('Notfall-Marker für Sitzungen gefunden — alle Geräte müssen sich neu anmelden.');
      this.ungespeichert = true;
      return;
    }
    if (!existsSync(this.pfad)) return;
    try {
      const roh: unknown = JSON.parse(readFileSync(this.pfad, 'utf8'));
      const daten = roh as Partial<Gespeichert>;
      if (!Array.isArray(daten.sitzungen)) return;
      const jetzt = Date.now();
      for (const s of daten.sitzungen) {
        // Abgelaufenes gar nicht erst aufnehmen. Sonst wüchse die Datei mit
        // jedem alten Handy, das nie wieder auftaucht.
        if (typeof s?.id === 'string' && typeof s.ablauf === 'number' && s.ablauf > jetzt) {
          this.liste.set(s.id, {
            ...s,
            keksErneuert: typeof s.keksErneuert === 'number' ? s.keksErneuert : s.angelegtAm,
          });
        }
      }
    } catch {
      // Kaputte Datei: lieber alle neu anmelden lassen als beim Start stehen
      // bleiben. Der Bestand ist Bequemlichkeit, keine wertvollen Daten — die
      // Datei selbst bleibt trotzdem erhalten, damit sich hinterher klären
      // lässt, warum plötzlich alle abgemeldet waren.
      bewahreBeschaedigt(this.pfad);
    }
  }

  private signatur(id: string): string {
    return createHmac('sha256', this.geheimnis).update(id).digest('base64url');
  }

  /** Meldet ein Gerät an und gibt den Keks-Inhalt zurück. */
  neu(
    benutzerId: string,
    geraet: string,
    herkunft: string,
    now = Date.now(),
  ): string {
    const id = randomBytes(24).toString('base64url');
    this.liste.set(id, {
      id,
      benutzerId,
      angelegtAm: now,
      letzterZugriff: now,
      ablauf: now + SESSION_TTL_MS,
      keksErneuert: now,
      geraet,
      herkunft,
    });
    this.aufraeumen(now);
    this.schreiben(true);
    return `${id}.${this.signatur(id)}`;
  }

  /**
   * Prüft einen Keks. Bei Erfolg wird die Sitzung verlängert.
   *
   * Gibt es den geringsten Zweifel, ist die Antwort `null`.
   */
  pruefe(token: string | undefined, now = Date.now()): Sitzung | null {
    if (this.gesperrt || !token) return null;
    const punkt = token.lastIndexOf('.');
    if (punkt <= 0) return null;

    const id = token.slice(0, punkt);
    const erwartet = Buffer.from(this.signatur(id), 'utf8');
    const bekommen = Buffer.from(token.slice(punkt + 1), 'utf8');
    if (erwartet.length !== bekommen.length) return null;
    if (!timingSafeEqual(erwartet, bekommen)) return null;

    const sitzung = this.liste.get(id);
    if (!sitzung) return null;
    if (sitzung.ablauf <= now) {
      this.liste.delete(id);
      this.schreiben(true);
      return null;
    }

    // Gleitender Ablauf: Wer die App benutzt, bleibt angemeldet.
    const verlaengert: Sitzung = {
      ...sitzung,
      letzterZugriff: now,
      ablauf: now + SESSION_TTL_MS,
    };
    this.liste.set(id, verlaengert);
    this.schreiben(false);
    return verlaengert;
  }

  /**
   * Gibt es diese Sitzung noch?
   *
   * Ohne Signaturprüfung, weil die Kennung aus einer bereits geprüften Anfrage
   * stammt. Gedacht für den offenen Ereignisstrom, der nachfragen muss, ob sein
   * Gerät noch angemeldet ist.
   */
  gilt(id: string, now = Date.now()): boolean {
    if (this.gesperrt) return false;
    const sitzung = this.liste.get(id);
    return sitzung !== undefined && sitzung.ablauf > now;
  }

  /** Vermerkt, dass der Keks gerade neu gesetzt wurde. */
  keksAufgefrischt(id: string, now = Date.now()): void {
    const sitzung = this.liste.get(id);
    if (!sitzung) return;
    this.liste.set(id, { ...sitzung, keksErneuert: now });
    this.schreiben(false);
  }

  /** Alle Sitzungen, zuletzt benutzte zuerst. */
  alle(): readonly Sitzung[] {
    return [...this.liste.values()].sort((a, b) => b.letzterZugriff - a.letzterZugriff);
  }

  vonBenutzer(benutzerId: string): readonly Sitzung[] {
    return this.alle().filter((s) => s.benutzerId === benutzerId);
  }

  beende(id: string): boolean {
    const weg = this.liste.delete(id);
    if (weg) this.widerrufFesthalten();
    return weg;
  }

  /** Meldet alle Geräte eines Kontos ab — etwa nach einem Passwortwechsel. */
  beendeVonBenutzer(benutzerId: string): number {
    let anzahl = 0;
    for (const [id, s] of this.liste) {
      if (s.benutzerId === benutzerId) {
        this.liste.delete(id);
        anzahl += 1;
      }
    }
    if (anzahl > 0) this.widerrufFesthalten();
    return anzahl;
  }

  beendeAlle(): number {
    const anzahl = this.liste.size;
    this.liste.clear();
    this.widerrufFesthalten();
    return anzahl;
  }

  /**
   * Ein Abmelden dauerhaft festhalten — oder notfalls alles sperren.
   *
   * Ein gewöhnlicher Schreibfehler ist hier kein Schönheitsfehler: Die Sitzung
   * ist dann nur im Arbeitsspeicher weg, in der Datei steht sie weiter. Nach
   * dem nächsten Neustart wäre das abgemeldete Gerät wieder angemeldet — genau
   * dann, wenn es darauf ankommt (verlorenes Handy, gewechseltes Passwort).
   *
   * Deshalb hier drei Stufen, jede davon in die sichere Richtung:
   *
   *   1. Schreiben. Klappt das, ist alles gut.
   *   2. Die Datei löschen. Ohne Datei ist nach einem Neustart niemand
   *      angemeldet — unbequem, aber sicher.
   *   3. Einen Notfall-Marker an einem zweiten Ort schreiben. Er sorgt dafür,
   *      dass nach einem Neustart keine gespeicherte Sitzung gilt.
   *   4. Im laufenden Betrieb gilt keine Sitzung mehr.
   *
   * Grenze: Lässt sich an KEINEM Ort schreiben oder löschen, überlebt die
   * Sperre nur bis zum nächsten Neustart. Der Zustand steht deshalb deutlich
   * in der Verwaltung und in der Ausgabe; vor einem Neustart muss das
   * Datenverzeichnis repariert werden.
   */
  private widerrufFesthalten(): void {
    this.ungespeichert = true;
    if (this.persist()) return;

    try {
      rmSync(this.pfad, { force: true });
      console.warn(
        'Abmeldung liess sich nicht speichern — die Sitzungsdatei wurde gelöscht. '
          + 'Nach einem Neustart müssen sich alle Geräte neu anmelden.',
      );
      this.ungespeichert = false;
      return;
    } catch {
      /* Auch das Löschen ging nicht — nächste Stufe. */
    }

    if (this.notfallMarker !== null) {
      try {
        writeFileSync(this.notfallMarker, new Date().toISOString(), 'utf8');
        console.error('Abmeldung nicht speicherbar — Notfall-Marker gesetzt, nach Neustart gilt keine Sitzung.');
      } catch {
        /* Auch der zweite Ort ist nicht beschreibbar. */
      }
    }
    this.gesperrt = true;
    console.error(
      'Abmeldung liess sich weder speichern noch die Sitzungsdatei löschen. '
        + 'Es gilt ab sofort keine Sitzung mehr; bitte Datenverzeichnis prüfen.',
    );
  }

  private aufraeumen(now: number): void {
    for (const [id, s] of this.liste) {
      if (s.ablauf <= now) this.liste.delete(id);
    }
  }

  private schreiben(sofort: boolean): void {
    this.ungespeichert = true;
    const jetzt = Date.now();
    if (!sofort && jetzt - this.letzteSchreibung < SCHREIBABSTAND_MS) return;
    this.persist();
  }

  /** Schreibt den Bestand. Gibt zurück, ob er wirklich auf der Platte steht. */
  persist(): boolean {
    if (!this.ungespeichert) return true;
    const inhalt: Gespeichert = { version: 1, sitzungen: [...this.liste.values()] };
    try {
      writeJsonAtomic(this.pfad, inhalt);
      this.letzteSchreibung = Date.now();
      this.ungespeichert = false;
      // Der Bestand steht wieder ehrlich auf der Platte: Marker weg.
      if (this.notfallMarker !== null && existsSync(this.notfallMarker)) {
        try { rmSync(this.notfallMarker, { force: true }); } catch { /* bleibt, schadet nicht */ }
      }
      return true;
    } catch {
      // Lässt sich nicht schreiben (Platte voll, Rechte): Der Betrieb läuft aus
      // dem Arbeitsspeicher weiter. Erst ein Neustart kostet die Anmeldungen.
      // Beim Abmelden reicht das NICHT — siehe `widerrufFesthalten`.
      return false;
    }
  }
}
