/**
 * Anmeldung und Sitzungen.
 *
 * Warum es das gibt: Solange das Dashboard nur im Heimnetz lief, war der Zugang
 * durch den Router geschützt. Über einen Tunnel (Cloudflare) ist die Adresse
 * öffentlich erreichbar — und die App hat schreibende Endpunkte (Tarife,
 * Reconnect). Ohne Anmeldung könnte sie jeder bedienen, der die Adresse kennt.
 *
 * Bewusst klein gehalten: ein Konto, keine Benutzerverwaltung, keine Datenbank.
 * Das ist ein privates Dashboard, keine Mehrbenutzer-Anwendung.
 *
 * Zwei Bausteine:
 *
 *   1. Das Passwort liegt NUR als scrypt-Hash in secrets.json. Wer die Datei
 *      liest, hat damit noch kein Passwort. scrypt ist absichtlich langsam und
 *      speicherhungrig, damit Ausprobieren teuer bleibt.
 *
 *   2. Die Sitzung ist ein signierter Keks ohne Serverspeicher: Ablaufzeitpunkt
 *      plus HMAC darüber. Das übersteht einen Neustart des Servers, ohne dass
 *      jemand neu anmelden muss — genau das, was bei einem Dienst erwünscht ist,
 *      der sich nach jedem Deploy neu startet.
 *
 * In die Signatur geht der Passwort-Hash mit ein. Folge: Ein geändertes Passwort
 * macht alle bestehenden Sitzungen ungültig, ohne dass irgendwo eine Liste
 * gepflegt werden müsste.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt-Parameter. Kostet ~100 ms pro Versuch - fuer eine Anmeldung nicht spürbar. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

/** Ein Jahr. Der Keks wird bei jedem Aufruf erneuert, siehe `sessionCookie`. */
export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'sh_session';

export interface AuthSettings {
  readonly username: string;
  readonly passwordHash: string;
  readonly sessionSecret: string;
}

// ── Passwort ────────────────────────────────────────────────────────────────

/** Erzeugt `scrypt$<salt>$<hash>`, beides base64url. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/**
 * Prüft ein Passwort gegen den gespeicherten Hash.
 *
 * Der Vergleich läuft über `timingSafeEqual`: Ein normaler Vergleich bricht beim
 * ersten falschen Byte ab, und aus der Antwortzeit liesse sich der Hash Byte für
 * Byte erraten.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const teile = stored.split('$');
  if (teile.length !== 3 || teile[0] !== 'scrypt') return false;
  const salt = Buffer.from(teile[1] ?? '', 'base64url');
  const erwartet = Buffer.from(teile[2] ?? '', 'base64url');
  if (salt.length === 0 || erwartet.length !== SCRYPT.keylen) return false;

  const key = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return timingSafeEqual(key, erwartet);
}

// ── Sitzung ─────────────────────────────────────────────────────────────────

function signature(secret: string, passwordHash: string, expiresAt: number): string {
  return createHmac('sha256', secret).update(`${expiresAt}.${passwordHash}`).digest('base64url');
}

/** Token für eine neue Sitzung: `<ablauf>.<signatur>`. */
export function createSessionToken(settings: AuthSettings, now = Date.now()): string {
  const expiresAt = now + SESSION_TTL_MS;
  return `${expiresAt}.${signature(settings.sessionSecret, settings.passwordHash, expiresAt)}`;
}

/** Prüft Signatur und Ablauf. Gibt es den geringsten Zweifel, ist die Antwort nein. */
export function verifySessionToken(
  token: string | undefined,
  settings: AuthSettings,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const punkt = token.lastIndexOf('.');
  if (punkt <= 0) return false;

  const expiresAt = Number(token.slice(0, punkt));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  const erwartet = Buffer.from(
    signature(settings.sessionSecret, settings.passwordHash, expiresAt),
    'utf8',
  );
  const bekommen = Buffer.from(token.slice(punkt + 1), 'utf8');
  if (erwartet.length !== bekommen.length) return false;
  return timingSafeEqual(erwartet, bekommen);
}

/**
 * Ablaufzeitpunkt eines Tokens, ohne die Signatur zu prüfen.
 *
 * Nur dafür gedacht zu entscheiden, ob ein gültiger Keks vorsorglich erneuert
 * wird. Über die Echtheit sagt das nichts aus — dafür ist `verifySessionToken`
 * zuständig, und die läuft vorher.
 */
export function tokenAblauf(token: string): number | null {
  const punkt = token.lastIndexOf('.');
  if (punkt <= 0) return null;
  const wert = Number(token.slice(0, punkt));
  return Number.isFinite(wert) ? wert : null;
}

