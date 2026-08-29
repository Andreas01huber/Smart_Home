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
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  clearCookie,
  createSessionToken,
  herkunftVon,
  istHttps,
  parseCookies,
  sicheresZiel,
  sessionCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  tokenAblauf,
  verifyPassword,
  verifySessionToken,
  type AuthSettings,
  type LoginThrottle,
} from './auth.ts';
import { readBody } from './http-util.ts';
import { loginPage } from './login-page.ts';

/** Ohne Sitzung erreichbar — mehr braucht die Anmeldeseite nicht. */
const OFFEN = new Set(['/favicon-64.png', '/apple-touch-icon.png']);

const KEIN_CACHE = 'no-store, no-cache, must-revalidate';

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

/**
 * Prüft eine Anfrage.
 *
 * Rückgabe `true`: weiterreichen an das normale Routing.
 * Rückgabe `false`: erledigt — die Antwort ist geschrieben oder wird gleich
 * geschrieben (beim Anmelden, das den Body erst lesen muss).
 */
export function authGate(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  settings: AuthSettings,
  throttle: LoginThrottle,
): boolean {
  const sicher = istHttps(request.headers);
  const kekse = parseCookies(request.headers.cookie);
  const token = kekse[SESSION_COOKIE];
  const angemeldet = verifySessionToken(token, settings);

  // ── Abmelden ──────────────────────────────────────────────────────────────
  if (url.pathname === '/logout') {
    leiteWeiter(response, '/login', clearCookie(sicher));
    return false;
  }

  // ── Anmeldeseite ──────────────────────────────────────────────────────────
  if (url.pathname === '/login') {
    if (request.method === 'GET') {
      // Wer schon angemeldet ist, hat auf der Anmeldeseite nichts zu suchen.
      if (angemeldet) {
        leiteWeiter(response, sicheresZiel(url.searchParams.get('redirect') ?? '/'));
        return false;
      }
      sendeSeite(
        response,
        200,
        loginPage({ redirect: sicheresZiel(url.searchParams.get('redirect') ?? '/') }),
      );
      return false;
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
        return false;
      }

      void readBody(request, 4_000)
        .then((body) => {
          const felder = new URLSearchParams(body);
          const username = felder.get('username') ?? '';
          const password = felder.get('password') ?? '';
          const ziel = sicheresZiel(felder.get('redirect') ?? '/');

          // Passwort IMMER prüfen, auch bei falschem Benutzernamen. Ein früher
          // Abbruch wäre messbar schneller und würde verraten, ob es den
          // Benutzernamen gibt.
          const passtPasswort = verifyPassword(password, settings.passwordHash);
          const passtName = username.normalize('NFKC') === settings.username.normalize('NFKC');

          if (!passtName || !passtPasswort) {
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
          leiteWeiter(response, ziel, sessionCookie(createSessionToken(settings), sicher));
        })
        .catch(() => {
          sendeSeite(response, 400, loginPage({ fehler: 'Anmeldung fehlgeschlagen.' }));
        });
      return false;
    }

    response.writeHead(405, { allow: 'GET, POST', 'cache-control': KEIN_CACHE });
    response.end();
    return false;
  }

  // ── Alles Übrige ──────────────────────────────────────────────────────────
  if (OFFEN.has(url.pathname)) return true;

  if (!angemeldet) {
    if (url.pathname.startsWith('/api/')) {
      // Kein Umleiten bei Schnittstellen: Ein 302 auf HTML würde im Browser als
      // kaputte Antwort ankommen. 401 kann die App auswerten und selbst zur
      // Anmeldung wechseln.
      response.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': KEIN_CACHE,
      });
      response.end(JSON.stringify({ error: 'Nicht angemeldet', login: '/login' }));
      return false;
    }
    const ziel = `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`;
    leiteWeiter(response, ziel);
    return false;
  }

  // Gültige Sitzung: in der zweiten Hälfte der Laufzeit verlängern. So bleibt
  // angemeldet, wer die App regelmässig benutzt, ohne dass bei jedem Aufruf ein
  // Set-Cookie mitgeschickt werden müsste.
  const ablauf = token === undefined ? null : tokenAblauf(token);
  if (ablauf !== null && ablauf - Date.now() < SESSION_TTL_MS / 2) {
    response.setHeader('set-cookie', sessionCookie(createSessionToken(settings), sicher));
  }

  return true;
}
