/**
 * Die Schranke vor der App.
 *
 * Eine einzige Stelle entscheidet, ob eine Anfrage weitergereicht wird. Das ist
 * Absicht: Verteilte Prüfungen an vielen Endpunkten sind die klassische Quelle
 * für die eine vergessene Route, die dann offen steht. Alles, was nicht
 * ausdrücklich freigegeben ist, braucht eine gültige Sitzung.
 *
 * Freigegeben ist genau dreierlei: die Anmeldeseite, das Absenden des
 * Formulars und die beiden Bilder, die die Anmeldeseite selbst anzeigt.
 *
 * Neben "darf rein oder nicht" liefert die Schranke jetzt auch, WER hereinkommt.
 * Ohne diese Auskunft könnte weiter hinten niemand entscheiden, ob die
 * Verwaltung geöffnet werden darf.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  clearCookie,
  herkunftVon,
  istHttps,
  parseCookies,
  sicheresZiel,
  sessionCookie,
  SESSION_COOKIE,
  type LoginThrottle,
} from './auth.ts';
import type { Benutzer, Kontenspeicher } from './benutzer.ts';
import { readBody } from './http-util.ts';
import { loginPage } from './login-page.ts';
import { geraetName, type Sitzungsspeicher } from './sitzungen.ts';

/** Ohne Sitzung erreichbar — mehr braucht die Anmeldeseite nicht. */
const OFFEN = new Set(['/favicon-64.png', '/apple-touch-icon.png']);

const KEIN_CACHE = 'no-store, no-cache, must-revalidate';

/** Nach einer Woche wird der Keks im Browser erneuert, siehe `Sitzung.keksErneuert`. */
const KEKS_AUFFRISCHEN_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthKontext {
  readonly konten: Kontenspeicher;
  readonly sitzungen: Sitzungsspeicher;
  readonly throttle: LoginThrottle;
}

export interface GateErgebnis {
  /** `false` heisst: Die Antwort ist geschrieben (oder wird gleich geschrieben). */
  readonly weiter: boolean;
  /** Wer angemeldet ist. Nur gesetzt, wenn `weiter` gilt und Anmeldung aktiv ist. */
  readonly benutzer?: Benutzer;
  /** Welches Gerät. Gebraucht, um einen offenen Ereignisstrom beenden zu können. */
  readonly sitzungId?: string;
}

const DURCH: GateErgebnis = { weiter: false };

function sendeSeite(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': KEIN_CACHE,
    // Die Anmeldeseite gehört in keinen fremden Rahmen: Ein unsichtbares
    // iframe auf einer fremden Seite wäre sonst ein Weg, Klicks abzugreifen.
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
  });
  response.end(html);
}

function leiteWeiter(response: ServerResponse, ziel: string, cookie?: string): void {
  response.writeHead(302, {
    location: ziel,
    'cache-control': KEIN_CACHE,
    ...(cookie === undefined ? {} : { 'set-cookie': cookie }),
  });
  response.end();
}

