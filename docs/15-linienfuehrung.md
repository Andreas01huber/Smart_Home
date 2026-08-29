# 15 – Linienführung, Andockpunkte und Schriftgrad

Vierter Durchgang an der Hausansicht: ein einheitliches System für alle
Zuleitungen, seitliche Andockpunkte statt Linien durch die Geräte, kein
Schriftgrössen-Knopf mehr in der Ansicht und eine Stufe feinere Grundschrift.
Stand: 28.08.2026.

**Keine Logik verändert.** Betroffen sind `public/scene.js` (Geometrie),
`public/styles.css` (Schriftgrade), `public/app.js` (Anzeige) und eine Zeile in
`public/index.html`. Datenquellen, Fronius-/Victron-/Tuya-Anbindung,
Berechnungen, APIs, Statuslogik und der Servercode sind unberührt. Icons
unverändert. Tests: **101/101 grün**, Typecheck fehlerfrei.

---

## Der Befund: die Schrägen waren ein Fehler, kein Entwurf

`leadPoints()` setzte den Knick einer Zuleitung nur dann, wenn das Gerät
ausserhalb der Breite des Beschriftungsstrichs lag **und** eine Gasse oder eine
Abbiegehöhe vorgegeben war. Traf beides nicht zu, blieben von der Wegführung
nur Anfangs- und Endpunkt übrig — und daraus wurde eine **Gerade quer durch die
Szene**.

Betroffen waren vier der sechs Angaben:

| Angabe | vorher | Wirkung |
| --- | --- | --- |
| PV | Gerade (0,−159) → (722,159) | Schräge über den ganzen Giebel |
| Haus | Gerade (0,1035) → (411,601) | Schräge quer durch den Vorgarten |
| Haus, Auto, beide Speicher am Schreibtisch | Geraden | dieselbe Schräge, nur länger |

Dass Auto und grosser Speicher am Telefon gefielen, war kein Zufall: Genau die
beiden hatten eine `channel`-Angabe und liefen deshalb als einzige rechtwinklig.

Zwei weitere Angaben hatten ein anderes, feineres Problem: Sie dockten **in
Verlängerung ihres eigenen Energiewegs** an.

* Der lila Netzweg verlässt den Mast senkrecht nach unten — die Zuleitung kam
  ebenfalls senkrecht von oben. Beides zusammen ergab **einen** langen Strich,
  der durch den Mast hindurchzugehen schien.
* Der Speicherweg des kleinen Speichers steigt senkrecht zum Wechselrichter
  auf — die Zuleitung kam senkrecht von unten. Dasselbe Bild: eine Linie mitten
  durch den Schrank.

---

## Das System

Jede Zuleitung besteht aus höchstens drei Stücken und kennt nur zwei
Richtungen. Abgerundete Ecken, keine Schrägen, nirgends:

```
   1 · AUSTRITT        auf der Höhe des eigenen Strichs weiter,
                       als wäre der Strich das erste Stück Kabel

   2 · STEIGLEITUNG    ein senkrechtes Stück auf bewusst gewählter Lage
                       (`riser` fest, `channel` in der gemessenen Gasse)

   3 · ANSCHLUSS       ein kurzes Stück quer in das Gerät,
                       immer von einer festgelegten Seite
```

Stücke ohne Länge fallen weg — steht das Gerät genau über dem Strich, bleibt
eine einzige senkrechte Linie, wie ein Kabel aus einer Sammelschiene.

### Die Andockseiten

Die Regel dahinter: **Wo der Energieweg das Gerät verlässt, kommt die Zuleitung
nicht an.**

| Gerät | Energieweg geht … | Zuleitung kommt … |
| --- | --- | --- |
| PV-Dach | nach unten rechts zum Wechselrichter | von oben |
| Netzmast | senkrecht nach unten | von rechts |
| Haus | von rechts oben heran | von unten |
| Auto | von rechts heran | von unten |
| Kleiner Speicher | senkrecht nach oben | von rechts |
| Grosser Speicher | nach links oben | von rechts (breit) / von oben (schmal) |

Die Steigleitung zum kleinen Speicher liegt in der **Lücke zwischen den beiden
Speicherschränken** (Bildmass 1062 … 1130, Mitte 1096). Sie kommt damit von
rechts an den Schrank — wie gewünscht — und liegt zugleich nicht mehr auf dem
eigenen Energieweg.

Am Netzmast liegt der Abstieg in **beiden** Anordnungen rechts vom Mast. Am
Schreibtisch steht dort die Sonne (Scheibe 1350 … 1500, bis y −87); das obere
Band liegt deshalb auf −50 statt −80, dann läuft das Kabel mit 47 Einheiten
Abstand an der Scheibe vorbei statt sie zu streifen.

### Zwei Kabelebenen am Schreibtisch

