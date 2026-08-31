/**
 * Die Verwaltung.
 *
 * Zeigt, wer gerade angemeldet ist und mit welchem Gerät, und lässt Konten
 * anlegen, ändern und löschen.
 *
 * Wie die Anmeldeseite eine in sich geschlossene Seite ohne styles.css und ohne
 * app.js. Das hat zwei Gründe: Sie muss auch dann bedienbar sein, wenn am
 * Dashboard gerade etwas kaputt ist — und sie kommt vollständig ohne
 * JavaScript aus. Jede Aktion ist ein Formular, das abschickt und
 * zurückkommt; nichts hängt daran, dass ein Skript geladen hat.
 *
 * Gegen fremde Formulare schützt zweierlei: Der Sitzungskeks ist `SameSite=Lax`
 * und wird bei einem POST von einer fremden Seite gar nicht erst mitgeschickt,
 * und `admin-routes.ts` prüft zusätzlich die Herkunft.
 */

import { esc } from './html.ts';
import type { Benutzer } from './benutzer.ts';
import type { Sitzung } from './sitzungen.ts';

export interface AdminAnsicht {
  readonly ich: Benutzer;
  readonly benutzer: readonly Benutzer[];
  readonly sitzungen: readonly Sitzung[];
  readonly ok?: string;
  readonly fehler?: string;
  /** Name, um den es in der Meldung geht. */
  readonly wer?: string;
}

const OK_TEXTE: Readonly<Record<string, string>> = {
  angelegt: 'Konto angelegt.',
  geloescht: 'Konto gelöscht — alle Geräte dieses Kontos sind abgemeldet.',
  passwort: 'Neues Passwort gesetzt. Alle Geräte dieses Kontos müssen sich neu anmelden.',
  rolle: 'Rolle geändert.',
  abgemeldet: 'Gerät abgemeldet.',
  'alle-abgemeldet': 'Alle Geräte wurden abgemeldet.',
};

const FEHLER_TEXTE: Readonly<Record<string, string>> = {
  'name-ungueltig':
    'Benutzername nicht erlaubt: 2 bis 32 Zeichen, nur Buchstaben, Ziffern, Leerzeichen, Punkt, Strich, Unterstrich.',
  'name-vergeben': 'Diesen Benutzernamen gibt es schon.',
  'passwort-kurz': 'Das Passwort ist zu kurz — mindestens 10 Zeichen.',
  'passwort-verschieden': 'Die beiden Passwörter stimmen nicht überein.',
  unbekannt: 'Dieses Konto gibt es nicht mehr.',
  'letzter-admin':
    'Das ist der letzte Administrator. Erst jemand anderen zum Administrator machen, dann geht es.',
  selbst: 'Das eigene Konto lässt sich hier nicht löschen.',
  abgelehnt: 'Die Anfrage kam nicht von dieser Seite und wurde abgelehnt.',
};

