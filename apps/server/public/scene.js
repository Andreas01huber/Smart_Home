/**
 * Hausansicht des Live-Energieflusses.
 *
 * Grundlage ist das vom Benutzer gelieferte 3D-Rendering der eigenen Anlage —
 * freigestellt, mit echtem Alphakanal. Es gibt bewusst KEINE Bildfläche, keine
 * Card und keinen Container hinter dem Haus: Das Gebäude steht frei auf dem
 * App-Hintergrund, darüber liegen nur Energiewege und Messwerte.
 *
 * Wichtig: Hier wird NICHTS gerechnet. Alle Werte kommen fertig aus dem
 * Backend und werden nur platziert — exakt dieselben Zahlen wie im Diagramm.
 *
 * Alle Koordinaten liegen im Bildraum (1485 × 988, den Pixeln des
 * freigestellten Bildes). Haus, Energiewege und Ankerpunkte sind damit auf
 * jeder Displaygrösse identisch — die viewBox skaliert alles gemeinsam.
 *
 * Beweglich sind nur die Beschriftungen: Sie stehen in zwei Anordnungen
 * bereit (siehe LAYOUTS). Der Grund ist Lesbarkeit. Die Schrift skaliert mit
 * der viewBox, und auf einem Telefon sind 1615 Bildeinheiten rund 350 Pixel —
 * Faktor 0,22. Sechs Angaben rund um das Haus wären dort 6 Pixel hoch. Am
 * Telefon stehen sie deshalb zu zweit in Bändern und dürfen doppelt so gross
 * sein.
 */

export const IMG_W = 1485;
export const IMG_H = 988;
export const IMG_WEBP = '/assets/energy/haus.webp';
export const IMG_PNG = '/assets/energy/haus.png';

/** Ab dieser Breite (CSS-Pixel des SVG) gilt die breite Anordnung. */
export const WIDE_MIN_PX = 800;

/**
 * Wählt die Anordnung anhand der tatsächlichen Darstellungsbreite.
 * Bewusst an der Breite des SVG selbst, nicht am Fenster: In der zweispaltigen
 * Desktop-Anordnung ist die Szene schmaler als der Bildschirm.
 */
export function pickSceneLayout(widthPx) {
  return widthPx >= WIDE_MIN_PX ? 'wide' : 'narrow';
}

/**
 * viewBox der gewählten Anordnung.
 *
 * `zoom` ist die eingestellte Schriftvergrösserung (1 … ~1,2). Die Bänder über
 * und unter dem Haus wachsen mit der Schrift, deshalb wächst auch der Rand —
 * sonst würde bei „Sehr groß" die oberste Zeile oben abgeschnitten. Bei
 * normaler Schrift bleibt der Rand knapp, damit das Haus so gross wie möglich
 * erscheint.
 */
export function sceneViewBox(name, zoom = 1) {
  const narrow = name === 'narrow';
  const p = LAYOUTS[narrow ? 'narrow' : 'wide'].pad;
  const grow = Math.max(0, zoom - 1);
  if (narrow) {
    // Schmal: Die Bänder liegen über und unter dem Haus, sie wachsen nach oben
    // und unten.
    const extra = Math.round(grow * 320);
    return [-p.left, -(p.top + extra), IMG_W + p.left + p.right, IMG_H + p.top + p.bottom + 2 * extra].join(' ');
  }
  // Breit: Die Spalten stehen links und rechts, also wächst der SEITLICHE Rand.
  // Beide Seiten immer gleich — sonst verschiebt sich das Haus aus der Mitte.
  // Bei normaler Schrift bleibt er knapp; gemessen brauchen die längsten Texte
  // („GROSSER SPEICHER", „keine Daten") dort 300 Einheiten, bei „Sehr groß" 462.
  // Der Faktor 310 deckt das mit etwas Reserve ab — mit 250 ragte „keine Daten"
  // in den beiden vergrösserten Stufen 9 bzw. 18 Einheiten über den Rand.
  const side = p.left + Math.round(grow * 310);
  return [-side, -p.top, IMG_W + 2 * side, IMG_H + p.top + p.bottom].join(' ');
}

/**
 * Ankerpunkte — am jeweiligen Gerät im Rendering ausgemessen.
 *
 * `hub` ist der Fronius-Wechselrichter an der Garagenwand. Dort laufen real
 * PV, Speicher, Netz, Haus und Wallbox zusammen, deshalb ist er auch in der
 * Grafik der Verteilpunkt.
 */
export const ANCHORS = {
  hub: { x: 999, y: 509 },
  roof: { x: 722, y: 159 },
  house: { x: 422, y: 589 },
  car: { x: 765, y: 581 },
  bat1: { x: 1015, y: 654 },
  bat2: { x: 1207, y: 684 },
  grid: { x: 1265, y: 249 },
};

/**
 * Wege der Energieflüsse als Stützpunkte, in Flussrichtung der Erzeugung
 * notiert (Quelle → Verteilpunkt → Verbraucher).
 *
 * Die Wege folgen bewusst dem Bauwerk, wie es eine Leitung tun würde: über die
 * Dachfläche zur Traufe, an der Garagenwand hinunter, im Boden über die
 * Einfahrt, am Sockel entlang zu den Speichern. So schneidet keine Linie quer
 * durch das Gebäude — und trotzdem bleibt es eine abstrahierte Visualisierung,
 * kein Installationsplan.
 */
export const ROUTES = {
  pv: [[722, 159], [812, 246], [889, 330], [949, 421], [999, 509]],
  grid: [[1265, 249], [1268, 356], [1258, 432], [1170, 476], [1074, 500], [999, 509]],
  bat1: [[1015, 654], [1011, 606], [1004, 556], [999, 509]],
  bat2: [[1207, 684], [1196, 620], [1150, 560], [1074, 522], [999, 509]],
  house: [[999, 509], [982, 566], [962, 640], [916, 726], [826, 790], [700, 806], [566, 771], [472, 690], [422, 589]],
  ev: [[999, 509], [977, 566], [949, 620], [889, 646], [822, 622], [765, 581]],
};

