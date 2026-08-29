# 11 – Hausansicht des Live-Energieflusses

Das visuelle Herzstück der App: das freigestellte 3D-Rendering der eigenen
Anlage mit Energiewegen, Messwerten und Tag-/Nacht-Stimmung.
Stand: 27.08.2026 (zweite Überarbeitung).

**Keine Logik verändert.** Betroffen sind nur `public/scene.js`,
Darstellungscode in `app.js`, Struktur in `index.html` und Stile in
`styles.css`; dazu die MIME-Tabelle des Servers. Datenquellen, Fronius-/
Victron-Logik, Berechnungen, APIs und Systemstatus sind unberührt.
Tests: **101/101 grün**, Typecheck fehlerfrei.

---

## Umschalten

**Einstellungen (Zahnrad) → Live-Energiefluss → Ansicht: Diagramm | Haus**

Standard ist **Haus**. Die Wahl wird pro Gerät gespeichert (`localStorage`).

## Das Haus steht frei — kein Bild in einer Box

Die Quelle `Haus_Dashboard.png` hat einen sauberen, echten Alphakanal. Eine
frühere Fassung lieferte das Rendering als **JPEG** aus — JPEG kennt keine
Transparenz, also war der dunkle Hintergrund eingebrannt und die Grafik sass in
einem sichtbaren Rechteck.

| | |
| --- | --- |
| Alphaverteilung | 43,5 % transparent, 55,3 % deckend, 1,2 % weiche Kante |
| Kantenqualität | **straight alpha**, Verhältnis Kante/deckend 0,93 → kein dunkler Saum |
| Auslieferung | `haus.webp`, 1485 × 988, **357 KB** (PNG wären 2051 KB) |
| Treue | **Alphakanal bytegleich**, mittlere Farbabweichung 1,85 von 255 |
| Rückfall | `haus.png` (1200 px) für Browser ohne WebP, per Canvas-Test gewählt |

Entfernt: der Elementhintergrund, `border-radius` und `box-shadow` am SVG.
Die Karte selbst trägt in dieser Ansicht keine Fläche (`.flow-card.is-house`).
Der einzige Schatten hängt am Bild und folgt dem Alphakanal — er umspielt die
**Silhouette** statt eines Rechtecks.

## Beschriftungen: Callouts statt Kästchen

Die früheren Pillen-Kästchen sind ersetzt. Jede Angabe besteht jetzt aus:

- dem **Namen** klein in Versalien (Laufweite 0,06 em — dieselbe wie in der
  Kennzahlreihe darunter, dadurch ein durchgehendes typografisches System),
- dem **Wert** gross und tabellarisch,
- einer **feinen farbigen Linie** darunter in der Flussfarbe.

Die Zuleitung vom Gerät läuft **ohne Bruch** in diese Linie hinein: Marke und
Beschriftung sind ein durchgehender Strich, kein Kasten mit Pfeil daneben.
Statt einer Fläche hält ein **Halo** (`paint-order: stroke fill`) die Schrift
auch über hellem Beton lesbar — ohne einen Container einzuführen.

Nebeneffekt: Die Callouts sind deutlich schmaler als die alten Pillen. Die
Überdeckung des Bildes fiel dadurch von 36,5 % auf **1,2 %** beim einzigen
Callout, das das Grundstück überhaupt noch berührt.

## Speicher: Namen und Ladebalken

Die Namen kommen aus dem Backend (`displayName`) — **„Kleiner Speicher"** und
**„Großer Speicher"**, also genau wie überall sonst in der App. Sie sind nicht
mehr fest verdrahtet und bleiben damit automatisch konsistent.

Bei den beiden Speichern **wird aus der farbigen Linie der Ladebalken**: Die
Linie ist die Spur, der farbige Teil der Ladestand. Sie ist dafür etwas
kräftiger und wechselt weich (0,9 s, `cubic-bezier`), wenn sich der Prozentwert
ändert. Kein zusätzliches Element, keine zweite Formsprache.

## Sonne und Mond

Eigene Assets des Benutzers (`Sonnen_Icon.png`, `Mond_Icon.png`), aufbereitet
und als WebP mit Alpha ausgeliefert:

| | Sonne | Mond |
| --- | --- | --- |
| Ausgeliefert | `sonne.webp` **88 KB** | `mond.webp` **64 KB** |
| Rückfall | `sonne.png` 304 KB | `mond.png` 228 KB |
| Alphatreue zur Vorlage | **bytegleich** | **bytegleich** |
| Farbabweichung | 2,67 von 255 | 1,05 von 255 |

