# 13 – Komposition der Live-Energiefluss-Ansicht

> **Teilweise überholt.** Die Grundsätze gelten weiter (Haus exakt mittig,
> gleiche Seitenränder, keine Linie durch Text). Die konkrete Anordnung wurde
> am selben Tag noch einmal überarbeitet: Speicher rechts gestaffelt, Kabel von
> unten, Linien am Telefon zurück, dritte Zeile mit der Lade-/Entladeleistung.
> Massgeblich ist **[14 – Speicherangaben, Kabelführung und Größenumschaltung](14-speicher-und-kabelfuehrung.md)**.

Neuordnung der Hausansicht: Haus exakt mittig, Angaben ruhig darum herum,
und keine Linie mehr durch Text oder Zahlen.
Stand: 28.08.2026.

**Keine Logik verändert.** Betroffen sind `public/scene.js` (Geometrie der
Beschriftungen und Wegführung), `public/styles.css` und die Anbindung in
`public/app.js`. Datenquellen, Fronius-/Victron-/Tuya-Anbindung, Berechnungen,
APIs, Statuslogik und der Servercode sind unberührt. Icons unverändert.
Tests: **101/101 grün**, Typecheck fehlerfrei.

---

## Das Problem

Jede Angabe hing über eine Zuleitung an ihrem Gerät im Bild. Die Zuleitung war
eine **Gerade** vom farbigen Strich der Beschriftung zum Gerät.

Bei den Angaben unter dem Haus liegt das Gerät ÜBER der Beschriftung — die
Schrift aber ebenfalls über dem Strich. Die Gerade musste also zwangsläufig
durch den eigenen Wert und häufig durch den Namen daneben. Genau das war die
Linie, die sich durch die Zahlen schlängelte. Gemessen: vier solcher
Durchläufe, unter anderem die Zuleitung des grossen Speichers quer durch
„KLEINER SPEICHER".

Dazu kam: Das Haus stand nicht in der Mitte. Die Kennzahlen lagen am Desktop
als Spalte daneben, wodurch das Haus in die linke Bildhälfte rutschte.

---

## Die neue Komposition

### Am Schreibtisch — zwei ruhige Spalten

```
                  PV                NETZ
               ─────────         ─────────
                   │                 │
   HAUS ──┐   ┌─────────────────────────────┐   ┌── KLEINER SPEICHER
       ───┴───┤                             ├───┴───
              │        D A S   H A U S      │
   AUTO ──┐   │                             │   ┌── GROSSER SPEICHER
       ───┴───┤                             ├───┴───
              └─────────────────────────────┘
```

Die sechs Angaben stehen als **zwei Spalten links und rechts** neben dem Haus
und **zwei über dem Dach**. Beide Seitenränder sind exakt gleich breit —
dadurch liegt die Bildmitte (x 742,5) genau auf der Mitte der Zeichenfläche.

Das ist kein Augenmass, sondern Rechnung: `sceneViewBox()` setzt links und
rechts denselben Rand, auch wenn die Schriftvergrösserung ihn wachsen lässt.
Gemessen bei jeder geprüften Breite: **0 px Abweichung** zwischen Bildmitte und
Seitenmitte.

Der Nebeneffekt ist deutlich: Die Szene ist jetzt breiter als hoch und füllt
die Zeile aus, statt als schmale Insel darin zu stehen.

| | vorher | nachher |
| --- | --- | --- |
| Haus bei 1440 px | 590 px breit | **746 px** |
| Haus bei 1280 px | 590 px | **719 px** |
| genutzte Zeilenbreite | 53 % | **100 %** |
| Abweichung von der Mitte | bis 150 px | **0 px** |

### Die Zuleitungen laufen rechtwinklig

Jede Zuleitung verlässt ihren Strich **waagrecht**. Über dem Strich steht die
Schrift, darunter ist frei — die Linie kann ihren eigenen Wert also gar nicht
erst treffen. Danach biegt sie einmal rechtwinklig zum Gerät ab, mit
abgerundeter Ecke.

Weil die Angaben seitlich stehen, reicht dieser eine Knick. Die sechs Wege sind
einzeln so gelegt, dass sie sich auch **untereinander** nicht kreuzen.

### Am Telefon — ohne Zuleitungen

Seitliche Spalten würden das Haus auf ein Drittel der Breite drücken. Am
Telefon stehen die Angaben deshalb weiter in Bändern über und unter dem Haus,
zu zweit nebeneinander.

Dort lassen sich sechs Zuleitungen **nicht** sauber führen. Das Gerät liegt bei
den unteren Angaben über der Schrift; die Zuleitung müsste entweder durch den
eigenen Wert (das alte Problem) oder aussen um die Schrift herum. Aussen herum
ergeben vier Wege einen **Rahmen um das Haus** — genau die Kiste, die in dieser
Ansicht nie entstehen soll. Beides wurde gebaut und wieder verworfen.