/**
 * Beschriftungen.
 *
 * Bewusst KEINE Kästchen: Eine feine farbige Linie trägt die Angabe, der Wert
 * steht gross darüber, der Name klein in Versalien darüber.
 *
 * Felder:
 *   `at`        innerer Anfang der farbigen Linie
 *   `dir`       Richtung, in die die Linie ausläuft (+1 rechts, −1 links)
 *   `anchor`    Gerät im Bild, auf das sich die Angabe bezieht
 *   `band`      nur schmal: 0 = erstes Band, 1 = zweites darunter
 *   `below`     Schrift steht UNTER dem Strich statt darüber
 *   `riser`     x der Steigleitung, fest gesetzt (Standard: x des Geräts)
 *   `channel`   wie `riser`, aber in der gemessenen freien Gasse (wird geprüft
 *               und notfalls verschoben, damit zwei Kabel nicht aufeinander
 *               liegen)
 *   `turn`      y, auf der die Zuleitung zum Gerät abbiegt (Standard: Anker-y)
 *   `bar`       aus der Linie wird der Ladebalken des Speichers
 *   `barLen`    feste Länge dieses Ladebalkens in Bildeinheiten (statt
 *               Textbreite). Er hört damit an einer bestimmten Stelle auf —
 *               und genau dort setzt die Zuleitung an.
 *
 * ── Das Führungssystem der Zuleitungen ───────────────────────────────
 * Jede Zuleitung besteht aus höchstens drei Stücken und kennt nur zwei
 * Richtungen — waagrecht und senkrecht, mit abgerundeten Ecken:
 *
 *   1. AUSTRITT   Sie läuft auf der Höhe ihres Strichs weiter, als wäre der
 *                 Strich selbst das erste Stück Kabel.
 *   2. STEIGLEITUNG  Ein senkrechtes Stück auf einer bewusst gewählten x-Lage
 *                 (`riser` / `channel`) — nie durch Schrift, nie durch ein
 *                 Gerät hindurch.
 *   3. ANSCHLUSS  Ein kurzes Stück quer in das Gerät hinein, immer von einer
 *                 festgelegten Seite.
 *
 * Zwei Regeln stehen dahinter, beide aus Fehlern gelernt:
 *
 * KEINE SCHRÄGEN. Früher entstand eine Gerade, sobald das Gerät weder über
 * noch unter dem Strich lag — und die lief dann quer durch die Szene und
 * durch die eigene Zahl. Jetzt wird der Knick immer gesetzt.
 *
 * NIE IN RICHTUNG DES ENERGIEWEGS ANDOCKEN. Wo der farbige Energieweg das
 * Gerät verlässt, darf die Zuleitung nicht ankommen: Beide lägen sonst auf
 * einer Linie und sähen aus wie ein einziger Strich, der durch das Gerät
 * hindurchgeht. Netz und kleiner Speicher werden deshalb seitlich
 * angeschlossen, Haus und Auto von unten, PV von oben.
 */

/**
 * Zwei Anordnungen derselben Szene. Haus, Energiewege und Ankerpunkte sind in
 * beiden identisch — es wandern nur die Beschriftungen.
 *
 * BREIT (ab 800 px SVG-Breite): Die Angaben stehen als zwei ruhige Spalten
 * links und rechts neben dem Haus, zwei weitere über dem Dach. Der Rand ist
 * links und rechts exakt gleich gross, dadurch sitzt das Haus genau in der
 * Mitte. Die Zuleitungen verlaufen waagrecht in die Szene hinein.
 *
 * SCHMAL (Telefon): Seitliche Spalten würden das Haus auf ein Drittel der
 * Breite drücken. Dort stehen die Angaben deshalb in Bändern über und unter
 * dem Haus, zu zweit nebeneinander. Die Zuleitungen folgen demselben System
 * wie am Schreibtisch, nur mit kürzeren Wegen. Auch hier ist der Rand links
 * und rechts gleich, das Haus bleibt mittig.
 */
