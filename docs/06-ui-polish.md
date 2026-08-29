# UI-Polish & Robustheit (Final)

Stand: 2026-08-18. Kein Redesign — gezielter Feinschliff (Anforderung 1/68).

## Icons

Echte Grafiken unter `apps/server/public/assets/energy/`, auf max. 256 px
optimiert (home 2,3 MB → 91 KB, grid 1,5 MB → 91 KB), transparent integriert
(`object-fit: contain`, kein weißer Kasten):

| Datei | Verwendung |
| --- | --- |
| `home.png` | Haus / Hausverbrauch (Flow-Zentrum, Karte) |
| `fronius-inverter.png` | PV Gesamt, je Wechselrichter (Mini-Icon) |
| `battery-fronius.png` | Kleiner Speicher (Fronius, ~12 kWh) |
| `battery-large.png` | Großer Speicher (Victron, ~50 kWh) |
| `grid.png` | Stromnetz (Bezug und Einspeisung, Richtung über Flow) |
| `leapmotor-c10.png` | E-Auto |

| `battery-total.png` | Gesamtspeicher (beide Batterien zusammen) |

Alle Bilder mit sinnvollem `alt`-Text (Anforderung 48).

## App-Icon (Stand 27.08.2026)

Ein einziges Icon für alles — Browser, installierte App und
Desktop-Verknüpfung. Quelle: `App_Icon27_08_2026.png` (1254 × 1254, RGBA).
Die frühere Aufteilung in eine helle und eine dunkle Fassung ist entfallen:
Das Icon ist farbig genug, um auf hellem wie dunklem Grund zu bestehen
(bei 32 px in der Kopfzeile geprüft).

Alle Grössen werden aus der einen Vorlage abgeleitet. Der Inhalt sitzt in der
Quelle nicht mittig (Rand oben 164, unten 182, links 114, rechts 96), deshalb
wird zuerst auf den tatsächlichen Inhalt zugeschnitten und dann zentriert.

| Datei | Grösse | Hintergrund | Verwendung |
| --- | --- | --- | --- |
| `icon-192.png` | 192 | transparent | Manifest, Kopfzeilen-Logo |
| `icon-512.png` | 512 | transparent | Manifest |
| `icon-maskable-512.png` | 512 | weiss | Manifest `purpose: maskable` |
| `apple-touch-icon.png` | 180 | weiss | iOS-Startbildschirm |
| `favicon-64.png` | 64 | transparent | Browser-Reiter |
| `smarthome-icon.ico` (Wurzel) | 16–256 | transparent | Desktop-Verknüpfung |

Zwei Fassungen brauchen bewusst einen **deckenden** Hintergrund:

- **maskable** — Android beschneidet auf einen Kreis. Der Inhalt steht deshalb
  nur auf 72 % der Kantenlänge, damit nichts abgeschnitten wird. Vorher zeigte
  das Manifest hier dieselbe Datei wie für `purpose: any`; die wäre beschnitten
  worden.
- **apple-touch-icon** — iOS legt Alpha auf Schwarz. Ohne deckenden Grund
  stünde das Icon auf dem Startbildschirm in einem schwarzen Kasten.

Die `.ico` enthält die kleinen Grössen als klassisches DIB und nur 256 px als
PNG — so lesen sie auch ältere Teile der Windows-Shell. Geprüft: alle Grössen
laden, Ecken transparent.

**Entfernt:** `icon-192-light.png`, `favicon-64-light.png`, `brand-icon.png`,
`ICON_app_lightmode.png`, `energie.ico`, `smarthome.ico` — alle ohne
verbleibende Referenz.

### Warum die Adressen eine Version tragen

Der Server schickt für Bilder `cache-control: public, max-age=86400`. Nach dem
Austausch zeigten Browser und installierte App deshalb **einen Tag lang weiter
das alte Icon** — auch nach wiederholtem Neuladen. Alle Icon-Adressen tragen
darum jetzt `?v=20260827`; das ändert den Zwischenspeicher-Schlüssel und die
neue Datei greift sofort.