Die vier seitlichen Angaben stehen auf zwei Höhen (684 und 1060). Diese Höhen
sind zugleich die waagrechten Kabelebenen: Jede Zuleitung läuft auf der Höhe
ihres eigenen Strichs in die Szene und biegt erst dort ab. Im ganzen Bild gibt
es dadurch **zwei waagrechte und vier senkrechte Spuren** statt sechs freier
Wege.

### So wenige Knicke wie die Geometrie zulässt

| Angabe | Knicke breit | Knicke schmal | warum nicht weniger |
| --- | --- | --- | --- |
| Grosser Speicher | **0** | 3 | breit: `level` legt die Mitte des Ladebalkens auf die Höhe des Geräts, Balken und Kabel sind ein Strich. Schmal muss das Kabel erst durch die Gasse aufsteigen und über beide Schränke hinweg. |
| PV, Haus, Auto | 1 | 0–2 | ein Knick zwischen Kabelebene und Gerät |
| Netz | 2 | 2 | seitlicher Anschluss quer zum lila Energieweg |
| Kleiner Speicher | 2 | 2 | auf seiner Höhe steht der grosse Schrank im Weg; von unten läge das Kabel auf dem eigenen Energieweg |

`level: true` ist der Sonderfall, der die gerade Linie möglich macht. Es steht
nicht in `LAYOUTS`, weil die Strichhöhe mit der Schriftgrösse wächst — die Lage
wird deshalb in `fitScene` aus der gemessenen Höhe berechnet. Ergebnis: null
Knicke in **allen drei** Schriftgrössen.

### Zuleitungen liegen jetzt unter den Energiewegen

Sie sind Hilfslinien, kein Inhalt. Kreuzt eine von ihnen einen Energieweg,
deckt der farbige Weg sie zu, statt dass ein dünner grauer Strich über die
Hauptsache läuft.

---

## Kein Schriftgrössen-Knopf mehr in der Ansicht

Die Taste im Kartenkopf ist entfernt — samt Stilen, Ereignisbehandlung und
`aria-label`. Die Einstellung selbst bleibt unverändert erhalten und wird in
den **Einstellungen** gewählt (Normal · Groß · Sehr groß); sie wirkt weiterhin
auf beide Ansichten und wird gespeichert. In der Live-Ansicht steht damit
nichts mehr, was nicht zur Anlage gehört.

## Eine Stufe feinere Grundschrift

„Normal" ist jetzt spürbar ruhiger. Grosse Zahlen wirken schnell grob; in
dieser Grösse bleibt alles klar lesbar, tritt aber hinter die Anlage zurück.

| | vorher | nachher |
| --- | --- | --- |
| Name in der Szene | 11 px | **10 px** |
| Wert in der Szene | 22 px | **20 px** |
| Zustandszeile | 12 px | **11 px** |
| Kennzahlenleiste | 24 px | **22 px** |
| Kartenwert | 32 px | **28,8 px** |
| Tageswert | 20,8 px | **19,2 px** |
| Name im Diagramm | 14,5 px | **13,5 px** |

Dazu etwas mehr Laufweite im Namen (0,06 → 0,075 em), etwas weniger Fettung im
Wert (750 → 740) und schmalere Halos — bei kleinerer Schrift wirkt ein breiter
Halo sonst wie ein Schatten.

---

## Geprüft