export function authGate(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  kontext: AuthKontext,
): GateErgebnis {
  const { konten, sitzungen, throttle } = kontext;
  const sicher = istHttps(request.headers);
  const kekse = parseCookies(request.headers.cookie);
  const token = kekse[SESSION_COOKIE];

  // Sitzung auflösen. Ein gelöschtes Konto zieht seine Geräte mit: Der Keks ist
  // noch echt, aber es gibt niemanden mehr, zu dem er gehört.
  const sitzung = sitzungen.pruefe(token);
  let ich: Benutzer | null = null;
  if (sitzung) {
    ich = konten.nachId(sitzung.benutzerId);
    if (!ich) sitzungen.beende(sitzung.id);
  }

  // ── Abmelden ──────────────────────────────────────────────────────────────
  if (url.pathname === '/logout') {
    if (sitzung) sitzungen.beende(sitzung.id);
    leiteWeiter(response, '/login', clearCookie(sicher));
    return DURCH;
  }

  // ── Anmeldeseite ──────────────────────────────────────────────────────────
  if (url.pathname === '/login') {
    if (request.method === 'GET') {
      // Wer schon angemeldet ist, hat auf der Anmeldeseite nichts zu suchen.
      if (ich) {
        leiteWeiter(response, sicheresZiel(url.searchParams.get('redirect') ?? '/'));
        return DURCH;
      }
      sendeSeite(
        response,
        200,
        loginPage({ redirect: sicheresZiel(url.searchParams.get('redirect') ?? '/') }),
      );
      return DURCH;
    }

    if (request.method === 'POST') {
      const herkunft = herkunftVon(request.headers, request.socket.remoteAddress);
      const sperre = throttle.gesperrtFuer(herkunft);
      if (sperre > 0) {
        const minuten = Math.ceil(sperre / 60_000);
        sendeSeite(
          response,
          429,
          loginPage({
            fehler: `Zu viele Fehlversuche. Bitte in ${minuten} Minute${minuten === 1 ? '' : 'n'} erneut versuchen.`,
          }),
        );
        return DURCH;
      }

      void readBody(request, 4_000)
        .then((body) => {
          const felder = new URLSearchParams(body);
          const username = felder.get('username') ?? '';
          const password = felder.get('password') ?? '';
          const ziel = sicheresZiel(felder.get('redirect') ?? '/');

          // `anmelden` prüft das Passwort auch dann, wenn es den Benutzernamen
          // gar nicht gibt. Ein früher Abbruch wäre messbar schneller und würde
          // verraten, welche Konten existieren.
          const angemeldet = konten.anmelden(username, password);

          if (!angemeldet) {
            throttle.fehlversuch(herkunft);
            sendeSeite(
              response,
              401,
              loginPage({
                redirect: ziel,
                username,
                fehler: 'Benutzername oder Passwort stimmt nicht.',
              }),
            );
            return;
          }

          throttle.erfolg(herkunft);
          const neuerKeks = sitzungen.neu(
            angemeldet.id,
            geraetName(
              typeof request.headers['user-agent'] === 'string'
                ? request.headers['user-agent']
                : undefined,
            ),
            herkunft,
          );
          leiteWeiter(response, ziel, sessionCookie(neuerKeks, sicher));
        })
        .catch(() => {
          sendeSeite(response, 400, loginPage({ fehler: 'Anmeldung fehlgeschlagen.' }));
        });
      return DURCH;
    }

    response.writeHead(405, { allow: 'GET, POST', 'cache-control': KEIN_CACHE });
    response.end();
    return DURCH;
  }

  // ── Alles Übrige ──────────────────────────────────────────────────────────
  if (OFFEN.has(url.pathname)) return { weiter: true };

  if (!ich || !sitzung) {
    if (url.pathname.startsWith('/api/')) {
      // Kein Umleiten bei Schnittstellen: Ein 302 auf HTML würde im Browser als
      // kaputte Antwort ankommen. 401 kann die App auswerten und selbst zur
      // Anmeldung wechseln.
      response.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': KEIN_CACHE,
      });
      response.end(JSON.stringify({ error: 'Nicht angemeldet', login: '/login' }));
      return DURCH;
    }
    const ziel = `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`;
    leiteWeiter(response, ziel);
    return DURCH;
  }

  // Gültige Sitzung: den Keks gelegentlich erneuern. Die Sitzung selbst gleitet
  // auf dem Server mit jedem Zugriff mit, der Keks im Browser tut das nicht — er
  // liefe ein Jahr nach dem Setzen ab, auch bei täglicher Benutzung.
  if (token !== undefined && Date.now() - sitzung.keksErneuert > KEKS_AUFFRISCHEN_MS) {
    response.setHeader('set-cookie', sessionCookie(token, sicher));
    sitzungen.keksAufgefrischt(sitzung.id);
  }

  return { weiter: true, benutzer: ich, sitzungId: sitzung.id };
}
