# 14 – Speicherangaben, Kabelführung und Größenumschaltung

> **Teilweise überholt.** Die Speicherangaben (Prozent, Leistung, Zustand) und
> die Staffelung rechts gelten weiter. Die Wegführung der Zuleitungen und die
> Größenumschaltung wurden am selben Tag noch einmal überarbeitet: alle Wege
> rechtwinklig, seitliche Andockpunkte, kein Knopf mehr in der Ansicht,
> feinere Grundschrift. Massgeblich ist
> **[15 – Linienführung, Andockpunkte und Schriftgrad](15-linienfuehrung.md)**.

Dritter Durchgang an der Hausansicht: Leistung bei den Speichern, neue
Staffelung rechts, Kabel von unten, Linien am Telefon zurück und die
Größenumschaltung wieder auffindbar.
Stand: 28.08.2026.

**Keine Logik verändert.** Betroffen sind `public/scene.js`, `public/styles.css`,
Darstellungscode in `public/app.js` und eine Zeile in `public/index.html`.
Datenquellen, Fronius-/Victron-/Tuya-Anbindung, Berechnungen, APIs,
Statuslogik und der Servercode sind unberührt. Icons unverändert.
Tests: **101/101 grün**, Typecheck fehlerfrei.

---

## Was gefehlt hat — Befunde aus dem Code

| Punkt | Befund |
| --- | --- |
| Lade-/Entladeleistung bei den Speichern | In der Hausansicht stand nie mehr als `formatSoc(...)`. Die Leistung liegt in den Daten (`chargeW`, `dischargeW`, `state`) und wurde im Diagramm und in den Karten längst gezeigt — nur im Bild nicht. |
| Größenumschaltung | **Funktionierte**, war aber nur in den Einstellungen erreichbar. Die frühere Taste im Kopf der Karte war irgendwann aus `index.html` verschwunden; ihre Stile lagen noch ungenutzt herum. |
| Linien am Telefon | Von mir im vorigen Durchgang entfernt, weil jede Führung einen Rahmen um das Haus ergab. |

---

## 1 · Speicher zeigen jetzt Prozent **und** Leistung

Jede Angabe hat eine dritte Zeile bekommen, die sagt, was das Gerät gerade
**tut**:

```
GROSSER SPEICHER          KLEINER SPEICHER
87 %                      64 %
entlädt 450 W             lädt 1,2 kW
```

Sie nutzt `batState()` — denselben Text und dieselben Formatierer wie das
Diagramm und die Karten darunter. Beim Fahrzeug steht dort der
Anschlusszustand („kein Fahrzeug“, „lädt“), beim Haus „Verbrauch“.

Damit beantwortet die Ansicht auf einen Blick alle drei Fragen: **wie voll**
(Prozent und Balken), **ob geladen oder entladen wird** (Wort) und **mit
welcher Leistung** (kW/W). Auf dem Schreibtisch wie am Telefon.

## 2 · Rechte Seite neu gestaffelt

Wie gewünscht steht der **große Speicher oben, der kleine direkt darunter**.
Das passt auch zur Szene: Im Bild steht der große Speicher weiter rechts, der
kleine näher am Haus.

Die linke Spalte (Haus, Auto) liegt auf denselben zwei Höhen — die vier
seitlichen Angaben bilden ein sauberes Raster aus zwei Zeilen.

## 3 · Kabel kommen von unten

Alle vier seitlichen Angaben liegen jetzt **unter** ihrem Gerät. Die Zuleitung
verlässt den farbigen Strich waagrecht und **steigt dann senkrecht in das
Gerät auf** — wie ein Kabel aus einer unteren Verteilerebene. Die zwei Angaben
über dem Dach (PV, Netz) kommen entsprechend von oben herab.

Liegt das Gerät genau über dem Strich, entfällt sogar der Knick: Das Kabel
steigt direkt aus der farbigen Linie auf, wie aus einer Sammelschiene.

## 4 · Linien am Telefon sind zurück

Der Schlüssel ist eine kleine Umkehrung: In den unteren Bändern steht die
Schrift jetzt **unter** ihrem Strich statt darüber. Dadurch verlässt die
Zuleitung den Strich nach oben und kann ihren eigenen Wert gar nicht mehr
treffen — genau das Problem, an dem die alte Führung scheiterte.

Für das zweite Band reicht das nicht, weil dort die Beschriftung des ersten
Bandes im Weg steht. Sein Kabel steigt deshalb durch die **freie Gasse**
zwischen der linken und der rechten Angabe auf. Wo diese Gasse liegt, hängt
von der Textlänge ab und wird zur Laufzeit **gemessen**, nicht angenommen.
Zwei Kabel in derselben Gasse werden auseinandergelegt, damit sie nicht wie
eines aussehen; reicht der Platz nicht, wird die Zeile etwas kleiner gesetzt,
statt die Kabel zusammenzuschieben.

Kein Rahmen ums Haus, keine Linie durch eine Zahl — und die visuelle
Verbindung ist wieder da.

## 5 · Größenumschaltung wieder auffindbar