Ein Prüfskript tastet **jede** Linie ab (Zuleitungen, Energiewege, Fassungen)
und rechnet jeden Punkt gegen **jede** Textbox. Zusätzlich: Zuleitungen
gegeneinander (Mindestabstand 60 Einheiten), Textboxen untereinander, Passung
in die Zeichenfläche, Zentrierung. Jeder Durchlauf mit den echten Live-Werten
**und** mit den längstmöglichen Texten („keine Daten", „10,0 kW",
„EINSPEISUNG", „GROSSER SPEICHER", „entlädt 10,0 kW").

| Breite | Anordnung | Haus | Mitte | Linien durch Text | Kabel zu nah | Name / Wert / Zustand |
| --- | --- | --- | --- | --- | --- | --- |
| 320 px | schmal | 249 px | **0 px** | **keine** | **keine** | 10,0 / 20,0 / 11,0 px |
| 360 px | schmal | 284 px | **0 px** | **keine** | **keine** | 10,0 / 20,0 / 11,0 px |
| 375 px | schmal | 293 px | **0 px** | **keine** | **keine** | 10,0 / 20,0 / 11,0 px |
| 414 px | schmal | 327 px | **0 px** | **keine** | **keine** | 10,3 / 21,6 / 11,2 px |
| 430 px | schmal | 341 px | **0 px** | **keine** | **keine** | 10,8 / 22,5 / 11,7 px |
| 768 px | schmal | 594 px | **0 px** | **keine** | **keine** | 13,5 / 27,0 / 14,5 px |
| 1024 px | breit | 638 px | **0 px** | **keine** | **keine** | 10,0 / 22,8 / 11,0 px |
| 1280 px | breit | 715 px | **0 px** | **keine** | **keine** | 11,1 / 25,5 / 11,6 px |
| 1440 px | breit | 715 px | **0 px** | **keine** | **keine** | 11,1 / 25,5 / 11,6 px |
| 1680 px | breit | 755 px | **0 px** | **keine** | **keine** | 11,7 / 26,9 / 12,2 px |

Jede Breite zusätzlich in **allen drei Schriftgrössen**. Alles sauber.

### Drei Fehler, die dabei aufgefallen sind

* **Zwei Kabel 32 Einheiten nebeneinander** bei 320 px, „Sehr groß", längsten
  Texten. Zwei Ursachen, beide behoben:
  1. Die freie Gasse wurde aus **beiden** unteren Bändern gemittelt. Nur das
     erste zählt — an der Schrift des zweiten kommt kein Kabel vorbei, weil sie
     unter dessen eigenem Strich steht. Der Durchschnitt zweier gegeneinander
     versetzter Lücken war viel enger als jede einzelne.
  2. Passten die Wunschlagen nicht in die Gasse, wurden die Kabel **gleichmässig
     verteilt**. Das nahm beiden ihre gerade Zufahrt und erzeugte Querversätze,
     von denen einer neben der Steigleitung des anderen endete. Jetzt rückt die
     Gruppe geschlossen an den Rand der Gasse und behält ihren Mindestabstand.
* **Die Zeile, durch die Kabel steigen, braucht mehr Luft** als eine gewöhnliche
  Zeile: 380 statt 300 Einheiten. Sonst wird die Gasse so schmal, dass beide
  Kabel ihre Lage verlieren.
* **„keine Daten" ragte 9 bzw. 18 Einheiten über den linken Rand** der breiten
  Anordnung in den beiden vergrösserten Stufen. Der seitliche Rand wächst jetzt
  mit Faktor 310 statt 250 mit.

---

## Nachtrag: Feinschliff am Telefon (visueller Durchgang)

Bis hierher war alles gerechnet. Dieser Durchgang entstand aus dem Bild: Die
Ansicht wurde als PNG gerendert und wie ein Screenshot beurteilt. Drei Dinge
fielen dabei auf, die keine Messung findet.

**1 · Zwei Steigleitungen liefen fast parallel.** Auto (765) und grosser
Speicher (880) stiegen über die ganze Höhe des Vorplatzes nebeneinander auf —
115 Einheiten, am Telefon **24 Pixel**. Zwei fast gleiche senkrechte Striche so
dicht beieinander lesen sich als Fehler, nicht als System. Der grosse Speicher
liegt jetzt auf **940**, dem äussersten Platz der gemessenen Gasse; der Abstand
ist damit fast doppelt so gross.

**2 · Der Weg zum Netzmast war zu lang.** Die beiden Angaben über dem Dach
standen 170 Einheiten über dem Bild, dazwischen lag leerer Himmel, und das
Netzkabel musste die ganze Strecke überbrücken — ein dünner Strich, der sich am
Mast entlangzog. Beide Angaben stehen jetzt auf **−60** statt −170, der obere
Rand schrumpft von 380 auf **280**. Der Weg zum Mast wird dadurch ein Viertel
kürzer und liest sich als kurze, bewusste Klammer.

**3 · Die Sonne stand der Netz-Angabe im Weg.** Am Schreibtisch hat sie die
leere obere rechte Ecke für sich; am Telefon gibt es diese Ecke nicht, dort
steht die Netz-Angabe. Die Sonne sass genau zwischen Angabe und Mast, und das
Kabel lief zwischen beiden hindurch. Sie steht jetzt **tiefer, in der
Himmelslücke zwischen Dachfirst und Mast** (1010 / 110, Scheibe 7,3 % statt
8,1 %). Diese Lücke war vorher tote Fläche, die obere rechte Ecke gehört jetzt
allein der Netz-Angabe.

Ausserdem: Abbiegehöhe des grossen Speichers 575 → **558**, weil die Linie bei
575 den Deckel des vorderen Schranks streifte.

Am Schreibtisch wurde nichts davon geändert — er war die Referenz.

### Warum der Schreibtisch ruhiger wirkte — und was daraus folgte

Gemessen an derselben Szene:

| | Schreibtisch (800 px) | Telefon (390 px) vorher | Telefon nachher |
| --- | --- | --- | --- |
| Haus, Anteil der Breite | 46 % | 77 % | 79 % |
| Wert „1,4 kW", Anteil der Breite | 2,8 % | **5,6 %** | **4,6 %** |

Das war der eigentliche Unterschied: Am Schreibtisch trägt das Haus das Bild
und die Zahlen flüstern. Am Telefon waren die Zahlen doppelt so dominant und
das Haus stand gedrängt zwischen ihnen. Zwei Stellschrauben, beide nur in der
schmalen Anordnung:

* **Seitenrand 110 → 60.** Am Telefon stehen die Angaben unter dem Haus, nicht
  daneben — der breite Seitenrand hat dort nur Platz verschenkt. Das Haus wird
  dadurch 8 … 10 % grösser (bei 390 px von 299 auf 322 px).
* **Schrift eine Stufe feiner:** Wert 20 → **18 px**, Name 10 → **9,5 px**,
  Zustand 11 → **10,5 px**. Das Verhältnis Haus zu Zahl verbessert sich um rund
  ein Fünftel, ohne dass etwas schlechter lesbar wird.
* **Bänder 1030 → 1060**, unterer Rand 640 → 620: 15 px Luft zwischen
  Grundplatte und erster Angabe statt 9 — der Block klebte vorher am Bild.
* **Der warme Lichtschein** (`sc-sunwash`) reicht jetzt bis 390 statt 415
  Einheiten. Mit dem schmaleren Rand ragte er 20 Einheiten über die
  Zeichenfläche hinaus; dort hätte der Rand eine sichtbare Kante hineingeschnitten.

### Speicher getauscht — und die lange Querlinie fiel weg

Am Telefon stand der **kleine** Speicher im ersten Band und der **grosse** im
zweiten. Daraus folgte zwangsläufig die unruhigste Linie der ganzen Szene: Das
Kabel des grossen Speichers musste aus der Gasse aufsteigen, oberhalb **beider**
Schränke waagrecht die halbe Szene queren und von oben in sein Gerät fallen —
drei Knicke, drei gekreuzte Energiewege.

Mit der getauschten Reihenfolge (**grosser Speicher oben, kleiner darunter**)
löst sich das von selbst:

| | vorher | jetzt |
| --- | --- | --- |
| Grosser Speicher | Band 2, Gasse → 558 quer → von oben, **3 Knicke** | Band 1, Steigleitung 1330 über den Rasen → von rechts, **2 Knicke** |
| Kleiner Speicher | Band 1, Lücke zwischen den Schränken → von rechts | Band 2, Gasse 920 → von links, **2 Knicke** |
| Lange Querlinie | ja, y = 558 über beide Schränke | **keine** |

Der grosse Speicher hat damit am Telefon **dieselbe Führung wie am
Schreibtisch**: Steigleitung über dem freien Rasen rechts neben seinem Schrank,
dann waagrecht hinein. Die beiden Kabel kommen jetzt spiegelbildlich von aussen
auf ihr Schrankpaar zu und kreuzen sich nirgends.

### Netz beginnt sichtbar rechts

Der Abstieg lag bei 1400 — mitten unter dem farbigen Strich, und er klebte auf
halber Höhe am Mast. Jetzt liegt er bei **1470**, praktisch am rechten Ende des
Strichs: Die Verbindung beginnt sichtbar rechts, fällt frei neben dem Mast
herab und kommt mit einem ordentlichen waagrechten Stück von 190 Einheiten
herein — dieselbe Ruhe wie beim grossen Speicher, nur in die andere Richtung.

### Mond wie am Schreibtisch

Am Schreibtisch steht er frei in der leeren oberen rechten Ecke, deutlich
abgesetzt von allem. Am Telefon sass er zuletzt **tief in der Himmelslücke
zwischen Dachfirst und Mast** — mitten im Bild, halb hinter Dach und Mast, und
das wirkte zufällig. Er steht jetzt wieder **frei über dem Dach** (860 / −140,
Scheibe 8,1 %), in dem leeren Streifen zwischen der PV-Angabe links und der
Netz-Angabe rechts: dieselbe Wirkung wie am Schreibtisch — ein Himmelskörper
über der Szene, nicht darin. Abstand zur nächsten Zuleitung: 108 Einheiten.

## Bei künftigen Änderungen beachten

* `leadPoints()` darf **nie** nur zwei Punkte zurückgeben, wenn Anfang und Ende
  weder dieselbe x- noch dieselbe y-Lage haben — genau daraus entstanden die
  Schrägen.
* Eine neue Zuleitung braucht eine **festgelegte Andockseite**, und zwar nicht
  die, auf der ihr Energieweg das Gerät verlässt.
* `riser` ist eine feste Lage, `channel` eine Lage in der gemessenen Gasse.
  Nur Angaben aus einem zweiten Band brauchen `channel`; alles andere kommt
  ohne Umweg aus.
* Die Gasse wird ausschliesslich am **ersten** Band gemessen (`fitRows`).
* Nach jeder Änderung an `LAYOUTS` gegen die längstmöglichen Texte prüfen, in
  allen drei Schriftgrössen — nicht gegen die gerade anliegenden Werte.