**Aufbereitung.** Die Sonnenvorlage hatte einen ausgefransten Freisteller mit
roten und oliven Farbsäumen am Koronarand. Da die Sonne selbst Licht ist, wurde
ihr Alphakanal aus der Luminanz neu aufgebaut, die Korona weich ausgefedert und
ihr Randton vereinheitlicht — die Fransen verschwinden dadurch vollständig.
Beim Mond wäre das falsch (die dunklen Maria würden verschwinden), deshalb
bleibt dort der mitgelieferte Alphakanal erhalten; er ist sauber.

Beide sind quadratisch um ihre Scheibe zugeschnitten, mit **identischem
Scheibenanteil (61,7 %)**. Dadurch wirken Sonne und Mond exakt gleich gross und
teilen sich einen einzigen Massstab.

**Lage.** Vorher sassen sie direkt am Strommast und wirkten wie ein Teil davon.
Jetzt stehen sie als atmosphärische Ebene frei im Himmel oben rechts, deutlich
über der Beschriftungszeile und klar abgesetzt vom Mast. Gezeichnet werden sie
im Ursprung; Lage, Grösse und Leuchtkraft kommen aus `--sky-x`, `--sky-y`,
`--sky-scale` und `--sun-glow` / `--moon-glow`. Die Werte sind
Bildeinheiten der viewBox — die Himmelskörper sitzen damit **relativ zur Szene,
nicht relativ zum Fenster**, und jede Bildschirmklasse bekommt eigene Werte
statt skalierter Desktop-Koordinaten.

| Bildschirmklasse | Scheibe | Anteil | Abstand zum Mast |
| --- | --- | --- | --- |
| Desktop (ab 1025 px) | 150 Einh. | 10,1 % | 111 Einh. |
| Tablet (561–1024 px) | 135 Einh. | 9,1 % | 100 Einh. |
| Handy quer (Höhe ≤ 560 px) | 129 Einh. | 8,7 % | 99 Einh. |
| Handy hoch (bis 560 px) | 120 Einh. | 8,1 % | 103 Einh. |

**Schein.** Bewusst per CSS (`drop-shadow`), nicht im Bild eingebacken — nur so
lässt er sich je Bildschirmklasse zurücknehmen. Warm-golden bei der Sonne,
weiss-bläulich beim Mond, in beiden Fällen zwei weiche Lagen ohne harte Kante.
Am Telefon deutlich reduziert.

**Ebenen.** Beide liegen **hinter** dem Bild: Ihr Schein reicht über die Szene,
der Mast verdeckt ihn dort — das erzeugt Tiefe, ohne dass Daten verdeckt
werden. Bei Sonne legt sich zusätzlich ein warmes Streiflicht über Dach und
Fassade. Seine Ausdehnung endet innerhalb der viewBox, sonst schnitte der
SVG-Rand eine sichtbare Kante hinein.

**Umschaltung.** Weiterhin über die PV-Leistung (Sonne über 1 kW, Mond unter
0,5 kW) mit Hysterese und 25 s Bestätigungszeit — nicht über das Farbschema.
Überblendet wird mit 1,4 s, nie hart geschaltet.

## Energiewege

Stützpunkte, als weiche Kurve gezeichnet (Catmull-Rom → Bézier). Sie folgen dem
Bauwerk, wie es eine Leitung tun würde: über die Dachfläche zur Traufe, an der
Garagenwand hinunter, im Boden über die Einfahrt, am Sockel entlang zu den
Speichern. **Keine Linie schneidet durch das Gebäude.**

Unter der Farbe liegt eine **dunkle Fassung** (2,1-fache Breite). Das Rendering
wechselt mit dem Design nicht mit — heller Beton und dunkles Dach liegen immer
nebeneinander. Die Fassung gibt der Leitung überall denselben Halt, in beiden
Modi.

| Fluss | Verlauf | Richtung |
| --- | --- | --- |
| PV | Dach → Dachfläche → Verteilpunkt | immer erzeugend |
| Netz | Mast → Boden → Verteilpunkt | kehrt bei Einspeisung um |
| Kleiner / Großer Speicher | Speicher → Verteilpunkt | kehrt beim Laden um |
| Haus | Verteilpunkt → Wand → Einfahrt → Eingang | immer verbrauchend |
| Fahrzeug | Verteilpunkt → Garagenboden → Auto | immer ladend |

Der Verteilpunkt sitzt am Fronius-Wechselrichter — dort treffen PV, Speicher,
Netz, Haus und Wallbox real zusammen.

## Animation

- **Wandernde Lichtpunkte** (runde Kappen auf punktförmiger Strichfolge) mit
  weichem Glühen in der Flussfarbe.
- **Tempo nach Leistung** in fünf Stufen (4,6 s … 1,8 s je Umlauf),
  logarithmisch und gedeckelt: 0,2 kW kriecht, 3 kW läuft normal, ab ~10 kW ist
  Schluss — bei hoher Leistung soll nichts hektisch wirken.