Die Zuleitung trägt am Telefon ohnehin keine Information: Jede Angabe nennt ihr
Gerät beim Namen („KLEINER SPEICHER", „AUTO"), und der farbige Strich hat
dieselbe Farbe wie der Punkt am Gerät im Bild — die Punkte tragen dafür jetzt
einen farbigen Ring statt eines grauen. Weglassen macht die Ansicht ruhiger,
ohne dass etwas unklar wird.

Auch hier ist der Rand links und rechts gleich: **0 px Abweichung** von der
Mitte, bei jeder geprüften Breite.

### Sicherung gegen zusammenstossende Angaben

In den Bändern am Telefon stehen zwei Angaben nebeneinander. Ihre Breite hängt
vom Text ab, und der ist nicht in unserer Hand: Ein Speicher kann in
`config.json` umbenannt werden, ein Wert vierstellig werden, die Schrift ist
einstellbar. Reicht der Platz nicht, setzt `fitRows()` **beide** Angaben der
Zeile im selben Verhältnis kleiner — dann rückt nichts ineinander und die Zeile
bleibt in sich einheitlich.

Gefunden wurde das beim Prüfen: 320 px, Schriftgrösse „Sehr groß", längste
Texte — dort stiessen „keine Daten" und „10,0 kW" im obersten Band zusammen.
Mit der Sicherung stehen sie bei 12,3 statt 13,3 px und haben Luft.

---

## Geprüft, nicht geschätzt

Ein Prüfskript tastet **jede** Linie der Szene ab — Zuleitungen, Energiewege
und deren dunkle Fassung — und rechnet jeden Abtastpunkt gegen **jede**
Textbox. Zusätzlich prüft es die Zuleitungen gegeneinander, die Textboxen
untereinander, die Passung in die Zeichenfläche und die Zentrierung.

Durchlauf jeweils mit den echten Live-Werten **und** mit den längstmöglichen
Texten („keine Daten", „10,0 kW", „EINSPEISUNG", „GROSSER SPEICHER", „100 %").

| Breite | Anordnung | Haus | Abweichung Mitte | Linien durch Text | Name / Wert |
| --- | --- | --- | --- | --- | --- |
| 320 px | schmal | 249 px | **0 px** | **keine** | 11,0 / 23,0 px |
| 360 px | schmal | 284 px | **0 px** | **keine** | 11,0 / 23,0 px |
| 375 px | schmal | 296 px | **0 px** | **keine** | 11,0 / 23,0 px |
| 390 px | schmal | 306 px | **0 px** | **keine** | 11,0 / 23,1 px |
| 414 px | schmal | 327 px | **0 px** | **keine** | 11,4 / 24,6 px |
| 430 px | schmal | 341 px | **0 px** | **keine** | 11,9 / 25,7 px |
| 768 px | schmal | 594 px | **0 px** | **keine** | 15,0 / 31,0 px |
| 1024 px | breit | 636 px | **0 px** | **keine** | 11,0 / 24,9 px |
| 1280 px | breit | 719 px | **0 px** | **keine** | 12,6 / 29,1 px |
| 1440 px | breit | 746 px | **0 px** | **keine** | 12,6 / 29,1 px |
| 1680 px | breit | 757 px | **0 px** | **keine** | 12,7 / 29,6 px |

Zusätzlich in beiden Farbmodi, in beiden Ansichten (Haus und Diagramm) und in
allen drei Schriftgrössen. Kein seitlicher Überlauf, keine Textüberlappung,
keine Zuleitung kreuzt eine andere, alles innerhalb der Zeichenfläche.

---

## Was sonst noch anders ist

* Die **Kennzahlenleiste** steht wieder als ruhige Zeile unter der Anlage. Sie
  stand zwischenzeitlich als Spalte daneben, um die damals halbleere Zeile zu
  füllen — das ist nicht mehr nötig, und als Spalte daneben stand das Haus
  nicht mehr in der Mitte.
* Die **Ankerpunkte** am Gerät tragen den Farbring ihrer Angabe. Am Telefon,
  wo es keine Zuleitung mehr gibt, ist das neben dem Namen die Verbindung
  zwischen Bild und Wert.
* Die Anordnung wechselt bei **800 px SVG-Breite** (vorher 700). Darunter wäre
  in der breiten Anordnung für das Haus zu wenig übrig, weil die Spalten
  seitlich Platz brauchen.
* Etwas Luft zwischen Überschrift und Zeichenfläche — die oberste Angabe begann
  direkt an deren Oberkante.

---

## Bei künftigen Änderungen beachten

* Die beiden Ränder der breiten Anordnung müssen **gleich gross bleiben**.
  Sobald links und rechts verschieden sind, driftet das Haus aus der Mitte.
* Eine neue Zuleitung muss ihren Strich **waagrecht** verlassen und darf danach
  nur einmal abbiegen. Wer eine Gerade einsetzt, holt das alte Problem zurück.
* Am Telefon gibt es bewusst **keine** Zuleitungen (`LAYOUTS.narrow.leads =
  false`). Wer sie wieder einschaltet, bekommt entweder Linien durch Zahlen
  oder einen Rahmen um das Haus.
* Nach jeder Änderung an `LAYOUTS` gegen die längstmöglichen Texte prüfen, nicht
  gegen die gerade anliegenden Werte.
