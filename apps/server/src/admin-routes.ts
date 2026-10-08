/**
 * Die Aktionen der Verwaltung.
 *
 * Jede ist ein POST eines Formulars, das anschliessend wieder auf `/admin`
 * umleitet — mit einer kurzen Kennung in der Adresse, aus der die Seite ihre
 * Meldung baut. Das ist der Grund für das Umleiten statt einer direkten Antwort:
 * Ohne es würde ein Neuladen der Seite die Aktion ein zweites Mal ausführen.
 *
 * Alles hier setzt voraus, dass die Schranke bereits einen angemeldeten
 * Administrator festgestellt hat. Geprüft wird das trotzdem noch einmal — die
 * Rolle kann sich zwischen zwei Anfragen geändert haben, etwa weil ein anderer
 * Administrator sie gerade zurückgestuft hat.
 */

import { schreibstatus } from './persist.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { clearCookie, istHttps, vertrauterProxy } from './auth.ts';
import { adminPage } from './admin-page.ts';
import type { Benutzer, Kontenspeicher, Rolle } from './benutzer.ts';
import { herkunftErlaubt, KEIN_CACHE, leiteWeiter, readBody, sendeSeite } from './http-util.ts';
import type { Sitzungsspeicher } from './sitzungen.ts';
import type { Ereignisprotokoll } from './ereignisse.ts';

export interface AdminKontext {

  readonly konten: Kontenspeicher;
  readonly sitzungen: Sitzungsspeicher;
  readonly vertrauteProxies?: readonly string[];
  /** F�r die Anzeige der letzten Ereignisse und das Mitschreiben von Verwaltungsaktionen. */
  readonly ereignisse?: Ereignisprotokoll;
}


/** Zurück auf die Verwaltung, mit Meldung. */
function zurueck(
  response: ServerResponse,
  meldung: { readonly ok?: string; readonly fehler?: string; readonly wer?: string },
): void {
  const p = new URLSearchParams();
  if (meldung.ok) p.set('ok', meldung.ok);
  if (meldung.fehler) p.set('fehler', meldung.fehler);
  if (meldung.wer) p.set('wer', meldung.wer);
  const anhang = p.toString();
  leiteWeiter(response, anhang.length > 0 ? `/admin?${anhang}` : '/admin');
}

const VERBOTEN = `<!doctype html>
<html lang="de"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SmartHome — kein Zugriff</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.6">
<h1 style="font-size:1.2rem">Kein Zugriff</h1>
<p>Die Verwaltung ist Administratoren vorbehalten.</p>
<p><a href="/">Zurück zum Dashboard</a></p>
</body></html>`;

/**
 * Behandelt `/admin` und `/admin/…`.
 *
 * Rückgabe `true`: erledigt. `false`: keine Adresse der Verwaltung, das normale
 * Routing ist zuständig.
 */