export const LAYOUTS = {
  wide: {
    // Links = rechts ⇒ die Bildmitte (x 742,5) liegt exakt auf der Mitte der
    // viewBox. Das Haus kann nicht mehr nach links oder rechts wegdriften.
    // Oben trägt der Rand die zwei Angaben über dem Dach und die Sonne; unten
    // steht nichts mehr, deshalb ist er dort knapp — leerer Raum würde die
    // Szene nur kleiner machen.
    pad: { top: 320, right: 330, bottom: 150, left: 330 },
    // Die vier seitlichen Angaben stehen auf ZWEI Höhen — 760 und 1060. Diese
    // beiden Höhen sind zugleich die waagrechten Kabelebenen: Jede Zuleitung
    // läuft auf der Höhe ihres eigenen Strichs in die Szene hinein und biegt
    // erst dort senkrecht ab. Dadurch gibt es im ganzen Bild nur zwei
    // waagrechte und vier senkrechte Kabelspuren statt sechs freier Wege.
    callouts: [
      // Oben: kurzes Stück waagrecht aus dem Strich, dann senkrecht herab.
      // Die Höhe −50 statt −80 hält Abstand zur Sonnenscheibe (sie reicht bis
      // −87): Das Netzkabel läuft rechts an ihr vorbei und soll sie nicht
      // streifen.
      { id: 'pv', at: [640, -50], dir: -1, anchor: 'roof', label: 'PV', color: 'flow-pv-color' },
      // Netz: Der lila Energieweg verlässt den Mast nach UNTEN. Die Zuleitung
      // kommt deshalb nicht ebenfalls von oben (das ergab einen einzigen
      // langen Strich durch den Mast), sondern steigt RECHTS am Mast vorbei
      // herab und dockt waagrecht an — quer zum Energieweg und auf derselben
      // Seite wie am Telefon.
      { id: 'grid', at: [1120, -50], dir: -1, riser: 1400, anchor: 'grid', label: 'Netz', color: 'flow-grid-color' },
      // Linke Spalte: rechtsbündig an der Bildkante, Linie läuft nach links weg.
      { id: 'house', at: [-40, 684], dir: -1, anchor: 'house', label: 'Haus', color: 'flow-house-color', note: true },
      { id: 'ev', at: [-40, 1060], dir: -1, anchor: 'car', label: 'Auto', color: 'flow-ev-color', note: true },
      // Rechte Spalte: linksbündig, Linie läuft nach rechts weg.
      // Reihenfolge wie gewünscht: Großer Speicher oben, Kleiner darunter.
      //
      // `level` legt die Mitte des Ladebalkens genau auf die Höhe des Geräts.
      // Dadurch braucht die Zuleitung KEINEN Knick: Balken und Kabel sind ein
      // einziger gerader Strich, der von rechts in den Schrank läuft — in
      // jeder Schriftgrösse, denn der Balken wird mit der Schrift dicker.
      { id: 'bat2', at: [1525, 684], dir: 1, level: true, anchor: 'bat2', label: 'Großer Speicher', color: 'flow-battery-color', bar: true, note: true },
      // Beim kleinen Speicher geht das nicht gerade: Auf seiner Höhe steht der
      // grosse Schrank im Weg. Sein Kabel steigt deshalb in der Lücke zwischen
      // den beiden Schränken auf und kommt von rechts — zwei Knicke, weniger
      // sind hier geometrisch nicht möglich. Von unten ginge es nicht: Dort
      // steigt sein eigener Energieweg zum Wechselrichter auf.
      { id: 'bat1', at: [1525, 1060], dir: 1, riser: 1096, anchor: 'bat1', label: 'Kleiner Speicher', color: 'flow-battery-color', bar: true, note: true },
    ],
  },
  narrow: {
    // Oben knapper als früher (380 → 280): Die beiden Angaben über dem Dach
    // standen weit vom Bild entfernt, dazwischen lag leerer Himmel und ihre
    // Kabel mussten die ganze Strecke überbrücken. Näher am Haus wird der
    // Weg zum Netzmast um ein Viertel kürzer und der Block insgesamt ruhiger.
    pad: { top: 280, right: 60, bottom: 620, left: 60 },
    // ── Bänder mit Kabelaufstieg ─────────────────────────────────────
    // In den unteren Bändern steht die Schrift UNTER ihrem Strich (`below`).
    // Das ist der Schlüssel: Die Zuleitung verlässt den Strich nach oben und
    // kann ihren eigenen Wert damit gar nicht treffen. Sie steigt senkrecht
    // in ihr Gerät auf — dasselbe Kabelbild wie am Schreibtisch, nur ohne
    // seitliche Spalten, für die am Telefon kein Platz ist.
    //
    // Der Aufstieg des zweiten Bandes läuft durch die freie Gasse zwischen der
    // linken und der rechten Angabe des ersten Bandes. Wo die liegt, hängt von
    // der Textlänge ab — sie wird deshalb zur Laufzeit gemessen (`channel`).
    callouts: [
      // Oben: Schrift über dem Strich, die Zuleitung geht nach unten weg.
      // Beide laufen erst auf Strichhöhe weiter und fallen dann senkrecht auf
      // ihr Gerät — zwei gleich gebaute Kabel, die von oben ankommen.
      { id: 'pv', at: [0, -60], dir: 1, anchor: 'roof', label: 'PV', color: 'flow-pv-color' },
      // Netz seitlich statt von oben: Der lila Energieweg verlässt den Mast
      // senkrecht nach unten; käme die Zuleitung ebenfalls senkrecht von oben,
      // ergäbe beides einen einzigen Strich mitten durch den Mast.
      //
      // Das Schild endet bei 1200 statt an der Bildkante. Zwei Gründe, beide
      // aus der breiten Anordnung übernommen, wo dieselbe Aufteilung gilt:
      //
      //  1. Die rechte obere Ecke wird frei — dort steht am Schreibtisch der
      //     Himmelskörper, und dorthin gehört er auch am Telefon. Klebte das
      //     Schild an der Kante, bliebe für ihn nur die Bildmitte, und dort
      //     schwebte er unbeschriftet zwischen den beiden Angaben.
      //  2. Das Kabel bekommt einen echten Austritt. Vorher stieg es 7,5
      //     Einheiten nach dem Strich ab — es fiel praktisch aus dem Schild
      //     heraus. Jetzt läuft es erst 200 Einheiten waagrecht weiter, fällt
      //     dann bei 1400 rechts am Mast vorbei und kommt waagrecht herein:
      //     dieselbe Figur wie beim Großen Speicher, nur nach unten gespiegelt.
      { id: 'grid', at: [1200, -60], dir: -1, riser: 1400, anchor: 'grid', label: 'Netz', color: 'flow-grid-color' },
      // ── Erstes Band, direkt unter dem Bild ────────────────────────
      { id: 'house', at: [0, 1060], dir: 1, below: true, anchor: 'house', label: 'Haus', color: 'flow-house-color', note: true },
      // GROSSER Speicher zuerst — er steht im Bild weiter rechts und weiter
      // hinten, und nur er lässt sich aus dem ERSTEN Band heraus ohne Umweg
      // erreichen: Rechts neben seinem Schrank liegt freier Rasen, dort steigt
      // sein Kabel auf und dockt waagrecht an. Das ist genau die Führung, die
      // er auch am Schreibtisch hat.
      // barLen 155 = 1485 − 1330: Die Anzeige endet exakt auf der Steigleitung,
      // die Zuleitung setzt an ihrem Ende an und läuft von dort weiter.
      { id: 'bat2', at: [1485, 1060], dir: -1, riser: 1330, below: true, anchor: 'bat2', label: 'Großer Speicher', color: 'flow-battery-color', bar: true, barLen: 155, note: true, icon: true },
      // ── Zweites Band ─────────────────────────────────────────────
      // `band: 1` — sein Abstand steht nicht fest, sondern folgt der
      // Schriftgrösse (siehe fitScene); bei „Sehr groß" stiessen die Bänder
      // sonst aneinander. Beide Kabel dieses Bandes müssen an der Schrift des
      // ersten Bandes vorbei und steigen deshalb in der gemessenen Gasse auf.
      { id: 'ev', at: [0, 1060], band: 1, dir: 1, below: true, anchor: 'car', label: 'Auto', color: 'flow-ev-color', note: true, channel: 765 },
      // Der KLEINE Speicher steht näher am Haus, sein Schrank links vom
      // grossen. Sein Kabel steigt in der LÜCKE ZWISCHEN den beiden Schränken
      // auf (1105) und geht auf Gerätehöhe von rechts hinein — exakt die
      // Führung, die er auch am Schreibtisch hat (dort 1096).
      //
      // Vorher stieg es in der gemessenen Gasse bei 920 auf, also LINKS an
      // beiden Schränken vorbei. Das hatte zwei Folgen, die man der Szene
      // ansah: Der Aufstieg schnitt bei (916|726) den Energieweg des Hauses,
      // und die beiden Speicherkabel liefen gegenläufig — das obere Schild
      // dockte rechts an, das untere kam von links quer durch den Vorplatz.
      // Genau dieses Über-Kreuz machte die rechte Seite unruhig.
      //
      // Jetzt kommen beide Kabel von rechts und liegen ineinander verschachtelt:
      // aussen (1330) der grosse Speicher, innen (1105) der kleine. Kein
      // Energieweg wird mehr gekreuzt, keine Leitung läuft mehr über den
      // Vorplatz.
      // Dieselbe Anzeigenlänge wie oben — beide Speicher lesen sich gleich. Ihr
      // Ende liegt hier nicht auf der eigenen Steigleitung (die sitzt weiter
      // innen bei 1105); die Leitung tritt am Ende der Anzeige aus und läuft von
      // dort waagrecht weiter. Für das Auge derselbe Vorgang.
      { id: 'bat1', at: [1485, 1060], band: 1, dir: -1, riser: 1105, below: true, anchor: 'bat1', label: 'Kleiner Speicher', color: 'flow-battery-color', bar: true, barLen: 155, note: true, icon: true },
    ],
  },
};

/** Beschriftungen der breiten Anordnung (Rückwärtskompatibilität). */
export const CALLOUTS = LAYOUTS.wide.callouts;

function layoutOf(name) {
  return LAYOUTS[name === 'narrow' ? 'narrow' : 'wide'];
}

/**
 * Himmelskörper.
 *
 * Sonne und Mond werden im Ursprung (0,0) gezeichnet; Position und Grösse
 * kommen aus CSS (`--sky-x`, `--sky-y`, `--sky-scale`). Dadurch lassen sich
 * beide je Bildschirmklasse eigenständig setzen, ohne die Geometrie der
 * Szene anzufassen — Telefon, Tablet und Desktop bekommen jeweils eine
 * eigens abgestimmte Lage, Grösse und Leuchtstärke.
 *
 * `SKY_ASSET` ist die Kantenlänge der Sonnengrafik in Bildeinheiten,
 * `SKY_DISC_RATIO` der Anteil, den die Sonnenscheibe darin einnimmt (gemessen:
 * 61,7 %). Über beides lässt sich die Scheibe exakt auf den gewünschten Anteil
 * der Szenenbreite bringen.
 */
