# 08 – Production Audit & Polish

Abschlussbericht des finalen Produktions-Audits. Ziel war ausdrücklich **kein
Redesign und kein Rewrite**, sondern die bereits sehr weit entwickelte Anwendung
stabiler, schneller, sauberer und wartbarer zu machen — und dort, wo sie bereits
gut ist, **nichts** zu verändern.

Datum: 19.08.2026 · Grundlage: laufende Anlage (Fronius Symo, Fronius GEN24,
Victron GX), echte Live-Daten.

---

## Systemzustand

**Production Ready: JA** — mit einer organisatorischen Empfehlung (Versionskontrolle, s. u.).

| Prüfung | Ergebnis |
| --- | --- |
| TypeScript Typecheck (`tsc --build`) | ✅ fehlerfrei |
| Unit-/Integrationstests (`node:test`) | ✅ 75/75, 21 Suites |
| Frontend-Syntax (`node --check`) | ✅ app.js, format.js, sw.js |
| Live-Snapshot Energiebilanz | ✅ `verdict: ok`, Residuum 0 W |
| Alle echten Geräte online | ✅ Symo, GEN24, Victron |
| Serverneustart-Test (Recovery) | ✅ Tagesdaten erhalten, Sammler läuft weiter |
| Konsole (echte Fehler) | ✅ keine (nur SW-Meldung der Sandbox) |
| Netzwerk (404/500) | ✅ keine |

Es gibt **kein** eingerichtetes Lint-Tool; der strikte TypeScript-Compiler ist
hier der De-facto-Linter (bewusst keine neue Dependency ergänzt).

---

## Baseline (vor den Änderungen)

- Typecheck 0 Fehler, 75 Tests grün.
- Server lief bereits dauerhaft im Hintergrund; Sammler: 60-s-Kurve, ~97
  Punkte/Tag zum Messzeitpunkt.
- **Kein Git-Repository** vorhanden (siehe „Verbleibende Punkte").
- Vor jeder Änderung wurde eine vollständige Quellcode-Kopie als Checkpoint
  gesichert (Scratchpad), da keine Versionskontrolle vorhanden ist.

---

## Was geprüft und gemessen wurde

### Datenintegrität / Source of Truth (keine Doppelzählung)
Am Live-Snapshot verifiziert:
- `solar = sum(fronius-local, fronius-gen24)` — die Victron-PV wird **nicht**
  addiert (sie enthält die AC-gekoppelte Fronius bereits → 4L).
- `grid = fronius-gen24` (eine einzige Netzquelle).
- `house = derived` (berechnet).
- Energiebilanz `verdict: ok`, Residuum **0 W**, keine `disagreements`.
- Gesamtspeicher kapazitätsgewichtet: 61.059 Wh (11.059 + 50.000), SOC korrekt
  gemittelt.

→ Das Mapping wurde **nicht** verändert (empirisch am 18.08. verifiziert).

### Geräte (Final Device Test)
| Gerät | Status | Antwortzeit |
| --- | --- | --- |
| Fronius Symo 5.0-3-M (`fronius-local`) | online | ~108 ms |
| Fronius GEN24 Hybrid (`fronius-gen24`) | online | ~63 ms |
| Victron GX (`victron-modbus`) | online | ~22 ms |
| Wallbox | `not_configured` (kein Fehler) | — |

Beide Connectoren fangen ihre Fehler intern ab und liefern im Fehlerfall eine
`offline`-Messung — sie werfen also nie. Das ist die Grundlage für den
Dauerbetrieb (siehe Sicherheitsnetz unten).

### Historie / Datensammlung (permanentes Energiegedächtnis)
- Sammler läuft **serverseitig**, unabhängig vom Browser.
- Kurve in **60-s-Auflösung** → max. ~1.440 Punkte/Tag (nicht Hunderttausende).
  Damit ist die Chart-Datenmenge von vornherein browserfreundlich.
- Persistenz: alle 120 s (falls verändert) + bei Tageswechsel + beim
  Herunterfahren → max. ~2 min Verlust bei hartem Absturz.
- **„Gestern"** (18.08.) zeigt korrekt *„keine vollständigen Daten"*, weil der
  Server gestern noch nicht lief — **es werden keine Daten erfunden** (Anf. 76).
- **Serverneustart getestet:** Nach Kill + Neustart wurden die 112 Tagespunkte
  aus `today.json` **wiederhergestellt**, der Sammler lief sofort weiter, alle
  Geräte reconnecteten automatisch.

### Realtime / Reconnect / Fehlerresilienz
- SSE (`/api/events`) mit automatischem Browser-Reconnect (EventSource).
- Beim Test-Neustart des Servers brachen Verbindungen kurz ab
  (`ERR_CONNECTION_RESET`) und **verbanden sich nach Rückkehr automatisch neu** —
  Live-Werte kamen ohne manuelles Neuladen zurück.
- Kein Aufbau mehrfacher SSE-Verbindungen; keine unbegrenzt wachsenden
  Live-Arrays (Frontend hält nur je eine Referenz auf `lastLive`/`dayData`).

### UI/UX (voller User-Flow im Browser, Desktop + Mobile, Hell + Dunkel)
Dashboard → Energiefluss → JETZT → Speicher → Netz → Historie → Gestern →
Tagesverlauf → Serien-Toggle → SOC-Ansicht → Kosten → Systemstatus geprüft.
- 5-Sekunden-Erfassbarkeit erfüllt (PV, Haus, beide Speicher, Netzrichtung, EV,
  heutige Produktion/Ersparnis sofort sichtbar).
- Technische Details (Gerätenamen, letzter Kontakt) liegen korrekt im
  **einklappbaren Systemstatus**, nicht auf dem Hauptdashboard.
- Leere/Empty-States sauber (EV „Nicht verbunden", Wallbox „Nicht konfiguriert" —
  keine Fehlermeldungen).
- Formatter: `formatSoc/Power/Energy/Currency` liefern konsequent „—" statt
  `NaN/null` — **keine** Änderung nötig.
- Mobile (375×812): Flow als Portrait-Layout, Karten einspaltig, Chart
  responsiv (6-h-Achse). Dark Mode: Icons/Kontraste sauber.

---

## Vorgenommene Änderungen (Changelog)

Nur sinnvolle, risikoarme Änderungen; jede mit klarem Nutzen.

### P1 — Zuverlässigkeit
1. **`apps/server/src/engine.ts` – Sicherheitsnetz im Poll-Zyklus.**
   `poll()` ist jetzt in `try/catch` gekapselt. Die Connectoren werfen zwar nie
   (sie sind gekapselt), aber sollte künftig etwas Unerwartetes durchkommen
   (neuer Connector, ungültige Daten), beendet das **nicht** mehr den 24/7-Sammler
   — der letzte gültige Zustand bleibt, der nächste Poll versucht es erneut.

### P2 — Performance (weniger Requests / Re-Renders)
2. **`apps/server/public/app.js` – doppelte Tages-Requests entfernt.**
   Beim Betrachten von „heute" wurde der Tag doppelt geladen (`?summary=1`
   **und** voll) und doppelt gerendert; beim Start sogar dreifach.
   `refreshTodayKpis()` nutzt jetzt für „heute" direkt `loadDay()`.

   | | vorher | nachher |
   | --- | --- | --- |
   | Tages-Requests beim Start | 3 | **1** |
   | Tages-Requests je 30-s-Intervall | 2 | **1** |
   | gemessen über 32 s (frischer Load) | 5 | **2** |