- **Kein Neustart**: Zustand und Tempo werden zwischengespeichert; beim
  Tempowechsel wird die Abspielzeit nachgezogen, damit der Puls an derselben
  Stelle weiterläuft.
- **0 W = keine Animation.** Unter 40 W bleibt die Leitung sichtbar, aber
  ruhend — die Verbindung ist erkennbar, ohne einen Fluss vorzutäuschen.
- `prefers-reduced-motion`: keine Bewegung, keine Überblendung; Farbe und
  Glühen bleiben.

## Eine Geometrie für alle Bildschirme

Anker, Wege und Beschriftungen liegen im **Bildraum** (1485 × 988). Die viewBox
skaliert alles gemeinsam; es gibt **keine bildschirmabhängigen
Pixelpositionen**. Nur Schrift- und Linienstärken werden per Media-Query
nachgeführt. Seitlich reichen 40 Einheiten Rand — das Haus füllt dadurch
**94 %** der Breite.

> **Überholt.** Die Anordnung der Beschriftungen und die Führung der
> Zuleitungen wurden am 28.08.2026 neu gemacht: Es gibt jetzt **zwei**
> Anordnungen (seitliche Spalten am Schreibtisch, Bänder am Telefon), das Haus
> steht in beiden exakt mittig, und keine Linie schneidet mehr Text. Haus,
> Energiewege, Anker, Sonne/Mond und die Animation sind unverändert.
> Massgeblich ist **[13 – Komposition der Live-Energiefluss-Ansicht](13-energiefluss-komposition.md)**.

## Geprüft

| | |
| --- | --- |
| Freistellung | kein Hintergrund, kein Rahmen, kein Schatten am Element, keine Card |
| Bildqualität | Alpha bytegleich, Farbabweichung 1,85/255, keine Säume |
| Ankerpunkte | alle 6 Wege exakt an Start und Ziel, Puls deckungsgleich |
| Displaygrössen | 320 / 360 / 375 / 390 / 414 / 430 px × 3 Schriftstufen mit **längstmöglichen Texten** = 18 Kombinationen, **0 Kollisionen, 0 Überstände** |
| Überdeckung des Bildes | 5 von 6 Callouts völlig frei, „Haus" 1,2 % |
| Schriftgrösse | 12,6 px (320 px, Normal) bis 25,5 px (430 px, Sehr gross) |
| Richtung | Netzbezug normal, Einspeisung umgekehrt, Laden/Entladen gegenläufig |
| Laufruhe | `startTime` über 2,5 s unverändert, `currentTime` +2500 ms |
| Tempowechsel | Fortschritt 0,243 → 0,260 — kein sichtbarer Sprung |
| Bildrate | **60 fps**, längstes Einzelbild 16,8 ms (mit Himmel und Streiflicht) |
| Sonne/Mond | Hysterese und Bestätigung gemessen (siehe Tabelle oben) |
| Ladebalken | 86 % / 100 % korrekt gefüllt, weiche Übergänge |
| Sonne/Mond je Klasse | 1920×1080 · 1366×768 · 1024×768 · 768×1024 · 844×390 · 390×844 · 320×700 — **nie angeschnitten, nie über einer Beschriftung**, Scheibe durchgehend 8,1–10,1 % |
| Hell / Dunkel | beide geprüft, eigene Farbtoken je Modus |
| Diagramm-Ansicht | unverändert, keine Regression |
| Tests / Typecheck | **101/101 grün**, fehlerfrei |

## Bewusst so entschieden

- **Kein eigenes „Gesamtspeicher"-Callout.** Beide Speicher stehen einzeln in
  der Szene; die Summe steht beschriftet direkt darunter in der Kennzahlreihe.
  Ein siebtes Callout wäre Dopplung — und die Ansicht soll ruhig bleiben.
- **Verteilpunkt statt Haus als Sternmitte.** Technisch korrekt und vermeidet
  Linien quer durch das Gebäude.
- **Leitungen über dem Bild, nicht dahinter.** Dahinter wären sie auf über der
  Hälfte der Fläche unsichtbar. Die Wegführung entlang Dach, Wand und Einfahrt
  wirkt trotzdem räumlich stimmig.
- **Prozentwert und Ladebalken zeigen dasselbe.** Bewusst: Die Zahl ist genau,
  der Balken auf einen Blick erfassbar — für den Vater die wichtigere Hälfte.

## Bewusst nicht geändert

Diagramm-Ansicht, Kennzahlen, Karten, Verlauf, Kosten, Systemstatus,
Ladeprotokoll — alles unverändert. Die Hausansicht ersetzt ausschliesslich den
Inhalt der Energiefluss-Karte, wenn sie ausgewählt ist.
