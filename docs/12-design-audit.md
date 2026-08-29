# 12 – Design-Audit und Feinschliff

Vollständige Durchsicht der Oberfläche aus der Sicht eines erfahrenen
App-Teams — UI, UX, Typografie, Grössen, Positionen, Abstände, Farben,
Bedienbarkeit, Responsive-Verhalten. Anschliessend gezielte Korrekturen.
Stand: 28.08.2026.

**Keine Logik verändert.** Betroffen sind `public/styles.css`,
`public/scene.js`, Darstellungscode in `public/app.js` und eine Zeile in
`public/index.html`. Datenquellen, Fronius-/Victron-/Tuya-Anbindung,
Berechnungen, APIs, Systemstatus und der Servercode sind unberührt.
Tests: **101/101 grün**, Typecheck fehlerfrei.

**Icons unverändert.** Die Geräte-Renderings, die Emoji-Kacheln und die
gezeichneten Symbole der unteren Navigation sind bewusst so geblieben, wie sie
waren — auf ausdrücklichen Wunsch.

---

## Was gemessen wurde, nicht geschätzt

Die Befunde stammen aus Messungen an der laufenden App im Browser: gerechnete
Kontrastverhältnisse, gerenderte Schriftgrössen in echten Bildschirmpixeln,
Trefferflächen in Pixeln, Überlappungsprüfungen der SVG-Textkästen und
Überlaufprüfungen bei 320 / 360 / 375 / 390 / 414 / 430 / 768 / 1024 / 1280 /
1440 px, jeweils in beiden Farbmodi.

---

## Die neun behobenen Befunde

### 1. Die Beschriftungen der Anlage waren am Telefon 6 Pixel hoch

Der schwerwiegendste Fund. Die Hausansicht skaliert als Ganzes: 1615
Bildeinheiten auf 351 Pixeln Telefonbreite ergeben den Faktor 0,22. Die Namen
(„KLEINER SPEICHER") waren mit 29 Einheiten gesetzt — gerendert **6,3 px**.
Am Schreibtisch waren es 9,1 px, weil die Szene über die Höhe begrenzt wurde.

Sechs Angaben rund um das Haus lassen sich auf einem Telefon nicht lesbar
unterbringen. Deshalb gibt es die Beschriftungen jetzt in **zwei Anordnungen**
(`LAYOUTS` in `scene.js`); Haus, Energiewege und Ankerpunkte sind in beiden
identisch:

* **breit** (Szene ≥ 700 px) — unverändert wie bisher, sechs Angaben rundum.
* **schmal** (Telefon) — die Angaben stehen **zu zweit in Bändern** über und
  unter dem Haus und dürfen dafür doppelt so gross sein. Die linke Spalte
  wächst nach rechts, die rechte nach links; keine Angabe kann über einen Rand
  hinauslaufen.

Zusätzlich zieht das Stylesheet eine Untergrenze in **echten Bildschirmpixeln**:
`app.js` meldet über `--sc-px`, wie viele Bildeinheiten ein Pixel sind, und die
Schriftgrösse ist `max(52px, 11px * var(--sc-px))`. Auf einem 320-px-Gerät
wächst die Schrift dadurch mit, statt zu schrumpfen.

| Breite | vorher Name / Wert | nachher Name / Wert |
| --- | --- | --- |
| 320 px | 5,1 / 12,4 px | **11,0 / 23,0 px** |
| 360 px | 5,8 / 14,0 px | **11,0 / 23,0 px** |
| 390 px | 6,3 / 15,2 px | **11,3 / 24,4 px** |
| 430 px | 7,0 / 16,8 px | **12,6 / 27,1 px** |
| 1280 px | 8,6 / 20,0 px | **11,1 / 25,8 px** |
| 1440 px | 9,1 / 21,0 px | **11,1 / 25,8 px** |

Die Bandhöhe folgt der Schrift (`pitch` in `fitScene`), und der Rand der
viewBox wächst mit der eingestellten Vergrösserung. Geprüft im härtesten Fall —
320 px, Schriftgrösse „Sehr groß", längstmögliche Texte („EINSPEISUNG",
„GROSSER SPEICHER", „keine Daten"): **kein Überlauf, keine Überlappung**.

### 2. Am Schreibtisch blieben 45 % der ersten Bildschirmzeile leer