/**
 * Speichersymbole für die schmale Anordnung.
 *
 * Die beiden Zeichnungen tragen die Größenaussage bereits in sich: Der große
 * Speicher ist ein dreistöckiger Schrank, der kleine ein einzelner Würfel. Sie
 * werden deshalb mit DEMSELBEN Maßstab gezeichnet und nicht auf gleiche Höhe
 * gebracht — nur so bleibt der Unterschied sichtbar.
 *
 * `right` und `mid` sagen, wo die Zeichnung in ihrer quadratischen Datei liegt:
 * rechte Kante und senkrechte Mitte des sichtbaren Inhalts, als Anteil der
 * Kantenlänge. Gemessen am Alphakanal der Originale (1254 × 1254) — der große
 * Schrank füllt 59 % der Breite, der kleine Würfel nur 39 %. Ohne diesen
 * Ausgleich stünde das kleine Symbol mit seinem breiten leeren Rand sichtbar
 * weiter vom Wort entfernt als das große.
 */
export const STORAGE_ICONS = {
  large: { href: '/assets/energy/storage-large.png', right: 0.796, mid: 0.5, scale: 1 },
  small: { href: '/assets/energy/storage-small.png', right: 0.695, mid: 0.489, scale: 1.35 },
};

export const SKY_ASSET = 512;
export const SKY_DISC_RATIO = 0.617;
export const SUN_WEBP = '/assets/energy/sonne.webp';
export const SUN_PNG = '/assets/energy/sonne.png';
export const MOON_WEBP = '/assets/energy/mond.webp';
export const MOON_PNG = '/assets/energy/mond.png';

/**
 * Entscheidet, ob Sonne oder Mond zu sehen ist.
 *
 * Zwei Sicherungen gegen Flackern bei schwankender PV-Leistung:
 *  1. Hysterese — Sonne erst über `sunW`, Mond erst unter `moonW`. Dazwischen
 *     liegt ein breites Totband, in dem sich gar nichts ändert.
 *  2. Bestätigung — ein Wechselwunsch muss `confirmMs` lang ununterbrochen
 *     anliegen. Eine durchziehende Wolke schaltet damit nichts um.
 *
 * Bewusst als eigenständige Einheit mit übergebener Zeit: So lässt sich das
 * Verhalten prüfen, ohne 25 Sekunden warten zu müssen.
 */
export function createSkyGate({ sunW = 1000, moonW = 500, confirmMs = 25000 } = {}) {
  let state = null;
  let wanted = null;
  let since = 0;
  return {
    get state() { return state; },
    /** Zurücksetzen — nötig, wenn die Szene neu aufgebaut wurde. */
    reset() { state = null; wanted = null; since = 0; },
    update(pvW, now = Date.now()) {
      // Erster Messwert: sofort setzen, sonst stünde der Himmel eine Weile falsch.
      if (state === null) {
        state = pvW >= (sunW + moonW) / 2 ? 'sun' : 'moon';
        return state;
      }
      const want = pvW > sunW ? 'sun' : pvW < moonW ? 'moon' : null;
      if (want === null || want === state) { wanted = null; return state; }
      if (wanted !== want) { wanted = want; since = now; return state; }
      if (now - since >= confirmMs) { state = want; wanted = null; }
      return state;
    },
  };
}

/**
 * Stützpunkte zu einer weichen Kurve verbinden (Catmull-Rom → kubische Bézier).
 * Ergibt runde, gleichmässige Übergänge ohne Knicke an den Stützpunkten.
 */
function smoothPath(points) {
  if (points.length < 2) return '';
  const p = points.map(([x, y]) => ({ x, y }));
  let d = 'M' + p[0].x + ',' + p[0].y;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] || p2;
    d += ' C' + (p1.x + (p2.x - p0.x) / 6).toFixed(1) + ',' + (p1.y + (p2.y - p0.y) / 6).toFixed(1) +
      ' ' + (p2.x - (p3.x - p1.x) / 6).toFixed(1) + ',' + (p2.y - (p3.y - p1.y) / 6).toFixed(1) +
      ' ' + p2.x.toFixed(1) + ',' + p2.y.toFixed(1);
  }
  return d;
}

/** WebP mit Alpha unterstützen alle Zielbrowser; PNG bleibt der Rückfall. */
let _webp = null;
function supportsWebp() {
  if (_webp !== null) return _webp;
  try {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    _webp = c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  } catch { _webp = false; }                 // kein Canvas → Rückfall
  return _webp;
}
function pickImage() {
  return supportsWebp() ? IMG_WEBP : IMG_PNG;
}

/**
 * Sonne und Mond.
 *
 * Beide sitzen an derselben Stelle und werden per Deckkraft überblendet — nie
 * hart geschaltet. Kein Cartoon: weiche Verläufe, ein zurückgenommener Hof,
 * beim Mond eine leichte Kugelschattierung. Sie liegen hinter dem Bild, der
 * Strommast schneidet sie an; das erzeugt Tiefe.
 */
function skyMarkup() {
  const h = SKY_ASSET / 2;
  const webp = supportsWebp();
  // Beide Assets sind so zugeschnitten, dass die Scheibe denselben Anteil
  // einnimmt (61,7 %). Dadurch wirken Sonne und Mond exakt gleich gross und
  // teilen sich einen einzigen Massstab.
  const body = (cls, href) => '<image class="' + cls + '" href="' + href +
    '" x="' + -h + '" y="' + -h + '" width="' + SKY_ASSET + '" height="' + SKY_ASSET + '" />';
  return '<g class="sc-sky" aria-hidden="true">' +
    // Der Schein kommt bewusst NICHT aus den Grafiken, sondern per CSS — nur so
    // lässt er sich am Telefon zurücknehmen, ohne ein zweites Bild zu brauchen.
    body('sc-sun', webp ? SUN_WEBP : SUN_PNG) +
    body('sc-moon', webp ? MOON_WEBP : MOON_PNG) +
    '</g>';
}

function defsMarkup() {
  return '<defs>' +
    // Warmes Streiflicht, das bei Sonne über der Anlage liegt — die Sonne
    // steht dann nicht nur da, sie wirkt auch auf Dach und Haus.
    '<radialGradient id="sc-sunwash" cx="50%" cy="50%" r="50%">' +
    '<stop offset="0%" stop-color="var(--sc-sun-glow)" stop-opacity="0.26" />' +
    '<stop offset="45%" stop-color="var(--sc-sun-glow)" stop-opacity="0.1" />' +
    '<stop offset="100%" stop-color="var(--sc-sun-glow)" stop-opacity="0" />' +
    '</radialGradient>' +
    '</defs>';
}

/**
 * Baut die Szene einmalig auf. Danach werden nur noch Texte und Zustände
 * aktualisiert — das Bild bleibt stehen und wird nie neu geladen.
 *
 * Reihenfolge = Ebenen: Himmel ganz hinten (der Mast verdeckt ihn), dann das
 * freigestellte Haus, darüber die Energiewege, ganz oben die Beschriftungen.
 */