/**
 * Ziel nach der Anmeldung, auf sichere Werte eingegrenzt.
 *
 * Ohne diese Prüfung wäre `/login?redirect=https://boese.example` eine offene
 * Weiterleitung: Der Link sähe aus wie die eigene Adresse, landete aber woanders.
 * Erlaubt ist deshalb nur ein Pfad auf diesem Server - und ausdrücklich nicht
 * `//host`, was der Browser als andere Adresse liest.
 */
export function sicheresZiel(roh: string | undefined): string {
  if (!roh || !roh.startsWith('/') || roh.startsWith('//')) return '/';
  if (roh.startsWith('/login')) return '/';
  return roh;
}

/**
 * Set-Cookie-Zeile für eine Sitzung.
 *
 * `secure` nur bei HTTPS: Im Heimnetz läuft das Dashboard über http://…:4173,
 * und ein Secure-Keks würde dort gar nicht erst gesendet. Über den Tunnel kommt
 * die Anfrage als HTTPS an, dann greift der Schutz.
 *
 * `SameSite=Lax` statt `Strict`, damit der Keks auch mitkommt, wenn die Adresse
 * aus einem Lesezeichen oder vom Startbildschirm aus geöffnet wird.
 */
export function sessionCookie(token: string, secure: boolean): string {
  const teile = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) teile.push('Secure');
  return teile.join('; ');
}

export function clearCookie(secure: boolean): string {
  const teile = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) teile.push('Secure');
  return teile.join('; ');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const teil of header.split(';')) {
    const gleich = teil.indexOf('=');
    if (gleich <= 0) continue;
    const name = teil.slice(0, gleich).trim();
    if (name) out[name] = teil.slice(gleich + 1).trim();
  }
  return out;
}

// ── Bremse gegen Durchprobieren ─────────────────────────────────────────────

/**
 * Verzögert wiederholte Fehlversuche je Herkunft.
 *
 * Im Heimnetz wäre das übertrieben, über einen öffentlichen Tunnel ist es
 * Pflicht: Ohne Bremse kann ein Angreifer beliebig viele Passwörter pro Sekunde
 * durchprobieren. Ab dem fünften Fehlversuch wird gesperrt, die Sperre
 * verdoppelt sich bis maximal eine Viertelstunde.
 */
export class LoginThrottle {
  private readonly versuche = new Map<string, { fehler: number; gesperrtBis: number }>();

  constructor(
    private readonly freiVersuche = 5,
    private readonly grundsperreMs = 60_000,
    private readonly maxSperreMs = 15 * 60_000,
  ) {}

  /** Verbleibende Sperrzeit in Millisekunden; 0 heisst: Versuch erlaubt. */
  gesperrtFuer(herkunft: string, now = Date.now()): number {
    const eintrag = this.versuche.get(herkunft);
    if (!eintrag) return 0;
    return Math.max(0, eintrag.gesperrtBis - now);
  }

  fehlversuch(herkunft: string, now = Date.now()): void {
    const eintrag = this.versuche.get(herkunft) ?? { fehler: 0, gesperrtBis: 0 };
    eintrag.fehler += 1;
    if (eintrag.fehler > this.freiVersuche) {
      const stufe = eintrag.fehler - this.freiVersuche - 1;
      eintrag.gesperrtBis = now + Math.min(this.grundsperreMs * 2 ** stufe, this.maxSperreMs);
    }
    this.versuche.set(herkunft, eintrag);
  }

  erfolg(herkunft: string): void {
    this.versuche.delete(herkunft);
  }
}

/**
 * Herkunft einer Anfrage.
 *
 * Hinter dem Tunnel steht in `remoteAddress` immer die lokale Adresse des
 * Tunnels - ohne den Cloudflare-Kopf wären alle Anfragen aus dem Internet
 * dieselbe Herkunft, und ein einziger Angreifer würde die ganze Welt aussperren.
 */
export function herkunftVon(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  remoteAddress: string | undefined,
): string {
  const cf = headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) return cf;
  const weiter = headers['x-forwarded-for'];
  if (typeof weiter === 'string' && weiter.length > 0) {
    return (weiter.split(',')[0] ?? weiter).trim();
  }
  return remoteAddress ?? 'unbekannt';
}

/** Kam die Anfrage über HTTPS herein? Hinter dem Tunnel sagt das nur der Kopf. */
export function istHttps(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): boolean {
  const proto = headers['x-forwarded-proto'];
  if (typeof proto === 'string') return proto.split(',')[0]?.trim() === 'https';
  return false;
}