**Bei jedem künftigen Icon-Wechsel diese Version mitziehen**, sonst tritt
derselbe Effekt wieder auf. Betroffen sind `index.html`,
`manifest.webmanifest`, `styles.css` (`--brand-logo`) und die Schalenliste in
`sw.js`.

Windows merkt sich Icons **pro Dateipfad**. Ein Überschreiben derselben `.ico`
reicht dort nicht — die Datei heisst deshalb jetzt `smarthome-icon.ico`, und die
Verknüpfung zeigt auf den neuen Pfad. Auch hier gilt: künftig den Dateinamen
mitändern, nicht nur den Inhalt.

## Zentrale Formatter (`public/format.js`, getestet)

| Funktion | Beispiel |
| --- | --- |
| `formatSoc` | `74 %` (nie `74,000 %`) |
| `formatPower` | `8,4 kW`, `336 W` |
| `formatEnergy` | `42,8 kWh`, `1,42 MWh` |
| `formatCurrency` | `8,42 €` |
| `formatPercentage` | `93 %` |
| `formatTimestamp` / `formatClock` | `vor 2 Sekunden` / `14:32` |

Fehlende Werte → `—`, nie `NaN` oder `null`. Deutsche Formatierung (`1.234,56`).

## Gerätestatus & Reconnect

- Statusmodell: `online · stale · reconnecting · offline · error · not_configured · disabled`.
- `ManagedConnector` (Health-Gate) je Connector: Auto-Reconnect mit Exponential
  Backoff (5 s, 10 s, 30 s, 60 s), sauberes Statusmodell.
- **Ein totes Gerät blockiert die anderen nicht:** offline → letzte Messung
  sofort, Neuprüfung im Hintergrund. Poll-Dauer mit schlafendem Symo: **100 ms**
  (vorher ~5000 ms).
- Manueller Reconnect: `POST /api/devices/{id}/reconnect` → echter Health-Check.
  UI zeigt Spinner, Button gesperrt, Ergebnis verständlich.
- Wallbox: `not_configured` statt „Offline" (kein Fehlalarm).

## Finaler Flow-Review (2. Runde)

- **Neue Bilder** übernommen: Stromnetz (schlichter Strommast) und Leapmotor C10,
  optimiert auf ≤ 63 KB. Alte Versionen ersetzt (gleiche Dateinamen, keine Dubletten).
- **Radiales Flow-Layout:** Haus im Zentrum, PV oben, Speicher oben-links/rechts,
  Netz unten-links, Auto unten-rechts. Icon + aktueller Wert **im** Kreis, Name
  **außerhalb** in linienfreier Zone.
- **Linien docken am Kreisrand an** (Geometrie in JS berechnet): objektiv
  **0 Überlappungen** zwischen Flow-Linien und den 18 Textelementen bzw. Icons
  (per SVG-Bounding-Box-Prüfung verifiziert, Desktop und Mobile).
- **Per-Icon-Zentrierung** über `ICON_CFG` (scale/dy) — alle Icons optisch gleich
  gewichtet trotz unterschiedlicher Seitenverhältnisse.
- **Dezente Anschlusspunkte** am Geräterand, die sich bei aktivem Fluss einfärben.
- **Responsives Flow-Layout:** Desktop breit-radial (viewBox 800×520), Mobile
  portrait (viewBox 430×640) mit ~2× größeren Knoten — keine winzigen Icons.
- **Volle Namen:** „Kleiner Speicher" / „Großer Speicher" (keine Abkürzung „Sp.").
- Flow-Linien feiner (2,4/2,8 px), keine Neon-/Glow-Übertreibung.

## Fronius-Symo-Diagnose

Der Symo (`192.168.178.121`) ist ein **Non-Hybrid-SnapInverter** und schaltet
nach Sonnenuntergang ab (keine PV → Wechselrichter schläft → Solar API nicht
erreichbar, Timeout). Der GEN24 bleibt online, weil er als Hybrid am Akku hängt.
**Das ist normal, kein Defekt.** Das Dashboard zeigt „keine Daten" statt „0 W"
(Anforderung 34), und der Symo kommt morgens automatisch zurück (Auto-Reconnect).