export function adminRouten(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ich: Benutzer,
  kontext: AdminKontext,
): boolean {
  if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false;

  if (ich.rolle !== 'admin') {
    sendeSeite(response, 403, VERBOTEN);
    return true;
  }

  const { konten, sitzungen } = kontext;

  // ── Die Seite ─────────────────────────────────────────────────────────────
  if (url.pathname === '/admin') {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'cache-control': KEIN_CACHE });
      response.end();
      return true;
    }
    const ok = url.searchParams.get('ok');
    const fehler = url.searchParams.get('fehler');
    const wer = url.searchParams.get('wer');
    sendeSeite(
      response,
      200,
      adminPage({
        ich,
        benutzer: konten.alle(),
        sitzungen: sitzungen.alle(),
        ...(ok === null ? {} : { ok }),
        ...(fehler === null ? {} : { fehler }),
        ...(wer === null ? {} : { wer }),
        speicher: schreibstatus(),
        sitzungsbetrieb: sitzungen.betriebszustand(),
        ereignisse: kontext.ereignisse?.letzte(60) ?? [],
      }),
    );
    return true;
  }

  // ── Aktionen ──────────────────────────────────────────────────────────────
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST', 'cache-control': KEIN_CACHE });
    response.end();
    return true;
  }

  if (!herkunftErlaubt(request)) {
    zurueck(response, { fehler: 'abgelehnt' });
    return true;
  }

  void readBody(request, 8_000)
    .then((body) => {
      const felder = new URLSearchParams(body);
      const id = felder.get('id') ?? '';

      switch (url.pathname) {
        case '/admin/konto-anlegen': {
          const passwort = felder.get('passwort') ?? '';
          if (passwort !== (felder.get('passwort2') ?? '')) {
            zurueck(response, { fehler: 'passwort-verschieden' });
            return;
          }
          const ergebnis = konten.anlegen({
            username: felder.get('username') ?? '',
            passwort,
            rolle: felder.get('rolle') === 'admin' ? 'admin' : 'benutzer',
            angelegtVon: ich.username,
          });
          if (!ergebnis.ok) {
            zurueck(response, { fehler: ergebnis.fehler });
            return;
          }
          kontext.ereignisse?.notiere('konto.angelegt', `Konto  angelegt`, { von: ich.username });
          zurueck(response, { ok: 'angelegt', wer: ergebnis.benutzer.username });
          return;
        }

        case '/admin/passwort-setzen': {
          const passwort = felder.get('passwort') ?? '';
          if (passwort !== (felder.get('passwort2') ?? '')) {
            zurueck(response, { fehler: 'passwort-verschieden' });
            return;
          }
          const ergebnis = konten.passwortSetzen(id, passwort);
          if (!ergebnis.ok) {
            zurueck(response, { fehler: ergebnis.fehler });
            return;
          }
          // Ein neues Passwort soll etwas ändern. Bliebe das alte Handy
          // angemeldet, hätte der Wechsel genau die Wirkung nicht, wegen der
          // man ihn vornimmt.
          sitzungen.beendeVonBenutzer(id);
          kontext.ereignisse?.notiere('konto.passwort', `Passwort f�r  gesetzt`, { von: ich.username });
          zurueck(response, { ok: 'passwort', wer: ergebnis.benutzer.username });
          return;
        }

        case '/admin/rolle-setzen': {
          const rolle: Rolle = felder.get('rolle') === 'admin' ? 'admin' : 'benutzer';
          const ergebnis = konten.rolleSetzen(id, rolle);
          zurueck(
            response,
            ergebnis.ok
              ? { ok: 'rolle', wer: ergebnis.benutzer.username }
              : { fehler: ergebnis.fehler },
          );
          return;
        }

        case '/admin/konto-loeschen': {
          if (id === ich.id) {
            zurueck(response, { fehler: 'selbst' });
            return;
          }
          const ergebnis = konten.loeschen(id);
          if (!ergebnis.ok) {
            zurueck(response, { fehler: ergebnis.fehler });
            return;
          }
          sitzungen.beendeVonBenutzer(id);
          kontext.ereignisse?.notiere('konto.geloescht', `Konto  gel�scht`, { von: ich.username });
          zurueck(response, { ok: 'geloescht', wer: ergebnis.benutzer.username });
          return;
        }

        case '/admin/geraet-abmelden': {
          sitzungen.beende(id);
          kontext.ereignisse?.notiere('sitzung.beendet', 'Ger�t abgemeldet', { von: ich.username });
          zurueck(response, { ok: 'abgemeldet' });
          return;
        }

        case '/admin/alle-abmelden': {
          sitzungen.beendeAlle();
          kontext.ereignisse?.notiere('sitzung.alle-beendet', 'Alle Ger�te abgemeldet', { von: ich.username });
          // Das eigene Gerät ist mit abgemeldet. Direkt auf die Anmeldung
          // schicken, statt auf eine Seite, die sofort weiterleitet.
          leiteWeiter(response, '/login', clearCookie(istHttps(request.headers, vertrauterProxy(request.socket.remoteAddress, kontext.vertrauteProxies ?? []))));
          return;
        }

        default:
          response.writeHead(404, { 'cache-control': KEIN_CACHE });
          response.end();
      }
    })
    .catch(() => {
      zurueck(response, { fehler: 'abgelehnt' });
    });

  return true;
}