export function buildScene(layoutName = 'wide') {
  const layout = layoutOf(layoutName);
  const routes = Object.keys(ROUTES);
  const d = (id) => smoothPath(ROUTES[id]);
  const path = (prefix, id) => '<path id="' + prefix + id + '" d="' + d(id) + '" />';
  // Der Punkt am Gerät trägt die Farbe seiner Angabe. Das ist die Verbindung
  // zwischen Bild und Wert — am Telefon, wo es keine Zeigelinien gibt, sogar
  // die einzige neben dem Namen.
  const dotColor = {};
  for (const c of layout.callouts) dotColor[c.anchor] = c.color;
  const dot = (name) => '<circle class="sc-dot ' + (dotColor[name] ?? '') + '" data-dot="' + name + '" cx="' + ANCHORS[name].x +
    '" cy="' + ANCHORS[name].y + '" r="8.5" />';

  // Die Zuleitungen liegen in einer eigenen, tieferen Ebene. Lägen sie in der
  // jeweiligen Beschriftungsgruppe, würde eine später gezeichnete Zuleitung
  // quer über die Schrift einer früheren laufen — die Zuleitung des Autos etwa
  // über „Kleiner Speicher". So verdeckt jede Beschriftung mit ihrem Halo jede
  // Zuleitung, auch die fremder Angaben.
  const lead = (c) => '<path class="sc-cal-lead ' + c.color + '" id="slead-' + c.id + '" fill="none" />';

  // Dritte Zeile: sagt, was das Gerät gerade TUT. Bei den Speichern „lädt
  // 1,2 kW" / „entlädt 450 W" / „bereit", beim Fahrzeug der Anschlusszustand.
  // Der Prozentwert allein beantwortet nur die halbe Frage.
  const callout = (c) => '<g class="sc-cal ' + c.color + '" data-cal="' + c.id + '">' +
    // Symbol vor dem Namen. Leer angelegt — Bild, Größe und Lage setzt fitScene,
    // weil sie von der gemessenen Textbreite abhängen.
    (c.icon ? '<image class="sc-cal-icon" preserveAspectRatio="xMidYMid meet" />' : '') +
    '<rect class="sc-cal-rule" x="' + c.at[0] + '" y="' + c.at[1] + '" width="10" height="5" rx="2.5" />' +
    (c.bar ? '<rect class="sc-cal-fill" x="' + c.at[0] + '" y="' + c.at[1] + '" width="0" height="5" rx="2.5" />' : '') +
    '<text class="sc-cal-label" data-l="sc-' + c.id + '" x="' + c.at[0] + '" y="' + (c.at[1] - 60) + '">' + c.label + '</text>' +
    '<text class="sc-cal-value" data-f="sc-' + c.id + '" x="' + c.at[0] + '" y="' + (c.at[1] - 16) + '">—</text>' +
    (c.note ? '<text class="sc-cal-note" data-n="sc-' + c.id + '" x="' + c.at[0] + '" y="' + c.at[1] + '"></text>' : '') +
    '</g>';

  return defsMarkup() +
    skyMarkup() +

    '<image href="' + pickImage() + '" x="0" y="0" width="' + IMG_W + '" height="' + IMG_H +
    '" class="sc-photo" />' +

    // Liegt über dem Bild, damit das Sonnenlicht Dach und Fassade erreicht.
    // Ausdehnung bewusst so gewaehlt, dass der Verlauf INNERHALB der viewBox
    // auf null laeuft — sonst schneidet der SVG-Rand eine sichtbare Kante hinein.
    // rx bewusst 390: Damit endet der Verlauf auch in der schmalen Anordnung
    // (rechter Rand 1545) INNERHALB der Zeichenfläche. Ragte er darüber hinaus,
    // schnitte der SVG-Rand eine sichtbare Kante hinein.
    '<ellipse class="sc-sunwash" cx="1150" cy="140" rx="390" ry="400" fill="url(#sc-sunwash)" />' +

    // Zuleitungen ganz unten: Sie sind Hilfslinien, kein Inhalt. Kreuzt eine
    // von ihnen einen Energieweg, deckt der farbige Weg sie zu — statt dass
    // ein dünner grauer Strich über die Hauptsache läuft. Und weil sie in
    // einer eigenen Ebene liegen, kann keine Zuleitung über die Schrift einer
    // anderen Angabe geraten.
    (layout.leads === false ? '' :
      '<g class="sc-leads" fill="none">' + layout.callouts.map(lead).join('') + '</g>') +

    // Dunkle Fassung unter der Farbe: gibt den Leitungen auf hellem Beton wie
    // auf dunklem Dach gleichermassen Halt.
    '<g class="sc-casing" fill="none" stroke-linecap="round">' +
    routes.map((id) => path('scase-', id)).join('') +
    '</g>' +
    '<g class="edges sc-edges" fill="none" stroke-linecap="round">' +
    routes.map((id) => path('sedge-', id)).join('') +
    '</g>' +
    '<g class="edges flow-overlay sc-flows" fill="none" stroke-linecap="round">' +
    routes.map((id) => path('sflow-', id)).join('') +
    '</g>' +

    '<g class="sc-dots">' +
    Object.keys(ANCHORS).filter((k) => k !== 'hub').map(dot).join('') +
    '</g>' +

    '<g class="sc-hub" transform="translate(' + ANCHORS.hub.x + ',' + ANCHORS.hub.y + ')">' +
    '<circle class="sc-hub-ring" r="18" />' +
    '<circle class="sc-hub-core" r="7" />' +
    '</g>' +

    '<g class="sc-cals">' + layout.callouts.map(callout).join('') + '</g>';
}

/**
 * Sicherung gegen zusammenstossende Angaben in einer Zeile.
 *
 * In den Bändern am Telefon stehen zwei Angaben nebeneinander. Deren Breite
 * hängt vom Text ab, und der ist nicht in unserer Hand: Ein Speicher kann in
 * der Konfiguration umbenannt werden, ein Wert vierstellig werden, die Schrift
 * ist einstellbar. Reicht der Platz nicht, werden BEIDE Angaben der Zeile im
 * selben Verhältnis kleiner gesetzt — dann rückt nichts ineinander, und die
 * Zeile bleibt in sich einheitlich.
 *
 * Im Normalfall passiert hier nichts (der Faktor ist 1); die Prüfung kostet
 * nur die Messung, die ohnehin gebraucht wird.
 */