3. **`apps/server/public/app.js` – Systemstatus nicht mehr im Sekundentakt neu bauen.**
   `renderStatus()` erneuerte das gesamte Panel-DOM (inkl. Event-Listener) bei
   **jedem** Poll. Jetzt: Kopfzeile (Ampel) wird immer aktualisiert, das
   Detail-Panel nur bei echter Änderung (Signatur aus Status/Kontaktminute/
   laufendem Reconnect) — ~1×/min statt ~30×/min. Tote, leere `if`-Bedingung in
   `renderLive()` entfernt.

### P3/P4 — UX & Korrektheit
4. **`apps/server/public/app.js` – SOC-Achse: Label-Überlappung behoben.**
   In der Batteriestand-Ansicht überlappte die Einheit „%" oben links mit dem
   „100%"-Tick. Die Einheit wird dort nun weggelassen (die Ticks tragen bereits „%").
5. **`apps/server/src/history.ts` – Diagnose `archivedDays` korrigiert.**
   Zählte fälschlich den laufenden Tag mit (meldete „1" bei 0 Archiven). Jetzt
   werden nur **abgeschlossene** Tage gezählt (aktuell korrekt 0).
6. **`apps/server/src/index.ts` – veralteten Kommentar korrigiert** (Bindung ist
   `config.host`, Standard `0.0.0.0`, nicht „nur 127.0.0.1").

### Auf Wunsch — Energiefluss-Animation
7. **`styles.css` + `app.js` – schönere Fluss-Hervorhebung in den Flussfarben.**
   Aktive Verbindungen leuchten jetzt dezent in ihrer Farbe (PV=orange, Netz=lila,
   Speicher, EV), darüber wandert ein weicher, leicht glühender Puls in
   Flussrichtung; ruhende Leitungen bleiben neutral grau. Gilt automatisch für
   Desktop **und** Mobile (gleiche SVG-Pfade) und respektiert `prefers-reduced-motion`.
   **Nachtrag:** `setFlow()` ist jetzt idempotent — es fasst die Klassen nur bei
   echter Zustandsänderung an. Vorher startete jeder Poll (Sekundentakt) die
   CSS-Animation neu, was sichtbar ruckelte; jetzt läuft sie mit konstantem Tempo
   ununterbrochen (per `getAnimations()` verifiziert: `startTime` bleibt stabil,
   `currentTime` läuft linear weiter).

8. **`sw.js` – Cache `v8 → v10`**, damit PWA-Nutzer die neue Version erhalten.

---

## Bewusst NICHT verändert (weil bereits gut)

- Energy-Flow-Layout, Icons, Icon-Zentrierung, Karten, KPI-Leiste, Farben,
  Navigation, Dark/Light Mode.
- Zentrale Formatter (`format.js`) — Null-/NaN-Behandlung bereits vorbildlich.
- Fronius-/Victron-Connectoren und das Source-of-Truth-Mapping (laufen korrekt,
  empirisch verifiziert).
- Chart-Engine (Auto-Skalierung, Crosshair/Tooltip, Lücken≠0) — funktioniert;
  nur die eine Label-Überlappung wurde korrigiert.
- Backend-Architektur (bewusst ohne Web-Framework), Persistenzmodell, PWA-Aufbau.

---

## Sicherheit (pragmatischer Review)

- **Keine** Passwörter/Tokens im Code, in `config.json` oder in Logs. `config.json`
  enthält nur lokale IP-Adressen.
- Nur-Lese-Zugriffe auf die Geräte (Modbus lesend, Fronius Solar API lesend).
- Pfad-Traversal im Static-Server verhindert (Normalisierung + `PUBLIC_DIR`-Grenze).
- Request-Body mit Obergrenze (64 KB) gegen Missbrauch.
- SSE/API werden vom Service Worker **nie** gecacht (keine veralteten Messwerte).
- Kein Login/keine Rollen — bewusst, weil der Fernzugriff über **VPN** (nur eigene
  Geräte) statt öffentlich läuft. Für einen späteren öffentlichen Betrieb wäre ein
  Login nachzurüsten (siehe `deploy/README.md`).

---

## Tests

- `npm run typecheck` → 0 Fehler.
- `npm test` → **75 Pass / 0 Fail** (21 Suites): u. a. Normalisierung,
  Source-of-Truth (Doppelzählung ausgeschlossen), Energiebilanz, Accounting,
  Kostenberechnung, Managed-Connector/Health, Historie (Rollover-Archivierung,
  Neustart-Recovery, null≠0, getrennte Speicher), Formatter.
- Manueller End-to-End-Flow im Browser (Desktop + Mobile, Hell + Dunkel) statt
  automatisiertem E2E (kein Playwright im Projekt).

---

## Verbleibende Punkte / Empfehlungen

1. **P1 – Versionskontrolle fehlt.** Es gibt kein Git-Repository. Vor dem
   Produktivbetrieb dringend empfohlen (Sicherheitsnetz für Code **und** Historie):
   ```bash
   cd AppSmartHome
   git init
   printf "node_modules/\ndata/\n*.log\n" > .gitignore
   git add -A && git commit -m "Bestandsaufnahme vor Produktivbetrieb"
   ```
   (`data/` bewusst ausgeschlossen: echte Historie gehört nicht ins Repo, sondern
   in ein separates Backup.)
2. **Backup der Historie.** `data/` (history.json, today.json, days/) regelmäßig
   sichern — das ist das eigentliche „Energiegedächtnis".
3. **Victron `usableCapacityWh: 50000`** ist ein konfigurierter Schätzwert
   (das System meldet die Kapazität nicht über Modbus). Bei Gelegenheit gegen die
   real nutzbare Kapazität prüfen.
4. **Victron-VRM-Historie (Rückfüllung vergangener Tage)** wäre nur mit
   API-Token möglich — bewusst nicht mit Fake-Daten ersetzt.
5. Optional später: Login/Rollen, automatisiertes E2E (Playwright), Wallbox/EV.

---

## Fazit

Die Anwendung ist **produktionsreif**. Sichtbar hat sich fast nichts verändert
(bis auf die gewünschte, schönere Fluss-Animation und einen behobenen
Label-Überlapp) — im Hintergrund ist sie **robuster** (Poll-Sicherheitsnetz,
Neustart-Recovery verifiziert), **schlanker** (halbe Tages-Requests, kein
Sekundentakt-DOM-Neubau) und **ehrlicher** (korrekte Sammler-Diagnose). Die
größte offene Empfehlung ist organisatorisch: Git + Historie-Backup einrichten.