Die Taste steht wieder im Kopf der Karte („**A** Normal / Groß / Sehr groß“)
und schaltet der Reihe nach durch. Der Segmentschalter in den Einstellungen
bleibt und wählt direkt. **Beide Wege ändern dieselbe gespeicherte
Einstellung** — wer über die Taste schaltet, sieht das offene Einstellungsblatt
mitziehen.

Eingeschaltete Vergrößerung ist der Taste anzusehen (gefüllt statt umrandet).

## 6 · Desktop und Telefon: gleiche Sprache, eigene Form

| | Schreibtisch | Telefon |
| --- | --- | --- |
| Anordnung | zwei Spalten seitlich, zwei Angaben über dem Dach | zwei Bänder unter dem Haus, zwei über dem Dach |
| Schrift zum Strich | darüber | in den unteren Bändern darunter |
| Kabel | waagrecht heraus, dann senkrecht ins Gerät | senkrecht heraus, bei Bedarf durch die gemessene Gasse |
| Speicher | Großer oben, Kleiner darunter | Kleiner oben, Großer darunter (Kabelwege) |
| Dritte Zeile | ja | ja |

Gleiches Bild, gleiche Typografie, gleiche Farblogik — aber jeweils die Form,
die auf der Fläche funktioniert.

---

## Geprüft

Ein Prüfskript tastet **jede** Linie ab (Zuleitungen, Energiewege, Fassungen)
und rechnet jeden Punkt gegen **jede** Textbox — Name, Wert und die neue
dritte Zeile. Zusätzlich: Zuleitungen gegeneinander (Mindestabstand),
Textboxen untereinander, Passung in die Zeichenfläche, Zentrierung.

Jeder Durchlauf mit den echten Live-Werten **und** mit den längstmöglichen
Texten („keine Daten“, „10,0 kW“, „EINSPEISUNG“, „GROSSER SPEICHER“,
„entlädt 10,0 kW“).

| Breite | Anordnung | Haus | Mitte | Linien durch Text | Kabel zu nah | Name / Wert / Zustand |
| --- | --- | --- | --- | --- | --- | --- |
| 320 px | schmal | 249 px | **0 px** | **keine** | **keine** | 11,0 / 23,0 / 12,0 px |
| 360 px | schmal | 284 px | **0 px** | **keine** | **keine** | 11,0 / 23,0 / 12,0 px |
| 375 px | schmal | 293 px | **0 px** | **keine** | **keine** | 11,0 / 23,0 / 12,0 px |
| 414 px | schmal | 327 px | **0 px** | **keine** | **keine** | 11,4 / 24,6 / 12,3 px |
| 430 px | schmal | 341 px | **0 px** | **keine** | **keine** | 11,9 / 25,7 / 12,8 px |
| 768 px | schmal | 594 px | **0 px** | **keine** | **keine** | 15,0 / 31,0 / 16,0 px |
| 1024 px | breit | 610 px | **0 px** | **keine** | **keine** | 11,0 / 23,8 / 12,0 px |
| 1280 px | breit | 683 px | **0 px** | **keine** | **keine** | 11,5 / 26,7 / 12,4 px |
| 1440 px | breit | 715 px | **0 px** | **keine** | **keine** | 12,0 / 27,9 / 13,0 px |

Dazu in beiden Farbmodi, in allen drei Schriftgrößen (Normal · Groß · Sehr
groß), in beiden Ansichten (Haus und Diagramm) und mit einem eingespeisten
Ladezustand („lädt 1,2 kW“ / „entlädt 450 W“, Balken auf 64 % und 87 %).

### Zwei Fehler, die dabei aufgefallen sind

* Bei 320 px mit größter Schrift lagen die beiden Kabel des zweiten Bandes
  **7 Einheiten** nebeneinander — sie sahen aus wie eines. Ursache: Die Gasse
  wurde auch von den Angaben über dem Dach eingeengt, an denen die Kabel gar
  nicht vorbeikommen. Jetzt zählen nur die Bänder unter dem Bild, und die
  Kabel werden über die Gasse verteilt.
* Mit der dritten Zeile ragte der untere Block bei 320 px **115 Einheiten**
  aus der Zeichenfläche. Sie wächst jetzt unten mit, wenn der gemessene Inhalt
  mehr braucht — nur in der schmalen Anordnung, wo der Maßstab allein an der
  Breite hängt und sich das nicht aufschaukeln kann.

---

## Bei künftigen Änderungen beachten

* Die dritte Zeile ist optional (`note: true`). Wer sie irgendwo ergänzt, muss
  den Rand prüfen — sie macht den Textblock höher, und der Bandabstand folgt
  der gemessenen Blockhöhe.
* Am Telefon steht die Schrift der unteren Bänder **unter** dem Strich
  (`below: true`). Das ist keine Geschmacksfrage: Kehrt man es um, läuft jede
  Zuleitung wieder durch ihren eigenen Wert.
* Die Gasse wird gemessen (`fitRows` → `channel`). Neue Angaben in den unteren
  Bändern verengen sie. Wer dort etwas ergänzt, sollte die Prüfung mit den
  längstmöglichen Texten wiederholen.
* Die Größenumschaltung hat **zwei** Bedienwege auf **eine** Einstellung. Wer
  einen ändert, muss den anderen mitziehen (`applyFlowZoom` führt die Taste
  nach, der Tastendruck zeichnet ein offenes Einstellungsblatt neu).