function fitRows(svg, specs) {
  const rows = new Map();
  const all = [];
  for (const g of svg.querySelectorAll('.sc-cal')) {
    const spec = specs.find((c) => c.id === g.dataset.cal);
    if (!spec) continue;
    const label = g.querySelector('.sc-cal-label');
    const value = g.querySelector('.sc-cal-value');
    const note = g.querySelector('.sc-cal-note');
    if (!label || !value) continue;
    // Zuerst eine mögliche frühere Verkleinerung lösen, sonst würde sie sich
    // bei jedem Durchlauf aufaddieren.
    if (label.style.fontSize) {
      label.style.fontSize = ''; value.style.fontSize = '';
      if (note) note.style.fontSize = '';
    }
    let w;
    let stack;
    try {
      const fv = parseFloat(getComputedStyle(value).fontSize) || 60;
      const fl = parseFloat(getComputedStyle(label).fontSize) || 28;
      const fn = note ? parseFloat(getComputedStyle(note).fontSize) || 26 : 0;
      w = Math.max(label.getBBox().width, value.getBBox().width,
        note ? note.getBBox().width : 0, fv * 1.6);
      // Höhe des Textblocks neben/unter dem Strich — sie bestimmt, wie weit
      // das zweite Band tiefer liegen muss.
      stack = spec.below
        ? fv * 0.2 + fl * 1.05 + fv * 0.92 + (note ? fn * 1.55 : fl * 0.3)
        : fv * 1.22 + fl * 0.75 + (note ? fn * 0.9 : 0);
    } catch { return null; }
    if (!(w > 0)) return null;
    const item = { spec, label, value, note, w, stack };
    all.push(item);
    const key = spec.at[1] + ':' + (spec.band ?? 0);
    const row = rows.get(key) ?? [];
    row.push(item);
    rows.set(key, row);
  }

  // Der Abstand zwischen den beiden Angaben einer Zeile ist nicht nur Optik:
  // Durch das ERSTE Band steigen die Kabel des zweiten auf. Diese eine Zeile
  // muss deshalb eine Gasse frei lassen, in der zwei Spuren nebeneinander und
  // jede auf ihrer vorgesehenen Lage Platz haben — notfalls wird die Zeile
  // dafür etwas kleiner gesetzt. Alle übrigen Zeilen brauchen nur so viel
  // Luft, dass die Angaben nicht zusammenstossen.
  const passed = specs.some((s) => s.channel != null);
  for (const row of rows.values()) {
    if (row.length !== 2) continue;
    const [a, b] = row.sort((p, q) => p.spec.at[0] - q.spec.at[0]);
    // Nur wenn die beiden AUFEINANDER ZU wachsen. In der breiten Anordnung
    // stehen sie aussen und wachsen voneinander weg — dort kann nichts
    // zusammenstossen, egal wie lang der Text wird.
    if (!(a.spec.dir > 0 && b.spec.dir < 0)) continue;
    const GAP = passed && a.spec.below && (a.spec.band ?? 0) === 0 ? 380 : 70;
    const room = b.spec.at[0] - a.spec.at[0] - GAP;
    const total = a.w + b.w;
    if (total <= room || room <= 0) continue;
    const factor = room / total;
    for (const it of row) {
      it.w *= factor;
      for (const el of [it.label, it.value, it.note]) {
        if (el) el.style.fontSize = (parseFloat(getComputedStyle(el).fontSize) * factor).toFixed(1) + 'px';
      }
    }
  }

  // Freie Gasse: der senkrechte Streifen, in dem KEINE Beschriftung steht.
  // Durch ihn steigt das Kabel des zweiten Bandes auf. Weil die Breite der
  // Texte schwankt (Werte, Namen, Schriftgrösse), wird sie gemessen statt
  // angenommen.
  //
  // Gemessen wird NUR am ersten Band. Es ist das einzige, an dem ein Kabel
  // des zweiten Bandes vorbeimuss: Die Schrift des zweiten Bandes steht unter
  // dessen eigenem Strich, das Kabel steigt nach oben weg und kommt an ihr gar
  // nicht vorbei; die Angaben über dem Dach liegen ohnehin ausserhalb des Wegs.
  // Zählte man sie mit, wäre die Gasse der DURCHSCHNITT zweier Lücken, die
  // gegeneinander versetzt liegen — bei 320 px und „Sehr groß" blieben davon
  // 32 Einheiten übrig und die beiden Kabel sahen aus wie eines. Am ersten
  // Band allein sichert die Zeilenprüfung oben (GAP) mindestens 240 Einheiten.
  let min = -Infinity;
  let max = Infinity;
  for (const it of all) {
    if (!it.spec.below || (it.spec.band ?? 0) !== 0) continue;
    const x0 = it.spec.dir > 0 ? it.spec.at[0] : it.spec.at[0] - it.w;
    if (it.spec.dir > 0) min = Math.max(min, x0 + it.w);
    else max = Math.min(max, x0);
  }
  // Bandabstand: die gemessene Blockhöhe plus Luft. Er wird EINMAL für alle
  // bestimmt (aus den unverkleinerten Grössen), damit die beiden Angaben eines
  // Bandes garantiert auf derselben Höhe stehen.
  const pitch = Math.max(260, Math.round(Math.max(...all.map((i) => i.stack)) + 55));
  const channel = Number.isFinite(min) && Number.isFinite(max) && max - min > 60
    ? { min: min + 30, max: max - 30 }
    : null;
  return { channel, pitch, stack: Math.max(...all.map((i) => i.stack)) };
}

/**
 * Beschriftungen auf ihren Inhalt ausrichten.
 *
 * Nötig, weil die Schriftgrösse einstellbar ist und die Werte unterschiedlich
 * lang sind: Die farbige Linie ist immer genau so breit wie der längste Text
 * darüber, und die Zuleitung dockt ohne Versatz an ihrem inneren Ende an.
 *
 * @param {SVGElement} svg
 * @param {Record<string, number|null>} soc  Ladestand je Speicher, 0…100
 */
