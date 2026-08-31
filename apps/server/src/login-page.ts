/**
 * Die Anmeldeseite.
 *
 * Bewusst eine einzelne, in sich geschlossene Seite ohne Verweise auf
 * styles.css oder app.js: Alles, was die Anmeldeseite braucht, muss ohne
 * Sitzung erreichbar sein. Je weniger Pfade dafür freigegeben werden müssen,
 * desto kleiner die Fläche, an der ein Fehler entstehen kann. So ist die
 * Freigabeliste im Server genau drei Einträge lang.
 *
 * Die Farben sind aus styles.css übernommen, damit der Übergang ins Dashboard
 * nicht wie ein Bruch wirkt.
 */

import { esc } from './html.ts';

export interface LoginPageOptions {
  /** Wohin nach erfolgreicher Anmeldung. Kommt aus der ursprünglichen Anfrage. */
  readonly redirect?: string;
  /** Fehlermeldung über dem Formular. */
  readonly fehler?: string;
  /** Benutzername vorbelegen, damit er nach einem Fehlversuch nicht neu getippt werden muss. */
  readonly username?: string;
}

export function loginPage(options: LoginPageOptions = {}): string {
  const redirect = esc(options.redirect ?? '/');
  const username = esc(options.username ?? '');
  const fehler = options.fehler
    ? `<p class="fehler" role="alert">${esc(options.fehler)}</p>`
    : '';

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>SmartHome — Anmeldung</title>
<link rel="icon" href="/favicon-64.png?v=20260827" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<style>
  :root {
    --bg: #eef1f6; --surface: #ffffff; --text: #10151c; --text-dim: #5b6675;
    --border: #dce2ec; --border-strong: #c6cedb; --akzent: #3b82f6;
    --danger: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f141b; --surface: #171e27; --text: #eef2f7; --text-dim: #9aa6b6;
      --border: #263140; --border-strong: #35435a; --akzent: #60a5fa;
      --danger: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 1.5rem;
    background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .karte {
    width: 100%; max-width: 22rem;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 16px; padding: 1.75rem;
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.07);
  }
  .kopf { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 1.4rem; }
  .kopf img { width: 40px; height: 40px; border-radius: 10px; }
  h1 { font-size: 1.2rem; margin: 0; letter-spacing: -0.01em; }
  .kopf p { margin: 0.15rem 0 0; font-size: 0.82rem; color: var(--text-dim); }
  label { display: block; font-size: 0.82rem; color: var(--text-dim); margin-bottom: 0.3rem; }
  input {
    width: 100%; padding: 0.7rem 0.8rem; margin-bottom: 1rem;
    font-size: 1rem; font-family: inherit;
    color: var(--text); background: var(--bg);
    border: 1px solid var(--border-strong); border-radius: 10px;
  }
  input:focus-visible { outline: 2px solid var(--akzent); outline-offset: 1px; }
  button {
    width: 100%; padding: 0.75rem; border: 0; border-radius: 10px;
    font-size: 1rem; font-family: inherit; font-weight: 600;
    color: #fff; background: var(--akzent); cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  .fehler {
    margin: 0 0 1rem; padding: 0.6rem 0.75rem; border-radius: 10px;
    font-size: 0.87rem; color: var(--danger);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  }
  .hinweis { margin: 1.1rem 0 0; font-size: 0.78rem; color: var(--text-dim); line-height: 1.45; }
</style>
</head>
<body>
  <main class="karte">
    <div class="kopf">
      <img src="/favicon-64.png?v=20260827" alt="" />
      <div>
        <h1>SmartHome</h1>
        <p>Anmeldung erforderlich</p>
      </div>
    </div>

    ${fehler}

    <form method="post" action="/login">
      <input type="hidden" name="redirect" value="${redirect}" />

      <label for="username">Benutzername</label>
      <input id="username" name="username" type="text" value="${username}"
             autocomplete="username" autocapitalize="none" autocorrect="off"
             spellcheck="false" required autofocus />

      <label for="password">Passwort</label>
      <input id="password" name="password" type="password"
             autocomplete="current-password" required />

      <button type="submit">Anmelden</button>
    </form>

    <p class="hinweis">
      Die Anmeldung bleibt ein Jahr gespeichert und verlängert sich bei jedem
      Besuch. Auf einem fremden Gerät besser abmelden.
    </p>
  </main>
</body>
</html>`;
}
