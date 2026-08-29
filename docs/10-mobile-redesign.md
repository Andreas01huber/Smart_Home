# 10 – Mobile Premium Redesign

Visuelles Facelift des Handy-Modus. Stand: 26.08.2026.

**Nichts an der Logik verändert.** Keine Datei unter `packages/*/src` (ausser
Darstellungskonstanten), kein Backend, keine API, keine Berechnung, keine
Datenquelle. Geändert wurden ausschliesslich `styles.css`, die Struktur in
`index.html` und Darstellungscode in `app.js`.

---

## Befund: die Schwachstellen des alten Mobile-Modus

| Problem | Wirkung |
| --- | --- |
| `#status-text { display: none }` unter 560 px | Nur ein farbiger Punkt — der Systemzustand war **nicht lesbar** |
| KPI-Kacheln als schmucklose weisse Kästen | wirkte wie eine Web-Oberfläche, nicht wie eine App |
| Karten mit 3-px-Farbbalken oben | flach, „Bootstrap-Anmutung“ |
| Alle Karten optisch gleich gewichtet | keine Hierarchie, kein Blickanker |
| Kein Navigationselement, sehr lange Scrollstrecke | schlechte Daumenerreichbarkeit |
| Batteriebalken als simpler Fortschrittsbalken | kein Instrumentencharakter |
| Flussdiagramm 430×640 | füllte den gesamten ersten Bildschirm |
| Kopfzeile 2 px zu breit bei 320 px | horizontales Scrollen |

## Was umgesetzt wurde

### Design-System (Tokens)
Ergänzt statt ersetzt: `--elev-1/2/3` (gestaffelte Höhenwirkung), `--card-top`
(feine Lichtkante), `--card-sheen` (Verlauf), `--scrim`, `--radius-lg`.
Im Dunkeln entsteht Tiefe über die helle Oberkante statt über Schatten — so
arbeiten hochwertige native Oberflächen.

### Karten
Der Farbbalken wich einem **weichen Farbschimmer in der oberen Ecke**
(`radial-gradient`) plus Lichtkante. Farbe wirkt jetzt als Licht, nicht als
Fläche. Icons sitzen in dezent eingefärbten Feldern (`border-radius: 13px`),
wodurch die unterschiedlich proportionierten Gerätebilder als eine Familie
wirken.

### Kennzahlen
Metrik-Kacheln mit farbigem Markierungsstrich links, ruhigerem Label
(0.68 rem, `letter-spacing: .06em`) und grösserer Zahl in **tabellarischen
Ziffern** — dadurch springt beim Aktualisieren nichts.

### Batterie
Vom Fortschrittsbalken zum **Messinstrument**: feine Skalenstriche im
Hintergrund (`repeating-linear-gradient`), Füllung mit Eigenleuchten und
Glanzkante, weiches Einschwingen (`cubic-bezier(.22,1,.36,1)`).

### LEAPMOTOR als Highlight
Eigene Hintergrundtönung und kräftigere Randfarbe. Neue Statuszeile mit
Ampelpunkt. Beim Laden bekommt die Karte über `.is-charging` mehr Präsenz
(Wert in Akzentfarbe, ruhiges Pulsieren des Icons). **„Kein Fahrzeug
angeschlossen“ bleibt ein neutraler Zustand, kein Fehlerbild.**

### Mobile-Navigation (neu)
Feste, unscharf hinterlegte Leiste unten mit vier Zielen: Fluss · Jetzt ·
Verlauf · Kosten. Sie springt zu den **bereits vorhandenen Abschnitten** —
keine Routen, keine neuen Seiten, keine Zustandslogik. Der aktive Reiter folgt
per `IntersectionObserver` dem sichtbaren Abschnitt. Touch-Ziele ≥ 48 px,
`env(safe-area-inset-bottom)` berücksichtigt.

### Mikrointeraktionen
- Wertwechsel: kurzes Einschwingen (`value-settle`, 0.34 s) — ausgelöst **nur
  bei echter Änderung**, weil `setF()` vorher vergleicht. Kein Sekundenblinken.
- Karten/Knöpfe: Druckfeedback (`scale(.985)`).
- Detailansicht: erscheint wie ein natives Sheet (`sheet-in` + Scrim-Blende).
- Alles respektiert `prefers-reduced-motion`.

### Dichte
Flussdiagramm auf Mobile von 430×640 auf **430×570** verdichtet (−11 % Höhe)
bei gleicher Anordnung und Lesbarkeit — dadurch sind Diagramm **und**
Kennzahlen auf der ersten Bildschirmseite sichtbar. Karteninhalte enger
gruppiert, Aufschlüsselungen durch eine Trennlinie abgesetzt.

### Bedienbarkeit
Chips, Umschalter, Datums- und Verbinden-Knöpfe auf Daumengrösse gebracht.
Statustext bleibt sichtbar (gekürzt statt versteckt).

## Geprüft

| Test | Ergebnis |
| --- | --- |
| 320 / 360 / 375 / 390 / 430 px | kein horizontales Scrollen (gemessen, nicht geschätzt) |
| Kopfzeilen-Überlauf bei 320 px | behoben (Marke kürzt sich, Status bleibt lesbar) |
| Hell + Dunkel | beide geprüft |
| Desktop | unverändert; Tab-Leiste erscheint erst unter 760 px |
| Funktionstest | 6 Flussknoten, 6 Kennzahlen, 7 Karten, 9 Tageskacheln, 4 Chartlinien, 2 Kostenkarten, 4 Statuszeilen — alle befüllt |
| Werte | Haus 1,3 kW · PV 4 W · Speicher 69 % · Fahrzeug-SOC „nicht verfügbar“ |
| Konsole | keine Skriptfehler |
| Tests / Typecheck | **101/101 grün**, Typecheck fehlerfrei |

## Bewusst nicht geändert

- Energiefluss-Berechnung, Source-of-Truth, Bilanz
- Fronius-, Victron- und Charger-Connectoren
- Ladeprotokoll, Session-Erkennung, Energiequellen-Zuordnung
- APIs, Persistenz, Historie
- Farbbedeutungen (PV = orange, Haus = blau, Netz = violett, Speicher = grün,
  Fahrzeug = cyan) — sie bleiben identisch, nur ihre Anwendung wurde ruhiger
- Desktop-Layout des Flussdiagramms