Die Anlage stand als schmale Insel in einer 1103 px breiten Zeile — gezeichnet
wurden davon 590 px. Darunter lagen die Kennzahlen als zweiter, konkurrierender
Block, der genau dieselben vier Werte noch einmal zeigte.

Ab **1140 px** bilden beide jetzt eine Einheit: die Anlage links, die Kennzahlen
als ruhige Spalte rechts daneben (`main` wird zum Raster). Die Reihenfolge im
Dokument bleibt unverändert, darunter stapelt sich alles wie bisher.

| | vorher | nachher |
| --- | --- | --- |
| gezeichnete Anlage (1440 px) | 590 × 576 px | **718 × 702 px** |
| ungenutzte Zeilenbreite | 448 px | **0 px** (Kennzahlenspalte) |

### 3. Sieben Bedienelemente waren zu klein für den Daumen

Gemessen auf einem 320-px-Gerät: Statusanzeige 26 px, Zahnrad 34 px,
„Verbinden" 30 px, Datumspfeile 38 px, Datumsfeld 33 px, „Heute"/„Gestern"
31 px, „Leistung"/„Batteriestand" 29 px. Empfohlen sind 44 px.

Auf Touchgeräten und unter 760 px haben jetzt **alle** mindestens 44 px.

### 4. Kleingedrucktes war zu blass zum Lesen

`--text-faint` lag bei 3,1 : 1 auf Weiss und 3,7 : 1 im Dunkeln — die Grenze
für Fliesstext ist 4,5 : 1. Betroffen: Quellenangaben, Zeitstempel,
Achsenbeschriftungen, Erklärtexte, Kapazitätszeilen.

Dazu zwei gefüllte Flächen: der aktive Chip „Heute" trug weisse Schrift auf
`--house` mit **3,7 : 1** (hell) bzw. **2,8 : 1** (dunkel), der aktive Reiter
der unteren Navigation lag bei 3,3 : 1.

| Token | vorher | nachher |
| --- | --- | --- |
| `--text-faint` hell | `#8a94a3` · 3,1 : 1 | `#626d81` · **4,6 : 1** |
| `--text-faint` dunkel | `#6b7686` · 3,7 : 1 | `#7f8a9c` · **4,9 : 1** |
| aktiver Chip / Reiter hell | `--house` · 3,7 : 1 | `--accent-strong` · **5,2 : 1** |
| aktiver Chip dunkel | `--house` · 2,8 : 1 | dunkle Schrift · **6,9 : 1** |

Neu sind `--ok-text`, `--warn-text`, `--danger-text`: Die Statustöne sind für
Flächen, Balken und Kurven gemacht und als kleine Schrift zu hell. Bedeutung
und Farbton bleiben, nur die Helligkeit ändert sich. Keine Textgrösse liegt
mehr unter 11 px.

Gegengeprüft: In beiden Farbmodi meldet die Prüfung über alle sichtbaren
Textknoten **keine Unterschreitung** mehr.

### 5. Bei Tastaturbedienung war nicht erkennbar, wo man steht

Nur zwei Elemente hatten eine Fokusmarkierung; bei einem Eingabefeld war sie
ausdrücklich entfernt worden (`outline: none` ohne Ersatz). Jetzt gilt eine
einzige Kennzeichnung für alles Bedienbare, und die Tarif-Kacheln zeigen den
Fokus als Ring um die ganze Kachel.

### 6. Karten einer Reihe endeten auf verschiedenen Höhen