function zeitpunkt(wert: number | string | null): string {
  if (wert === null) return '—';
  const d = new Date(wert);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "vor 5 Minuten", bis hinauf zu Tagen — für "zuletzt aktiv". */
function seit(zeit: number, jetzt = Date.now()): string {
  const s = Math.max(0, Math.round((jetzt - zeit) / 1000));
  if (s < 90) return 'gerade eben';
  const min = Math.round(s / 60);
  if (min < 60) return `vor ${min} Minuten`;
  const std = Math.round(min / 60);
  if (std === 1) return 'vor 1 Stunde';
  if (std < 36) return `vor ${std} Stunden`;
  const tage = Math.round(std / 24);
  return tage === 1 ? 'vor 1 Tag' : `vor ${tage} Tagen`;
}

function meldung(ansicht: AdminAnsicht): string {
  const wer = ansicht.wer ? ` <strong>${esc(ansicht.wer)}</strong>` : '';
  if (ansicht.ok && OK_TEXTE[ansicht.ok]) {
    return `<p class="hinweisbox gut" role="status">${esc(OK_TEXTE[ansicht.ok] ?? '')}${wer}</p>`;
  }
  if (ansicht.fehler && FEHLER_TEXTE[ansicht.fehler]) {
    return `<p class="hinweisbox schlecht" role="alert">${esc(FEHLER_TEXTE[ansicht.fehler] ?? '')}</p>`;
  }
  return '';
}

function sitzungsZeile(
  sitzung: Sitzung,
  nameVon: (id: string) => string,
  eigeneSitzung: string,
): string {
  const istMeine = sitzung.id === eigeneSitzung;
  return `<tr>
    <td><strong>${esc(nameVon(sitzung.benutzerId))}</strong>${istMeine ? ' <span class="marke">dieses Gerät</span>' : ''}</td>
    <td>${esc(sitzung.geraet)}</td>
    <td class="mono">${esc(sitzung.herkunft)}</td>
    <td>${esc(zeitpunkt(sitzung.angelegtAm))}</td>
    <td>${esc(seit(sitzung.letzterZugriff))}</td>
    <td class="tat">
      <form method="post" action="/admin/geraet-abmelden">
        <input type="hidden" name="id" value="${esc(sitzung.id)}" />
        <button class="klein" type="submit">Abmelden</button>
      </form>
    </td>
  </tr>`;
}

function kontoZeile(
  benutzer: Benutzer,
  ich: Benutzer,
  geraeteAnzahl: number,
  adminAnzahl: number,
): string {
  const selbst = benutzer.id === ich.id;
  const letzterAdmin = benutzer.rolle === 'admin' && adminAnzahl <= 1;
  const rolleZiel = benutzer.rolle === 'admin' ? 'benutzer' : 'admin';
  const rolleText =
    benutzer.rolle === 'admin' ? 'Zum normalen Benutzer machen' : 'Zum Administrator machen';

  return `<tr>
    <td>
      <strong>${esc(benutzer.username)}</strong>${selbst ? ' <span class="marke">du</span>' : ''}
      <div class="klein-dim">angelegt ${esc(zeitpunkt(benutzer.angelegtAm))}${
        benutzer.angelegtVon ? ` von ${esc(benutzer.angelegtVon)}` : ''
      }</div>
    </td>
    <td>${benutzer.rolle === 'admin' ? '<span class="rolle admin">Administrator</span>' : '<span class="rolle">Benutzer</span>'}</td>
    <td>${geraeteAnzahl === 0 ? '<span class="dim">keins</span>' : `${geraeteAnzahl}`}</td>
    <td>${esc(zeitpunkt(benutzer.letzteAnmeldung))}</td>
    <td class="tat">
      <details>
        <summary>Bearbeiten</summary>
        <div class="werkzeug">

          <form method="post" action="/admin/passwort-setzen" class="feldzeile">
            <input type="hidden" name="id" value="${esc(benutzer.id)}" />
            <label for="pw-${esc(benutzer.id)}">Neues Passwort</label>
            <input id="pw-${esc(benutzer.id)}" name="passwort" type="password"
                   autocomplete="new-password" minlength="10" required />
            <label for="pw2-${esc(benutzer.id)}">Wiederholen</label>
            <input id="pw2-${esc(benutzer.id)}" name="passwort2" type="password"
                   autocomplete="new-password" minlength="10" required />
            <button class="klein" type="submit">Passwort setzen</button>
            <p class="klein-dim">Meldet alle Geräte dieses Kontos ab.</p>
          </form>

          <form method="post" action="/admin/rolle-setzen">
            <input type="hidden" name="id" value="${esc(benutzer.id)}" />
            <input type="hidden" name="rolle" value="${rolleZiel}" />
            <button class="klein" type="submit" ${letzterAdmin ? 'disabled' : ''}>${rolleText}</button>
            ${letzterAdmin ? '<p class="klein-dim">Letzter Administrator — geht nicht.</p>' : ''}
          </form>

          <form method="post" action="/admin/konto-loeschen"
                onsubmit="return confirm('Konto ${esc(benutzer.username).replace(/'/g, '')} wirklich löschen?');">
            <input type="hidden" name="id" value="${esc(benutzer.id)}" />
            <button class="klein gefahr" type="submit" ${selbst || letzterAdmin ? 'disabled' : ''}>Konto löschen</button>
            ${selbst ? '<p class="klein-dim">Das eigene Konto nicht.</p>' : ''}
          </form>

        </div>
      </details>
    </td>
  </tr>`;
}

export function adminPage(ansicht: AdminAnsicht): string {
  const adminAnzahl = ansicht.benutzer.filter((b) => b.rolle === 'admin').length;
  const namen = new Map(ansicht.benutzer.map((b) => [b.id, b.username]));
  const nameVon = (id: string): string => namen.get(id) ?? 'gelöschtes Konto';

  const eigeneSitzung =
    ansicht.sitzungen.find((s) => s.benutzerId === ansicht.ich.id)?.id ?? '';

  const geraetePro = new Map<string, number>();
  for (const s of ansicht.sitzungen) {
    geraetePro.set(s.benutzerId, (geraetePro.get(s.benutzerId) ?? 0) + 1);
  }

  const sitzungsZeilen =
    ansicht.sitzungen.length === 0
      ? '<tr><td colspan="6" class="leer">Kein Gerät angemeldet.</td></tr>'
      : ansicht.sitzungen.map((s) => sitzungsZeile(s, nameVon, eigeneSitzung)).join('\n');

  const kontoZeilen = ansicht.benutzer
    .map((b) => kontoZeile(b, ansicht.ich, geraetePro.get(b.id) ?? 0, adminAnzahl))
    .join('\n');

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>SmartHome — Verwaltung</title>
<link rel="icon" href="/favicon-64.png?v=20260827" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<style>
  :root {
    --bg: #eef1f6; --surface: #ffffff; --text: #10151c; --text-dim: #5b6675;
    --border: #dce2ec; --border-strong: #c6cedb; --akzent: #3b82f6;
    --danger: #dc2626; --gut: #15803d;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f141b; --surface: #171e27; --text: #eef2f7; --text-dim: #9aa6b6;
      --border: #263140; --border-strong: #35435a; --akzent: #60a5fa;
      --danger: #f87171; --gut: #4ade80;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 1.25rem 1rem 4rem;
    background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 15px; line-height: 1.5;
  }
  .rahmen { max-width: 60rem; margin: 0 auto; }

  header { display: flex; flex-wrap: wrap; gap: 0.8rem 1rem;
           align-items: center; margin-bottom: 1.4rem; }
  header img { width: 40px; height: 40px; border-radius: 10px; }
  header h1 { font-size: 1.25rem; margin: 0; letter-spacing: -0.01em; }
  header p { margin: 0.1rem 0 0; font-size: 0.83rem; color: var(--text-dim); }
  .kopf-tat { margin-left: auto; display: flex; gap: 0.5rem; flex-wrap: wrap; }

  a.knopf, button {
    display: inline-block; padding: 0.6rem 1rem; border: 1px solid var(--border-strong);
    border-radius: 10px; background: var(--surface); color: var(--text);
    font: inherit; font-weight: 600; text-decoration: none; cursor: pointer;
    min-height: 44px;
  }
  a.knopf:hover, button:hover:not(:disabled) { border-color: var(--akzent); }
  button:disabled { opacity: 0.45; cursor: default; }
  button.haupt { background: var(--akzent); border-color: var(--akzent); color: #fff; }
  button.klein { padding: 0.45rem 0.7rem; min-height: 38px; font-size: 0.85rem; }
  button.gefahr { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }

  section {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 14px; padding: 1.1rem 1.15rem; margin-bottom: 1.1rem;
  }
  section > h2 { font-size: 1rem; margin: 0 0 0.2rem; }
  section > p.unter { margin: 0 0 0.9rem; font-size: 0.83rem; color: var(--text-dim); }

  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; min-width: 38rem; }
  th, td { text-align: left; padding: 0.6rem 0.5rem; vertical-align: top;
           border-bottom: 1px solid var(--border); }
  th { font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.04em;
       color: var(--text-dim); font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  td.tat { text-align: right; white-space: nowrap; }
  td.leer { color: var(--text-dim); padding: 1.2rem 0.5rem; text-align: center; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em; }
  .dim, .klein-dim { color: var(--text-dim); }
  .klein-dim { font-size: 0.78rem; margin: 0.35rem 0 0; }
  .marke { font-size: 0.72rem; padding: 0.1rem 0.4rem; border-radius: 999px;
           background: color-mix(in srgb, var(--akzent) 16%, transparent);
           color: var(--akzent); white-space: nowrap; }
  .rolle { font-size: 0.8rem; }
  .rolle.admin { font-weight: 700; color: var(--akzent); }

  details summary { cursor: pointer; padding: 0.45rem 0.2rem; font-size: 0.85rem;
                    font-weight: 600; color: var(--akzent); }
  .werkzeug { display: grid; gap: 0.9rem; padding: 0.7rem 0 0.2rem;
              text-align: left; white-space: normal; min-width: 15rem; }
  .werkzeug form { margin: 0; }

  label { display: block; font-size: 0.8rem; color: var(--text-dim); margin: 0.5rem 0 0.25rem; }
  input, select {
    width: 100%; max-width: 22rem; padding: 0.6rem 0.7rem;
    font-size: 1rem; font-family: inherit; color: var(--text); background: var(--bg);
    border: 1px solid var(--border-strong); border-radius: 9px; min-height: 44px;
  }
  input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible {
    outline: 2px solid var(--akzent); outline-offset: 1px;
  }
  .feldzeile button { margin-top: 0.6rem; }
  form.neu button { margin-top: 0.9rem; }

  .hinweisbox {
    margin: 0 0 1.1rem; padding: 0.7rem 0.85rem; border-radius: 11px; font-size: 0.88rem;
  }
  .hinweisbox.gut { color: var(--gut);
    background: color-mix(in srgb, var(--gut) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--gut) 32%, transparent); }
  .hinweisbox.schlecht { color: var(--danger);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 32%, transparent); }

  .fuss { margin: 0; font-size: 0.8rem; color: var(--text-dim); line-height: 1.5; }
  .trennlinie { margin-top: 1rem; padding-top: 0.9rem; border-top: 1px solid var(--border); }
</style>
</head>
<body>
<div class="rahmen">

  <header>
    <img src="/favicon-64.png?v=20260827" alt="" />
    <div>
      <h1>Verwaltung</h1>
      <p>Angemeldet als <strong>${esc(ansicht.ich.username)}</strong> · Administrator</p>
    </div>
    <div class="kopf-tat">
      <a class="knopf" href="/">Zum Dashboard</a>
      <a class="knopf" href="/logout">Abmelden</a>
    </div>
  </header>

  ${meldung(ansicht)}

  <section>
    <h2>Angemeldete Geräte</h2>
    <p class="unter">Jede Zeile ist ein Browser, in dem jemand angemeldet ist. Abmelden
       wirkt sofort — beim nächsten Aufruf erscheint dort wieder die Anmeldung.</p>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>Konto</th><th>Gerät</th><th>Adresse</th>
          <th>Angemeldet seit</th><th>Zuletzt aktiv</th><th></th>
        </tr></thead>
        <tbody>
${sitzungsZeilen}
        </tbody>
      </table>
    </div>
    <div class="trennlinie">
      <form method="post" action="/admin/alle-abmelden"
            onsubmit="return confirm('Wirklich alle Geräte abmelden? Auch dieses hier.');">
        <button class="gefahr" type="submit">Alle Geräte abmelden</button>
      </form>
      <p class="klein-dim">Meldet auch dich selbst ab. Danach muss sich jeder neu anmelden.</p>
    </div>
  </section>

  <section>
    <h2>Konten</h2>
    <p class="unter">Wer sich anmelden darf. Administratoren sehen zusätzlich diese Seite.</p>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>Benutzername</th><th>Rolle</th><th>Geräte</th>
          <th>Letzte Anmeldung</th><th></th>
        </tr></thead>
        <tbody>
${kontoZeilen}
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Neues Konto anlegen</h2>
    <p class="unter">Benutzername und Passwort vergibst du — die Person meldet sich damit an.
       Das Passwort steht danach nirgends im Klartext; vergessen heisst hier neu setzen.</p>
    <form method="post" action="/admin/konto-anlegen" class="neu">
      <label for="neu-name">Benutzername</label>
      <input id="neu-name" name="username" type="text" required
             autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"
             minlength="2" maxlength="32" />

      <label for="neu-pw">Passwort (mindestens 10 Zeichen)</label>
      <input id="neu-pw" name="passwort" type="password" required
             autocomplete="new-password" minlength="10" />

      <label for="neu-pw2">Passwort wiederholen</label>
      <input id="neu-pw2" name="passwort2" type="password" required
             autocomplete="new-password" minlength="10" />

      <label for="neu-rolle">Rolle</label>
      <select id="neu-rolle" name="rolle">
        <option value="benutzer" selected>Benutzer — sieht nur das Dashboard</option>
        <option value="admin">Administrator — darf auch diese Seite</option>
      </select>

      <button class="haupt" type="submit">Konto anlegen</button>
    </form>
  </section>

  <p class="fuss">
    Passwort vergessen und niemand kommt mehr in die Verwaltung? Auf dem Server-PC
    im Ordner der App <span class="mono">npm run passwort</span> ausführen — das
    setzt ein Konto neu und macht es zum Administrator.
  </p>

</div>
</body>
</html>`;
}