export function fitScene(svg, soc = {}, layoutName = 'wide', icons = {}) {
  const specs = layoutOf(layoutName).callouts;
  const fitted = fitRows(svg, specs);
  if (!fitted) return;
  const vias = assignChannels(specs, fitted.channel);
  const vb = (svg.getAttribute('viewBox') ?? '0 0 0 0').split(/\s+/).map(Number);
  const vbTop = Number.isFinite(vb[1]) ? vb[1] : 0;
  svg.querySelectorAll('.sc-cal').forEach((g) => {
    const spec = specs.find((c) => c.id === g.dataset.cal);
    if (!spec) return;
    const label = g.querySelector('.sc-cal-label');
    const value = g.querySelector('.sc-cal-value');
    const note = g.querySelector('.sc-cal-note');
    const rule = g.querySelector('.sc-cal-rule');
    const fill = g.querySelector('.sc-cal-fill');
    // Liegt in der eigenen Ebene darunter, deshalb über die Kennung gesucht.
    const lead = svg.querySelector('#slead-' + spec.id);
    if (!label || !value || !rule) return;

    let lw;
    let vw;
    let nw = 0;
    try {
      lw = label.getBBox().width;
      vw = value.getBBox().width;
      if (note) nw = note.getBBox().width;
    } catch { return; }                        // unsichtbar → später
    if (!(vw > 0)) return;

    const fv = parseFloat(getComputedStyle(value).fontSize) || 60;
    const fl = parseFloat(getComputedStyle(label).fontSize) || 28;
    // Breite des Strichs. Im Regelfall so breit wie der längste Text — er ist
    // dann ein Unterstrich und gehört sichtbar zu seiner Angabe.
    //
    // Bei den Speichern der schmalen Anordnung ist er etwas anderes: eine
    // Anzeige mit fester Länge (barLen). Zwei Gründe:
    //
    //  1. Als Unterstrich war er so lang wie "GROSSER SPEICHER" — über 500
    //     Einheiten, ein Drittel der Bildbreite. Für eine Füllstandsanzeige ist
    //     das zu viel Gewicht; sie erschlug die Zahl darüber.
    //  2. Sein linkes Ende liegt jetzt auf der Steigleitung. Die Zuleitung lief
    //     vorher unsichtbar unter dem Balken entlang und kam irgendwo in seiner
    //     Mitte darunter hervor. Jetzt hört die Anzeige auf, und genau dort
    //     läuft die Leitung weiter — ein durchgehender Zug statt zweier Teile,
    //     die zufällig aneinanderstossen.
    //
    // Die Länge bleibt in Bildeinheiten fest und wächst NICHT mit der Schrift:
    // Sonst verschöbe sich ihr Ende gegenüber der Steigleitung, sobald die
    // Schriftgrösse umgestellt wird, und der Übergang bräche wieder auf.
    const w = spec.barLen ?? Math.max(Math.round(Math.max(lw, vw, nw)), Math.round(fv * 1.6));
    // Dicke: der Unterstrich richtet sich nach der grossen Zahl, die Anzeige
    // nach dem Namen. Sie gehört zur Beschriftung des Geräts, nicht zum Wert.
    const h = spec.barLen
      ? Math.round(fl * 0.22)
      : spec.bar
        ? Math.round(fv * 0.2)
        : Math.round(fv * 0.085);
    const x = spec.at[0];
    // Bandabstand kommt aus fitRows — dort wird die tatsächliche Blockhöhe
    // gemessen, einmal für alle. So stehen die beiden Angaben eines Bandes
    // immer auf derselben Höhe, auch wenn eine Zeile verkleinert wurde.
    let y = spec.at[1] + (spec.band ?? 0) * fitted.pitch;
    // `level`: Die MITTE des Strichs liegt auf der Höhe des Geräts. Damit
    // laufen Strich und Zuleitung auf einer Linie — die Zuleitung braucht dann
    // keinen einzigen Knick. Es muss hier stehen und nicht in LAYOUTS, weil
    // die Strichhöhe mit der Schriftgrösse wächst.
    if (spec.level) y = ANCHORS[spec.anchor].y - h / 2;
    // Oberes Band: bei sehr grosser Schrift so weit nach unten rücken, dass die
    // oberste Zeile im Bild bleibt, statt am viewBox-Rand abgeschnitten zu werden.
    if (y < 0) {
      const inkTop = Math.round(fv * 1.22 + fl * 0.75 + 12);
      y = Math.max(y, vbTop + 20 + inkTop);
    }
    const x0 = spec.dir > 0 ? x : x - w;

    if (Number(rule.getAttribute('width')) !== w || Number(rule.getAttribute('height')) !== h) {
      rule.setAttribute('width', String(w));
      rule.setAttribute('height', String(h));
      rule.setAttribute('rx', String(h / 2));
    }
    rule.setAttribute('x', String(x0));
    // Die Lage des Bandes wird erst hier bestimmt (sie hängt von der
    // Schriftgrösse ab) — die Linie muss deshalb mitgeführt werden.
    rule.setAttribute('y', String(y));

    if (fill) {
      const pct = Math.max(0, Math.min(100, Number(soc[spec.id])));
      const fw = Number.isFinite(pct) ? Math.round((w * pct) / 100) : 0;
      fill.setAttribute('x', String(x0));
      fill.setAttribute('y', String(y));
      fill.setAttribute('height', String(h));
      fill.setAttribute('rx', String(h / 2));
      fill.setAttribute('width', String(fw));
      fill.style.opacity = fw > 0 ? '1' : '0';
    }

    const anchorAttr = spec.dir > 0 ? 'start' : 'end';
    if (label.getAttribute('text-anchor') !== anchorAttr) {
      label.setAttribute('text-anchor', anchorAttr);
      value.setAttribute('text-anchor', anchorAttr);
      if (note) note.setAttribute('text-anchor', anchorAttr);
    }
    label.setAttribute('x', String(x));
    value.setAttribute('x', String(x));
    if (note) note.setAttribute('x', String(x));

    // Der Block liest sich immer NAME → WERT → Zustand. Über dem Strich steht
    // er nach oben aufgebaut, darunter nach unten — die Leserichtung bleibt
    // dieselbe, nur die Seite wechselt.
    if (spec.below) {
      // Der Ladebalken der Speicher ist dicker als die feine Linie der übrigen
      // Angaben. Für den Textabstand zählt trotzdem immer die grössere Höhe —
      // sonst begänne die Schrift links und rechts auf verschiedenen Höhen.
      const top = y + Math.round(fv * 0.2);
      label.setAttribute('y', String(Math.round(top + fl * 1.05)));
      value.setAttribute('y', String(Math.round(top + fl * 1.05 + fv * 0.92)));
      if (note) note.setAttribute('y', String(Math.round(top + fl * 1.05 + fv * 0.92 + fl * 1.3)));
    } else {
      const bottom = note ? y - fl * 0.75 : y;
      if (note) note.setAttribute('y', String(Math.round(y - fl * 0.28)));
      value.setAttribute('y', String(Math.round(bottom - fv * 0.3)));
      label.setAttribute('y', String(Math.round(bottom - fv * 0.3 - fv * 0.92)));
    }

    // Symbol vor dem Namen (nur wo die Anordnung eines vorsieht, also am
    // Telefon). Ausgerichtet wird der sichtbare INHALT der Zeichnung, nicht der
    // Dateirand — siehe STORAGE_ICONS.
    const iconEl = g.querySelector('.sc-cal-icon');
    if (iconEl) {
      const art = STORAGE_ICONS[icons[spec.id]];
      if (art) {
        // Grundmaß aus der Namensgröße, je Symbol nachjustiert: Bei gleichem
        // Kasten wäre der kleine Würfel nur halb so hoch wie der große Schrank
        // (40 % gegen 78 % Inhaltsanteil) und auf dem Telefon kaum noch zu
        // erkennen. Mit dem Faktor bleibt er deutlich kleiner — aber lesbar.
        const box = Math.round(fl * 1.9 * (art.scale ?? 1));
        const gap = Math.round(fl * 0.3);
        const textLinks = spec.dir > 0 ? x : x - lw;
        const bildX = Math.round(textLinks - gap - box * art.right);
        // Auf die Mitte der Versalien, nicht auf die Grundlinie.
        const grundlinie = Number(label.getAttribute('y')) || 0;
        const bildY = Math.round(grundlinie - fl * 0.36 - box * art.mid);
        if (iconEl.getAttribute('href') !== art.href) iconEl.setAttribute('href', art.href);
        iconEl.setAttribute('x', String(bildX));
        iconEl.setAttribute('y', String(bildY));
        iconEl.setAttribute('width', String(box));
        iconEl.setAttribute('height', String(box));
        iconEl.style.display = '';
      } else {
        iconEl.style.display = 'none';
      }
    }

    // Zuleitung — rechtwinklig geführt, damit sie nie durch Schrift läuft.
    if (!lead) return;
    lead.setAttribute('d', elbowPath(leadPoints(spec, x, y + h / 2, x0, w, vias), 22));
  });

  // Passt der Inhalt nicht mehr in die Zeichenfläche, wird sie unten erweitert.
  // Nötig auf sehr kleinen Geräten: Dort wächst die Schrift über die
  // Pixel-Untergrenze mit, und der Textblock wird höher als vorgesehen.
  // Nur in der schmalen Anordnung — dort hängt der Massstab allein an der
  // Breite, ein Wachsen der Höhe kann sich also nicht selbst aufschaukeln.
  if (layoutName === 'narrow') {
    try {
      const bb = svg.getBBox();
      const over = (bb.y + bb.height) - (vb[1] + vb[3]);
      if (over > 1) svg.setAttribute('viewBox', [vb[0], vb[1], vb[2], Math.ceil(vb[3] + over + 24)].join(' '));
    } catch { /* unsichtbar → beim nächsten Durchlauf */ }
  }
}