Die Quellenzeile ist der Fuss einer Karte, stand aber dort, wo der Inhalt
zufällig endete — bei „Hausverbrauch" mitten in der Fläche. Eine Reihe wirkte
ausgefranst. Die Zeile sitzt jetzt am unteren Rand; „Gesamtspeicher" hat eine
bekommen („Beide Speicher zusammen: …"), damit auch diese Karte eine gemeinsame
Unterkante hat. Gemessener Versatz je Reihe: **0 px**.

Die Fahrzeugkarte trug deutlich mehr Zeilen als die übrigen und blieb allein in
einer eigenen Reihe zurück. Ab 620 px läuft sie über **zwei Spalten**, und ihre
Angaben stehen nebeneinander statt untereinander — die Reihe ist gefüllt, die
Karte halb so hoch.

### 7. Der Name der App wurde abgeschnitten

Bei 320 px stand dort „Smart…" neben „Alle Systeme o…". Der Status hat jetzt
eine Kurzfassung („Online", „2 offline", „Probleme"), die ab 430 px greift —
der Name bleibt immer vollständig.

### 8. Die Tarife sahen nicht aus wie Eingabefelder

Kein Rahmen, kein Grund, keine Linie: zwei Zahlen, bei denen man raten musste,
dass man sie ändern kann. Jetzt trägt jedes Feld eine Schreiblinie und einen
eigenen Grund und färbt sich beim Tippen.

Dazu eine Rangfolge der Schaltflächen: Vorher sah jede gleich aus — „Tarife
speichern" wirkte so beiläufig wie „Verbinden". Die Hauptaktion ist jetzt
gefüllt (`.btn-primary`), alles Weitere bleibt umrandet.

### 9. Bis zur ersten Messung war die Seite leer

Unterhalb der Anlage stand nichts, dann sprangen alle Karten auf einmal herein.
Jetzt steht von Anfang an die fertige Struktur da, in derselben Grösse, nur ohne
Inhalt (`renderSkeletons`). Es springt nichts mehr.

---

## Drei kleinere Korrekturen

* **„−98 % ggü. Vortag" um acht Uhr früh.** Der Vergleich stellte eine halbe
  Tagesernte einem ganzen Vortag gegenüber. Er erscheint jetzt nur noch für
  **abgeschlossene** Tage.
* **Überschrift der ersten Zeile.** „Live-Energiefluss" stand gemischt gesetzt
  über der Anlage, während „JETZT", „HEUTE" und „KOSTEN & ERSPARNIS" in ruhigen
  Versalien standen. Alle Abschnitte tragen jetzt dieselbe Überschrift.
* Ungenutzte Regeln der früheren Schriftgrössen-Taste im Kartenkopf entfernt —
  die Einstellung sitzt heute in den Einstellungen.

---

## Was bewusst nicht angefasst wurde

| | Begründung |
| --- | --- |
| Icons | Ausdrücklicher Wunsch — Geräte-Renderings, Emoji und Linien-Symbole bleiben wie sie waren. |
| Anordnung der Anlage im Breitformat | Vom Benutzer abgenommen; sie funktioniert dort und ist unverändert. |
| Backend, Datenlogik, APIs | Ausserhalb der Aufgabe. |
| Sonne/Mond-Auslöser | Bleibt an der PV-Leistung mit Hysterese, nicht am Farbmodus. |
| Kennzahlenleiste inhaltlich | Zeigt weiter dieselben sechs Werte; sie ist die genaue Ableseebene neben dem Bild. |

---

## Geprüfte Zustände

| | |
| --- | --- |
| Breiten | 320 · 360 · 375 · 390 · 414 · 430 · 768 · 1024 · 1140 · 1280 · 1440 px |
| Farbmodi | hell und dunkel, jeweils vollständig |
| Ansichten | Hausansicht und Diagramm, Fahrzeug-Detail, Einstellungen, Systemstatus |
| Schriftgrössen | Normal · Groß · Sehr groß, je Anordnung |
| Grenzfälle | längstmögliche Texte, „keine Daten", fehlende Speicher, Wallbox offline |
| Seitlicher Überlauf | **0 px** in allen geprüften Breiten |

---

## Bei künftigen Änderungen beachten

* Die Hausansicht hat **zwei** Anordnungen. Wer an `CALLOUTS` etwas ändert,
  muss `LAYOUTS.narrow` mitziehen — und umgekehrt.
* Die Schwelle zwischen beiden ist die Breite des **SVG**, nicht die des
  Fensters (`WIDE_MIN_PX`, 700 px). In der zweispaltigen Desktop-Anordnung ist
  die Szene deutlich schmaler als der Bildschirm; deshalb setzt diese Anordnung
  erst bei 1140 px ein — sonst fiele die Anlage auf einem Laptop in die
  schmale Anordnung.
* Neue Farbtöne für **Text** gegen den dunkelsten Untergrund prüfen, auf dem
  sie vorkommen — das ist der Seitenhintergrund, nicht die weisse Karte.
* Neue Bedienelemente brauchen unter 760 px `min-height: 44px`.
