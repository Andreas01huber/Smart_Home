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
import { existsSync, readFileSync } from 'node:fs';

import { SESSION_TTL_MS } from './auth.ts';
import { writeJsonAtomic } from './persist.ts';

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

  constructor(
    private readonly pfad: string,
    private readonly geheimnis: string,
  ) {
    this.laden();
  }

  private laden(): void {
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
      // bleiben. Der Bestand ist Bequemlichkeit, keine wertvollen Daten.
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
    if (!token) return null;
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
    if (weg) this.schreiben(true);
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
    if (anzahl > 0) this.schreiben(true);
    return anzahl;
  }

  beendeAlle(): number {
    const anzahl = this.liste.size;
    this.liste.clear();
    this.schreiben(true);
    return anzahl;
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

  persist(): void {
    if (!this.ungespeichert) return;
    const inhalt: Gespeichert = { version: 1, sitzungen: [...this.liste.values()] };
    try {
      writeJsonAtomic(this.pfad, inhalt);
      this.letzteSchreibung = Date.now();
      this.ungespeichert = false;
    } catch {
      // Lässt sich nicht schreiben (Platte voll, Rechte): Der Betrieb läuft aus
      // dem Arbeitsspeicher weiter. Erst ein Neustart kostet die Anmeldungen.
    }
  }
}