/**
 * Gassenplätze verteilen.
 *
 * Zwei Kabel dürfen nicht auf derselben senkrechten Linie liegen — sie sähen
 * dann aus wie eines. Jedes bekommt seine Wunschlage, sofern sie in der
 * gemessenen freien Gasse liegt und genug Abstand zum Nachbarn lässt; sonst
 * werden alle gleichmässig über die Gasse verteilt.
 */
function assignChannels(specs, channel) {
  const out = new Map();
  const list = specs.filter((s) => s.channel != null).sort((a, b) => a.channel - b.channel);
  if (list.length === 0) return out;
  if (!channel) {
    for (const s of list) out.set(s.id, s.channel);
    return out;
  }
  const MIN_SEP = 110;
  const xs = list.map((s) => Math.min(Math.max(s.channel, channel.min), channel.max));
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] - xs[i - 1] < MIN_SEP) xs[i] = xs[i - 1] + MIN_SEP;
  }
  if (xs[xs.length - 1] > channel.max) {
    // Die Wunschlagen passen nicht alle hinein. Dann rückt die ganze Gruppe
    // nach rechts an den Rand der Gasse und behält ihren Mindestabstand.
    //
    // Bewusst NICHT gleichmässig über die Gasse verteilt: Die Lagen sind so
    // gewählt, dass jedes Kabel möglichst gerade in sein Gerät läuft. Wer sie
    // auseinanderzieht, erzeugt bei jedem Kabel einen Querversatz — und der
    // Querversatz des einen endete gemessen 31 Einheiten neben der
    // Steigleitung des anderen.
    const shift = xs[xs.length - 1] - channel.max;
    for (let i = 0; i < xs.length; i++) xs[i] = Math.max(channel.min, xs[i] - shift);
    // Reicht selbst das nicht (sehr schmale Gasse), bleibt nur, sie voll
    // auszunutzen.
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] - xs[i - 1] >= MIN_SEP) continue;
      const span = channel.max - channel.min;
      for (let k = 0; k < xs.length; k++) xs[k] = channel.min + (span * k) / (xs.length - 1);
      break;
    }
  }
  list.forEach((s, i) => out.set(s.id, Math.round(xs[i])));
  return out;
}

/**
 * Stützpunkte der Zuleitung, vom Beschriftungsstrich bis kurz vor das Gerät.
 *
 * Immer rechtwinklig, immer nach demselben Muster (siehe oben bei LAYOUTS):
 * auf Strichhöhe hinaus → senkrecht als Steigleitung → quer in das Gerät.
 * Stücke ohne Länge fallen weg, es bleiben also je nach Lage ein, zwei oder
 * drei Stücke — aber nie eine Schräge.
 *
 * Der frühere Fehler steckte im letzten Punkt: Lag das Gerät weder über noch
 * unter dem Strich, blieben nur Anfang und Ende übrig und daraus wurde eine
 * Gerade quer durch die Szene. Der Knick wird jetzt immer gesetzt.
 *
 * @param {object} spec   Beschriftung aus LAYOUTS
 * @param {number} startX x des inneren Strichendes
 * @param {number} startY y der Strichmitte
 * @param {number|null} x0 linke Kante des Strichs
 * @param {number} w      Breite des Strichs
 * @param {Map|null} vias zugeteilte Gassenplätze (siehe assignChannels)
 */
export function leadPoints(spec, startX, startY, x0 = null, w = 0, vias = null) {
  const a = ANCHORS[spec.anchor];
  const turn = spec.turn ?? a.y;
  const via = vias?.get?.(spec.id) ?? spec.riser ?? spec.channel ?? null;
  const riseX = via ?? a.x;

  // Steht das Gerät ohnehin über dem Strich und ist keine Lage vorgegeben,
  // steigt das Kabel senkrecht aus ihm auf — ohne jeden Knick. Der ruhigste
  // Fall: Es sieht aus, als käme es aus einer Sammelschiene.
  if (via == null && x0 !== null && turn === a.y && a.x >= x0 && a.x <= x0 + w) {
    return backOff([[a.x, startY], [a.x, a.y]]);
  }

  const pts = [[startX, startY]];
  if (Math.abs(riseX - startX) > 1) pts.push([riseX, startY]);   // 1 · Austritt
  if (Math.abs(turn - startY) > 1) pts.push([riseX, turn]);      // 2 · Steigleitung
  if (Math.abs(riseX - a.x) > 1) pts.push([a.x, turn]);          // 3 · Anschluss
  if (Math.abs(turn - a.y) > 1) pts.push([a.x, a.y]);            //     letztes Stück

  return backOff(pts);
}

/**
 * Doppelte Punkte entfernen und kurz vor dem Anker enden, damit der Punkt am
 * Gerät frei steht und die Linie nicht hineinsticht.
 */
function backOff(pts) {
  const clean = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.5);
  const last = clean[clean.length - 1];
  const prev = clean[clean.length - 2];
  if (prev) {
    const dx = last[0] - prev[0], dy = last[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const back = Math.min(16, len * 0.5);
    clean[clean.length - 1] = [last[0] - (dx / len) * back, last[1] - (dy / len) * back];
  }
  return clean;
}

/** Die Zuleitung als einzelne Strecken — für Prüfungen und Tests. */
export function leadSegments(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) out.push([points[i - 1], points[i]]);
  return out;
}

/**
 * Streckenzug mit abgerundeten Ecken. Die Rundung macht aus dem technischen
 * Rechtwinkel eine geführte Leitung statt eines harten Knicks.
 */
function elbowPath(pts, r) {
  const f = (p) => p[0].toFixed(1) + ',' + p[1].toFixed(1);
  if (pts.length < 2) return '';
  let d = 'M' + f(pts[0]);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], prev = pts[i - 1], next = pts[i + 1];
    const l1 = Math.hypot(p[0] - prev[0], p[1] - prev[1]) || 1;
    const l2 = Math.hypot(next[0] - p[0], next[1] - p[1]) || 1;
    const r1 = Math.min(r, l1 / 2), r2 = Math.min(r, l2 / 2);
    const inP = [p[0] + ((prev[0] - p[0]) / l1) * r1, p[1] + ((prev[1] - p[1]) / l1) * r1];
    const outP = [p[0] + ((next[0] - p[0]) / l2) * r2, p[1] + ((next[1] - p[1]) / l2) * r2];
    d += ' L' + f(inP) + ' Q' + f(p) + ' ' + f(outP);
  }
  return d + ' L' + f(pts[pts.length - 1]);
}
