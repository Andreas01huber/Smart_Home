/**
 * Premium-Dashboard (Phase 2, finalisiert).
 *
 * Der Browser rechnet nichts Bedeutungstragendes: Richtung, Normalisierung,
 * Aggregation und Accounting passieren im Backend. Hier wird nur dargestellt.
 * Alle Zahlen laufen durch die zentralen Formatter aus format.js.
 */

'use strict';

import {
  formatSoc, formatPercentage, formatPower, formatPowerParts,
  formatEnergy, formatEnergyParts, formatCurrency, formatClock, formatDuration,
} from './format.js';
import { buildScene, fitScene, createSkyGate, sceneViewBox, pickSceneLayout } from './scene.js';

// ── Icons (echte Grafiken) ────────────────────────────────────────────
const ICON = {
  home: '/assets/energy/home.png',
  inverter: '/assets/energy/fronius-inverter.png',
  grid: '/assets/energy/grid.png',
  batteryFronius: '/assets/energy/battery-fronius.png',
  batteryLarge: '/assets/energy/battery-large.png',
  batteryTotal: '/assets/energy/battery-total.png',
  car: '/assets/energy/leapmotor-c10.png',
};
const ICON_ALT = {
  home: 'Haus', inverter: 'Fronius Wechselrichter', grid: 'Stromnetz',
  batteryFronius: 'Fronius Batteriespeicher', batteryLarge: 'Großer Batteriespeicher',
  batteryTotal: 'Gesamtspeicher (beide Batterien)', car: 'Leapmotor C10',
};
// Pro Icon feine visuelle Korrektur, damit alle im Kreis gleich gewichtet und
// optisch zentriert wirken (unterschiedliche Seitenverhältnisse). scale = relativ
// zur Basisgröße, dy = vertikale Feinkorrektur in px (Anforderung 4/5).
const ICON_CFG = {
  home:           { scale: 1.16, dy: 0 },
  inverter:       { scale: 1.04, dy: -1 },
  grid:           { scale: 0.94, dy: 0 },
  batteryFronius: { scale: 1.0,  dy: 0 },
  batteryLarge:   { scale: 1.06, dy: 0 },
  car:            { scale: 1.22, dy: 1 },
};
function batteryIcon(source) { return source && source.includes('victron') ? 'batteryLarge' : 'batteryFronius'; }

// ── Schriftgrösse der Werte im Energiefluss (Barrierefreiheit) ────────
/**
 * Drei Stufen, damit die Zahlen im Energiefluss auch aus Entfernung oder mit
 * schwächeren Augen gut lesbar sind. Die Einstellung bleibt gespeichert.
 */
const FLOW_SCALES = [
  { value: 1, label: 'Normal' },
  { value: 1.35, label: 'Groß' },
  { value: 1.7, label: 'Sehr groß' },
];
let flowScaleIndex = (() => {
  const saved = Number(localStorage.getItem('energie-flow-scale'));
  return Number.isInteger(saved) && saved >= 0 && saved < FLOW_SCALES.length ? saved : 0;
})();

/**
 * Schriftgrösse für den Wert im Kreis.
 *
 * Vergrössert wie gewünscht — begrenzt aber automatisch, damit auch längere
 * Texte ("keine Daten", "nicht verbunden") im Kreis bleiben und nichts
 * abgeschnitten wird. Die nutzbare Breite ist die Kreissehne auf Texthöhe.
 */
function fitValueSize(text, R, zoom) {
  const wanted = Math.max(12, R * 0.30) * zoom;
  const usableWidth = 1.70 * R; // Sehne bei y = 0.42·R, mit etwas Rand
  const perChar = 0.56;         // Näherung für halbfette Ziffern/Buchstaben
  const maxByWidth = usableWidth / Math.max(1, text.length * perChar);
  return Math.max(10, Math.min(wanted, maxByWidth));
}

const SOURCE_LABEL = {
  'fronius-local': 'Fronius Symo', 'fronius-gen24': 'Fronius GEN24',
  'victron-modbus': 'Victron', 'victron-vrm': 'Victron VRM',
  sum: 'Fronius (Summe)', derived: 'berechnet', none: '—', wallbox: 'Wallbox',
  'ev-charger': 'Aimiler Ladegerät',
};
const QUALITY_WARN = { live: '', stale: 'Verbindung verzögert', offline: 'Verbindung unterbrochen', unknown: 'keine Daten' };

// Statusmodell (Anforderung 38)
const STATUS_META = {
  online: { label: 'Online', cls: 'ok' },
  stale: { label: 'Daten veraltet', cls: 'warn' },
  reconnecting: { label: 'Verbindung wird hergestellt …', cls: 'warn' },
  offline: { label: 'Offline', cls: 'bad' },
  error: { label: 'Fehler', cls: 'bad' },
  not_configured: { label: 'Nicht konfiguriert', cls: 'muted' },
  disabled: { label: 'Deaktiviert', cls: 'muted' },
};

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ── Theme ─────────────────────────────────────────────────────────────
/**
 * Drei Modi statt eines Umschalters: „Automatisch“ folgt der Einstellung des
 * Geräts, Hell und Dunkel überschreiben sie dauerhaft.
 */
const THEME_MODES = [
  ['auto', 'Automatisch'],
  ['light', 'Hell'],
  ['dark', 'Dunkel'],
];

function currentThemeMode() {
  const saved = localStorage.getItem('energie-theme');
  return saved === 'light' || saved === 'dark' ? saved : 'auto';
}

function applyTheme(mode) {
  if (mode === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem('energie-theme');
  } else {
    document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem('energie-theme', mode);
  }
  // Farben kommen aus CSS-Variablen — die von JS gezeichneten Teile (Fluss,
  // Diagramm, Legende) müssen deshalb neu gezeichnet werden.
  if (lastLive) renderFlow(lastLive);
  buildLegend();
  renderChart();
}

function initTheme() {
  applyThemeFromStorage();
  // Im Modus „Automatisch“ auf Systemwechsel reagieren (z. B. Nachtmodus).
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => { if (currentThemeMode() === 'auto') applyTheme('auto'); };
  if (media.addEventListener) media.addEventListener('change', onChange);
}

/** Nur anwenden, ohne neu zu zeichnen — für den Start vor dem ersten Render. */
function applyThemeFromStorage() {
  const saved = localStorage.getItem('energie-theme');
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.setAttribute('data-theme', saved);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// ── State ─────────────────────────────────────────────────────────────
let lastLive = null;
let lastToday = null;
const reconnecting = new Set();

// ── Energy Flow ───────────────────────────────────────────────────────
/**
 * Ein Flow-Knoten: Icon + aktueller Wert INNERHALB des Kreises, der Name
 * AUSSERHALB in einer linienfreien Zone (oben oder unten). Die opake
 * Kreisfläche verdeckt Linienenden — die Verbindung dockt sauber an (Anf. 7–9).
 */
function nodeMarkup(iconKey, value, name, sub, pos, color, R) {
  const cfg = ICON_CFG[iconKey] || { scale: 1, dy: 0 };
  const zoom = FLOW_SCALES[flowScaleIndex].value;
  // Bei grosser Schrift wird das Icon etwas kleiner, damit die Zahl Platz
  // bekommt, ohne dass sich beides überlagert.
  const box = R * 0.84 * cfg.scale * (1 - (zoom - 1) * 0.28);
  const iconCY = -R * 0.3;
  const imgY = iconCY - box / 2 + (cfg.dy || 0);
  const valueY = R * 0.42;
  const valueSize = fitValueSize(String(value), R, zoom);
  const nameY = pos === 'above' ? -(R + 20) : R + 20;
  const subY = pos === 'above' ? -(R + 3) : R + 37;
  return `
    <circle class="node-circle" r="${R}" fill="var(--surface)" stroke="${color}" stroke-opacity="0.5" />
    <image href="${ICON[iconKey]}" x="${(-box / 2).toFixed(1)}" y="${imgY.toFixed(1)}" width="${box.toFixed(1)}" height="${box.toFixed(1)}" preserveAspectRatio="xMidYMid meet"><title>${esc(ICON_ALT[iconKey])}</title></image>
    <text class="node-value" y="${valueY.toFixed(1)}" style="font-size:${valueSize.toFixed(1)}px">${esc(value)}</text>
    <text class="node-name" y="${nameY.toFixed(1)}">${esc(name)}</text>
    <text class="node-sub" y="${subY.toFixed(1)}">${esc(sub || '')}</text>`;
}

/**
 * Zeichnet einen Flow-Knoten. Baut die (statische) Struktur inkl. Icon NUR neu,
 * wenn sich Icon, Name, Position, Größe oder Farbe wirklich ändern — sonst
 * werden nur die Textwerte aktualisiert. Das verhindert das Icon-Flackern bei
 * jeder Sekunde/Aktualisierung.
 */
const _nodeSig = {};
function renderNode(id, iconKey, value, name, sub, pos, color, R) {
  // Die Schriftgrösse gehört zur Struktur: ändert sie sich, muss der Knoten
  // einmal neu gebaut werden (danach werden wieder nur Texte aktualisiert).
  const sig = `${iconKey}|${name}|${pos}|${R.toFixed(1)}|${color}|${flowScaleIndex}`;
  const g = el(id);
  if (_nodeSig[id] !== sig || !g.firstChild) {
    g.innerHTML = nodeMarkup(iconKey, value, name, sub, pos, color, R);
    _nodeSig[id] = sig;
    return;
  }
  const v = g.querySelector('.node-value');
  const s = g.querySelector('.node-sub');
  const nextValue = String(value);
  const nextSub = String(sub || '');
  if (v && v.textContent !== nextValue) {
    v.textContent = nextValue;
    // Passende Grösse zur neuen Textlänge — sonst würde ein längerer Wert
    // ("keine Daten") mit der alten, zu grossen Schrift überlaufen.
    const size = fitValueSize(nextValue, R, FLOW_SCALES[flowScaleIndex].value);
    v.style.fontSize = `${size.toFixed(1)}px`;
  }
  if (s && s.textContent !== nextSub) s.textContent = nextSub;
}

// Responsives Flow-Layout: Desktop breit-radial, Mobile portrait (größere Knoten).
const FLOW_LAYOUTS = {
  desktop: {
    // Oben etwas Luft im Sichtfeld, damit die Beschriftung des obersten
    // Knotens auch bei vergrösserter Schrift nicht angeschnitten wird.
    viewBox: '0 -18 800 538',
    house: { cx: 400, cy: 255, r: 58 },
    nodes: {
      pv:   { cx: 400, cy: 80,  r: 50, pos: 'above' },
      bat1: { cx: 140, cy: 175, r: 50, pos: 'above' },
      bat2: { cx: 660, cy: 175, r: 50, pos: 'above' },
      grid: { cx: 140, cy: 405, r: 50, pos: 'below' },
      ev:   { cx: 660, cy: 405, r: 50, pos: 'below' },
    },
  },
  // Mobile bewusst kompakter als früher: gleiche Anordnung und Lesbarkeit,
  // aber rund 11 % weniger Höhe — dadurch rücken die Kennzahlen darunter
  // näher an den sichtbaren Bereich.
  mobile: {
    viewBox: '0 -16 430 588',
    house: { cx: 215, cy: 288, r: 52 },
    nodes: {
      pv:   { cx: 215, cy: 82,  r: 45, pos: 'above' },
      bat1: { cx: 94,  cy: 214, r: 45, pos: 'above' },
      bat2: { cx: 336, cy: 214, r: 45, pos: 'above' },
      grid: { cx: 94,  cy: 458, r: 45, pos: 'below' },
      ev:   { cx: 336, cy: 458, r: 45, pos: 'below' },
    },
  },
};
let currentLayout = FLOW_LAYOUTS.desktop;

/** Setzt Knotenpositionen und berechnet Docking-Linien (Rand zu Rand). */
function applyFlowLayout(L) {
  currentLayout = L;
  const svg = el('flow-svg');
  svg.setAttribute('viewBox', L.viewBox);
  const H = L.house;
  el('node-house').setAttribute('transform', `translate(${H.cx},${H.cy})`);
  for (const key of ['pv', 'bat1', 'bat2', 'grid', 'ev']) {
    const n = L.nodes[key];
    el('node-' + key).setAttribute('transform', `translate(${n.cx},${n.cy})`);
    const dx = H.cx - n.cx, dy = H.cy - n.cy, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const sx = n.cx + ux * n.r, sy = n.cy + uy * n.r; // Geräterand
    const ex = H.cx - ux * H.r, ey = H.cy - uy * H.r; // Hausrand
    const base = `M${sx.toFixed(1)},${sy.toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)}`;
    el('edge-' + key).setAttribute('d', base);
    // Auto lädt vom Haus weg -> Animationsrichtung Haus→Auto.
    el('flow-' + key).setAttribute('d', key === 'ev' ? `M${ex.toFixed(1)},${ey.toFixed(1)} L${sx.toFixed(1)},${sy.toFixed(1)}` : base);
    const cp = document.querySelector(`[data-cp="${key}"]`);
    if (cp) { cp.setAttribute('cx', sx.toFixed(1)); cp.setAttribute('cy', sy.toFixed(1)); }
  }
}

function pickFlowLayout() {
  return window.innerWidth <= 560 ? FLOW_LAYOUTS.mobile : FLOW_LAYOUTS.desktop;
}

const FLOW_COLOR_CLASSES = ['flow-pv-color', 'flow-house-color', 'flow-grid-color', 'flow-battery-color', 'flow-ev-color'];
// Zuletzt angewandter Zustand je Leitung. Nur bei echter Änderung werden die
// Klassen angefasst — sonst würde die CSS-Animation bei jedem Poll neu starten
// und sichtbar „springen". So läuft sie ununterbrochen und flüssig.
const _flowState = {};
/**
 * Tempo des Lichtflusses, in fünf Stufen (Sekunden je Umlauf).
 *
 * Bewusst logarithmisch und gedeckelt: 0,2 kW kriecht, 3 kW läuft normal,
 * ab ~10 kW ist Schluss. Eine lineare Skalierung würde bei hoher Leistung
 * hektisch wirken — die Darstellung soll ruhig bleiben.
 */
const FLOW_SPEEDS = [4.6, 3.7, 2.9, 2.3, 1.8];
function speedStep(watts) {
  const w = Math.max(0, watts || 0);
  if (w <= 300) return 0;
  const t = Math.log10(w / 300) / Math.log10(11000 / 300);
  return Math.min(4, Math.max(0, Math.round(t * 4)));
}

/**
 * Tempo setzen, ohne die laufende Animation zu stören.
 *
 * Eine geänderte Dauer würde den Fortschritt der CSS-Animation neu abbilden
 * und sichtbar springen lassen. Deshalb wird die Abspielzeit anschliessend so
 * nachgezogen, dass der Puls an derselben Stelle weiterläuft.
 */
function setFlowSpeed(p, watts) {
  const step = speedStep(watts);
  if (p._speedStep === step) return;
  const prevSecs = FLOW_SPEEDS[p._speedStep ?? step];
  const secs = FLOW_SPEEDS[step];
  p._speedStep = step;
  let progress = null;
  const anim = typeof p.getAnimations === 'function' ? p.getAnimations()[0] : null;
  if (anim && typeof anim.currentTime === 'number' && prevSecs) {
    progress = (anim.currentTime % (prevSecs * 1000)) / (prevSecs * 1000);
  }
  p.style.setProperty('--speed', secs + 's');
  if (anim && progress != null) {
    try { anim.currentTime = progress * secs * 1000; } catch { /* Browser mag nicht → egal */ }
  }
}

function setFlow(id, active, reverse, watts, colorClass) {
  const p = el(id);
  if (!p) return;
  // Tempo unabhängig vom Zustand nachführen: Die Leistung ändert sich laufend,
  // Farbe und Richtung dagegen selten.
  if (active) setFlowSpeed(p, watts);
  // Zugehörige Basis-Leitung (edge-*), damit die ganze Leitung mitleuchtet.
  // flow-pv -> edge-pv  |  sflow-pv -> sedge-pv (Hausansicht)
  const edge = el(id.replace(/^(s?)flow-/, '$1edge-'));
  const prev = _flowState[id];
  if (prev && prev.active === active && prev.reverse === reverse && prev.color === colorClass) {
    return; // unverändert → Animation NICHT neu anstoßen
  }
  _flowState[id] = { active, reverse, color: colorClass };

  // Farbe nur bei Wechsel tauschen.
  if (!prev || prev.color !== colorClass) {
    p.classList.remove(...FLOW_COLOR_CLASSES);
    p.classList.add(colorClass);
    if (edge) { edge.classList.remove(...FLOW_COLOR_CLASSES); edge.classList.add(colorClass); }
  }
  if (!active) {
    p.classList.remove('active', 'reverse');
    if (edge) edge.classList.remove('active');
    return;
  }
  // Aktiv schalten (nur beim Übergang inaktiv→aktiv, damit die Animation nicht
  // unnötig neu startet).
  if (!prev || !prev.active) {
    p.classList.add('active');
    if (edge) edge.classList.add('active');
  }
  // Flussrichtung; wechselt nur bei echter Richtungsänderung (Bezug↔Einspeisung,
  // Laden↔Entladen), nicht im Sekundentakt.
  p.classList.toggle('reverse', reverse);
}

const FLOW_MIN_W = 40;

// ── Ansicht des Energieflusses: Diagramm oder Haus ────────────────────
const FLOW_VIEWS = [
  ['diagram', 'Diagramm'],
  ['house', 'Haus'],
];
// Standard ist die Hausansicht. Wer bewusst das Diagramm wählt, behält es —
// die getroffene Wahl steht in localStorage und hat Vorrang.
let flowView = localStorage.getItem('energie-flow-view') === 'diagram' ? 'diagram' : 'house';
let sceneLayout = null;   // 'wide' | 'narrow' — zuletzt gebaute Anordnung
let sceneZoom = null;     // zuletzt gebaute Schriftvergrösserung

/** Massstab der Schrift in der Karte (siehe applyFlowZoom). */
function chipScale() {
  return 1 + (FLOW_SCALES[flowScaleIndex].value - 1) * 0.65;
}
/**
 * Wirksame Vergrösserung in der schmalen Anordnung — dort gedämpft, weil die
 * Schrift ohnehin schon gross ist (siehe --sc-zoom im Stylesheet).
 */
function narrowZoom() {
  return Number((1 + (chipScale() - 1) * 0.45).toFixed(3));
}

/**
 * Baut die Hausszene, sobald sie gebraucht wird — und erneut, wenn der Platz
 * die andere Anordnung verlangt. Der Neuaufbau ist billig (ein innerHTML) und
 * passiert nur beim Wechsel der Bildschirmklasse, nicht bei jedem Messwert.
 */
function ensureScene() {
  const svg = el('scene-svg');
  const wrap = el('scene-view');
  if (!svg || !wrap || wrap.hidden) return;
  // Breite des SVG selbst messen: In der zweispaltigen Desktop-Anordnung ist
  // die Szene deutlich schmaler als das Fenster.
  const width = svg.getBoundingClientRect().width || wrap.clientWidth || window.innerWidth;
  const next = pickSceneLayout(width);
  // Jede Anordnung hat ihre eigene Vergrösserung: schmal gedämpft (die Schrift
  // ist dort ohnehin gross), breit voll.
  const zoom = next === 'narrow' ? narrowZoom() : chipScale();
  if (next === sceneLayout && zoom === sceneZoom) return;
  sceneLayout = next;
  sceneZoom = zoom;
  svg.setAttribute('viewBox', sceneViewBox(next, zoom));
  // Die Klasse trägt die zur Anordnung passenden Schrift- und Linienstärken.
  // Bewusst eine Klasse statt einer Media-Query: Die Anordnung hängt an der
  // Breite des SVG, nicht an der des Fensters.
  svg.classList.toggle('sc-narrow', next === 'narrow');
  svg.classList.toggle('sc-wide', next === 'wide');
  svg.innerHTML = buildScene(next);
  // Zustand von Himmel und Flüssen gilt nach dem Neuaufbau nicht mehr.
  for (const key of Object.keys(_flowState)) delete _flowState[key];
  svg.classList.remove('is-sun', 'is-moon');
  skyGate.reset();
}

function applyFlowView() {
  const house = flowView === 'house';
  const diagram = el('diagram-view');
  const scene = el('scene-view');
  if (diagram) diagram.hidden = house;
  if (scene) scene.hidden = !house;
  // In der Hausansicht verliert die Karte ihre Fläche, damit das freigestellte
  // Haus ohne Box auf dem App-Hintergrund steht.
  const card = el('sec-flow');
  if (card) card.classList.toggle('is-house', house);
  if (house) ensureScene();
  if (lastLive) renderFlow(lastLive);
}

/**
 * Umrechnungsfaktor „ein Bildschirmpixel = wie viele Bildeinheiten" bekannt
 * geben.
 *
 * Die Szene skaliert als Ganzes: Auf einem 320-px-Gerät sind 1615 Bildeinheiten
 * gerade 286 Pixel breit, ein Buchstabe von 52 Einheiten also 9 Pixel hoch.
 * Mit diesem Faktor kann das Stylesheet eine Untergrenze in echten Pixeln
 * ziehen (`max(52px, 11px * var(--sc-px))`) — die Beschriftung bleibt damit auf
 * jedem Gerät lesbar, ohne auf grossen Schirmen unnötig zu wachsen.
 */
function syncSceneUnit(svg) {
  const box = svg.getBoundingClientRect();
  const vb = svg.getAttribute('viewBox');
  if (!vb || !(box.width > 0) || !(box.height > 0)) return;
  const [, , vbw, vbh] = vb.split(/\s+/).map(Number);
  if (!(vbw > 0) || !(vbh > 0)) return;
  // „meet": Es zählt der kleinere der beiden Massstäbe — bei flachen Fenstern
  // begrenzt die Höhe, nicht die Breite.
  const scale = Math.min(box.width / vbw, box.height / vbh);
  if (!(scale > 0)) return;
  const perPx = (1 / scale).toFixed(3);
  if (svg.style.getPropertyValue('--sc-px') !== perPx) {
    svg.style.setProperty('--sc-px', perPx);
  }
}

/** Beschriftung einer Szenen-Angabe setzen (nur bei echter Änderung). */
function setSceneLabel(svg, key, text) {
  const node = svg.querySelector('[data-l="' + key + '"]');
  if (node && node.textContent !== text) node.textContent = text;
}

/** Zustandszeile einer Szenen-Angabe („lädt 1,2 kW", „kein Fahrzeug"). */
function setSceneNote(svg, key, text) {
  const node = svg.querySelector('[data-n="' + key + '"]');
  if (node && node.textContent !== text) node.textContent = text;
}

// ── Sonne und Mond ────────────────────────────────────────────────────
// Sonne ab 1 kW PV-Leistung, Mond unter 0,5 kW. Hysterese und Bestätigungszeit
// stecken in der Einheit selbst (siehe scene.js) — hier wird nur noch die
// Deckkraft umgeschaltet, den Rest erledigt die CSS-Überblendung.
const skyGate = createSkyGate();

function updateSky(svg, pvW) {
  const before = skyGate.state;
  const now = skyGate.update(pvW);
  if (now === before) return;
  // Der Zustand hängt am SVG selbst: So folgen ihm Himmelskörper UND das
  // warme Streiflicht über der Anlage.
  svg.classList.toggle('is-sun', now === 'sun');
  svg.classList.toggle('is-moon', now === 'moon');
}

/**
 * Werte in der Hausszene setzen.
 *
 * Es werden dieselben Zahlen und dieselben Formatierer verwendet wie im
 * Diagramm — die Szene ist reine Darstellung, sie rechnet nichts.
 */
function renderScene(d) {
  const svg = el('scene-svg');
  const wrap = el('scene-view');
  if (!svg || !wrap) return;
  ensureScene();

  const pv = d.solar.valueW;
  const house = d.house.valueW;
  const imp = d.gridImport.valueW ?? 0;
  const exp = d.gridExport.valueW ?? 0;
  const bats = d.batteries.filter((b) => !b.unavailableReason);
  const b1 = bats[0] ?? null;
  const b2 = bats[1] ?? null;
  const ev = d.ev ?? { state: 'not-connected' };

  // Werte rund um das Haus, jeweils am zugehörigen Gerät angebunden
  setF(svg, 'sc-pv', d.solar.quality === 'offline' ? 'keine Daten' : formatPower(pv));
  setF(svg, 'sc-house', formatPower(house));
  setF(svg, 'sc-grid', formatPower(Math.max(imp, exp)));
  setF(svg, 'sc-bat1', b1 ? formatSoc(displaySoc(b1)) : '—');
  setF(svg, 'sc-bat2', b2 ? formatSoc(displaySoc(b2)) : '—');
  // Kurz halten: In der Szene ist wenig Platz, die Langform steht in der Karte.
  // Derselbe Wert wie im Diagramm — eine Regel, beide Bilder.
  setF(svg, 'sc-ev', evNodeValue(ev));

  // Netz-Beschriftung sagt, was gerade passiert — Bezug oder Einspeisung.
  setSceneLabel(svg, 'sc-grid',
    Math.max(imp, exp) <= FLOW_MIN_W ? 'Netz' : exp > imp ? 'Einspeisung' : 'Netzbezug');
  // Speichernamen kommen aus dem Backend („Kleiner Speicher“ / „Großer
  // Speicher“) — am Schreibtisch heissen sie hier deshalb genau wie überall
  // sonst in der App.
  //
  // Am Telefon trägt stattdessen ein Zeichen die Größe. „GROSSER SPEICHER“ war
  // dort 528 Bildeinheiten breit, ein gutes Drittel der Bildbreite: Die Zeile
  // reichte über die Steigleitung des kleinen Speichers hinaus, dessen
  // Zuleitung musste hinter der Schrift des Nachbarn hindurch und wurde vom
  // Halo zerschnitten. Mit dem Zeichen bleibt vom Namen nur das Wort — die
  // Zeile wird kurz genug, dass die Leitung frei daneben läuft, und der Name
  // ist auf dem kleinen Bildschirm mit einem Blick erfasst.
  const groessen = sceneBatterySizes(b1, b2);
  const sceneLabelOf = (battery) =>
    sceneLayout === 'narrow' ? sceneBatteryNoun(battery) : battery.displayName;
  if (b1?.displayName) setSceneLabel(svg, 'sc-bat1', sceneLabelOf(b1));
  if (b2?.displayName) setSceneLabel(svg, 'sc-bat2', sceneLabelOf(b2));

  // Dritte Zeile: was das Gerät gerade TUT. Der Prozentwert allein sagt nicht,
  // ob ein Speicher gerade lädt oder entlädt und mit welcher Leistung —
  // dieselbe Angabe wie im Diagramm und in den Karten, dieselben Formatierer.
  setSceneNote(svg, 'sc-house', 'Verbrauch');
  setSceneNote(svg, 'sc-bat1', b1 ? batState(b1) : 'nicht verbunden');
  setSceneNote(svg, 'sc-bat2', b2 ? batState(b2) : 'nicht verbunden');
  setSceneNote(svg, 'sc-ev', evNodeSub(ev));

  updateSky(svg, pv ?? 0);
  syncSceneUnit(svg);
  fitScene(
    svg,
    // Derselbe Wert wie in der Zahl daneben — sonst zeigte der Balken 99 %,
    // während darüber 100 % steht.
    { bat1: b1 ? displaySoc(b1) : null, bat2: b2 ? displaySoc(b2) : null },
    sceneLayout,
    // Symbole nur am Telefon: Am Schreibtisch stehen die Namen ausgeschrieben.
    sceneLayout === 'narrow' ? groessen : {},
  );

  // Flüsse — exakt dieselben Regeln wie im Diagramm
  const pvActive = (pv ?? 0) > FLOW_MIN_W;
  setFlow('sflow-pv', pvActive, false, pv ?? 0, 'flow-pv-color');
  setFlow('sflow-grid', Math.max(imp, exp) > FLOW_MIN_W, exp > imp, Math.max(imp, exp), 'flow-grid-color');
  setBatFlow('sflow-bat1', b1);
  setBatFlow('sflow-bat2', b2);
  setFlow('sflow-house', (house ?? 0) > FLOW_MIN_W, false, house ?? 0, 'flow-house-color');
  const evActive = (ev.state === 'charging' ? ev.powerW ?? 0 : 0) > FLOW_MIN_W;
  setFlow('sflow-ev', evActive, false, ev.powerW ?? 0, 'flow-ev-color');
}


function renderFlow(d) {
  if (flowView === 'house') { renderScene(d); return; }
  return renderDiagram(d);
}

function renderDiagram(d) {
  const pv = d.solar.valueW;
  const house = d.house.valueW;
  const imp = d.gridImport.valueW ?? 0;
  const exp = d.gridExport.valueW ?? 0;
  const bats = d.batteries.filter((b) => !b.unavailableReason);
  const b1 = bats[0] ?? null;
  const b2 = bats[1] ?? null;

  const L = currentLayout;
  const pvActive = (pv ?? 0) > FLOW_MIN_W;
  renderNode('node-pv', 'inverter', d.solar.quality === 'offline' ? 'keine Daten' : formatPower(pv), 'PV', 'Erzeugung', L.nodes.pv.pos, cssVar('--solar'), L.nodes.pv.r);
  renderNode('node-house', 'home', formatPower(house), 'Haus', 'Verbrauch', 'below', cssVar('--house'), L.house.r);
  const gridSub = Math.max(imp, exp) <= FLOW_MIN_W ? 'Ausgeglichen' : imp > exp ? 'Netzbezug' : 'Einspeisung';
  renderNode('node-grid', 'grid', formatPower(Math.max(imp, exp)), 'Stromnetz', gridSub, L.nodes.grid.pos, cssVar('--grid'), L.nodes.grid.r);
  if (b1) renderNode('node-bat1', batteryIcon(b1.source), formatSoc(displaySoc(b1)), b1.displayName, batState(b1), L.nodes.bat1.pos, cssVar('--battery'), L.nodes.bat1.r);
  else renderNode('node-bat1', 'batteryFronius', '—', 'Kleiner Speicher', 'nicht verbunden', L.nodes.bat1.pos, cssVar('--battery'), L.nodes.bat1.r);
  if (b2) renderNode('node-bat2', batteryIcon(b2.source), formatSoc(displaySoc(b2)), b2.displayName, batState(b2), L.nodes.bat2.pos, cssVar('--battery'), L.nodes.bat2.r);
  else renderNode('node-bat2', 'batteryLarge', '—', 'Großer Speicher', 'nicht verbunden', L.nodes.bat2.pos, cssVar('--battery'), L.nodes.bat2.r);
  const ev = d.ev ?? { state: 'not-connected' };
  renderNode('node-ev', 'car', evNodeValue(ev), 'Leapmotor C10', evNodeSub(ev), L.nodes.ev.pos, cssVar('--ev'), L.nodes.ev.r);

  setFlow('flow-pv', pvActive, false, pv ?? 0, 'flow-pv-color');
  setFlow('flow-grid', Math.max(imp, exp) > FLOW_MIN_W, exp > imp, Math.max(imp, exp), 'flow-grid-color');
  setBatFlow('flow-bat1', b1);
  setBatFlow('flow-bat2', b2);
  const evActive = (d.ev && d.ev.state === 'charging' ? d.ev.powerW ?? 0 : 0) > FLOW_MIN_W;
  setFlow('flow-ev', evActive, false, d.ev?.powerW ?? 0, 'flow-ev-color');

  // Anschlusspunkte in der Farbe des jeweiligen aktiven Flusses hervorheben.
  setCp('pv', pvActive, '--solar');
  setCp('bat1', !!b1 && (b1.state === 'charging' || b1.state === 'discharging'), '--battery');
  setCp('bat2', !!b2 && (b2.state === 'charging' || b2.state === 'discharging'), '--battery');
  setCp('grid', Math.max(imp, exp) > FLOW_MIN_W, '--grid');
  setCp('ev', evActive, '--ev');
}

function setCp(name, active, varName) {
  const cp = document.querySelector(`[data-cp="${name}"]`);
  if (!cp) return;
  cp.style.fill = active ? cssVar(varName) : cssVar('--border-strong');
  cp.style.opacity = active ? '1' : '0.6';
}

function setBatFlow(id, b) {
  if (!b) { setFlow(id, false, false, 0, 'flow-battery-color'); return; }
  const charge = b.chargeW ?? 0;
  const discharge = b.dischargeW ?? 0;
  if (charge > FLOW_MIN_W) setFlow(id, true, true, charge, 'flow-battery-color');
  else if (discharge > FLOW_MIN_W) setFlow(id, true, false, discharge, 'flow-battery-color');
  else setFlow(id, false, false, 0, 'flow-battery-color');
}
/**
 * Wert im Flow-Kreis bzw. auf dem Schild der Hausansicht: Ladeleistung beim
 * Laden, sonst der Zustand in einem Wort.
 *
 * „Frei" heisst: Das Ladegerät antwortet und es hängt kein Fahrzeug daran.
 * Ist es nicht erreichbar oder gar nicht eingerichtet, weiss niemand, ob es
 * frei ist — dann steht „—". (Die Hausansicht zeigte hier früher „Frei",
 * während die Zeile darunter „nicht erreichbar" meldete.)
 */
function evNodeValue(ev) {
  if (ev.state === 'charging' && typeof ev.powerW === 'number') return formatPower(ev.powerW);
  if (ev.state === 'offline' || ev.state === 'not-connected') return '—';
  if (ev.configured === false) return '—';
  if (ev.vehicleConnected === true) return 'Bereit';
  return 'Frei';
}
/** Zeile unter dem Kreis — beschreibt den Zustand in Alltagssprache. */
function evNodeSub(ev) {
  if (ev.state === 'not-connected') return 'nicht eingerichtet';
  if (ev.state === 'offline') return 'nicht erreichbar';
  if (ev.state === 'fault') return 'Störung';
  if (ev.state === 'charging') return 'lädt';
  if (ev.vehicleConnected === true) return 'angeschlossen';
  return 'kein Fahrzeug';
}

/**
 * Welcher der beiden Speicher der große ist.
 *
 * Maßgeblich ist die nutzbare Kapazität, nicht der Name: Die Zuordnung stimmt
 * dadurch auch dann noch, wenn die Speicher in der Konfiguration einmal anders
 * heißen. Fehlt bei einem die Kapazität, bleibt es bei der gewohnten Reihenfolge
 * — der zweite ist der große.
 */
function sceneBatterySizes(b1, b2) {
  const cap = (b) => (typeof b?.usableCapacityWh === 'number' ? b.usableCapacityWh : null);
  const c1 = cap(b1);
  const c2 = cap(b2);
  return c1 !== null && c2 !== null && c1 > c2
    ? { bat1: 'large', bat2: 'small' }
    : { bat1: 'small', bat2: 'large' };
}

/**
 * „Großer Speicher“ → „Speicher“.
 *
 * Am Telefon bleibt nur das letzte Wort des Namens stehen — bei den Standardnamen
 * also „Speicher“, bei einem eigenen Namen dessen Kern. Welcher der beiden
 * gemeint ist, sagt das Symbol davor.
 */
function sceneBatteryNoun(battery) {
  const words = String(battery.displayName ?? '').trim().split(/\s+/);
  return words[words.length - 1] || 'Speicher';
}

/**
 * Ab hier gilt ein ruhender Speicher als voll.
 *
 * Ein voller Speicher steht selten exakt auf 100 %: Sobald das Batterie-
 * management 100 % meldet, hört der Wechselrichter auf zu laden. Danach deckt
 * die Batterie ihren eigenen Standby-Verbrauch (Steuerung, Schütze, Balancing)
 * aus sich selbst, und der Ladestand sinkt langsam um etwa ein Prozent.
 * Nachgeladen wird erst bei deutlicherem Abfall — sonst entstünden dauernd
 * Kleinstzyklen, die die Zellen unnötig altern lassen.
 *
 * Gemessen an der eigenen Anlage: Der kleine Speicher stand am 29.08.2026 von
 * 10:55 bis 15:08 auf 100,0 % und fiel dann in einem Schritt auf 98,9 %, ohne
 * dass je wieder geladen wurde.
 *
 * Die Zahl bleibt deshalb unverändert stehen — sie ist richtig. Nur das Wort
 * daneben sagt, dass 99 % hier bereits „voll" bedeutet. Die Schwelle liegt so,
 * dass sie genau die Anzeigen 99 % und 100 % erfasst.
 */
const FULL_SOC_PERCENT = 98.5;
function isFull(b) {
  return b.state === 'idle'
    && typeof b.socPercent === 'number'
    && b.socPercent >= FULL_SOC_PERCENT;
}

/**
 * Der Ladestand, so wie er angezeigt wird.
 *
 * Ein voller Speicher steht meist auf 99 % statt auf 100 % — aus dem oben
 * beschriebenen Grund. Genau diese Anzeige sieht aber aus, als fehle noch
 * etwas. Ein ruhender voller Speicher wird deshalb auf 100 % gerundet.
 *
 * Die Hysterese steckt schon in isFull(): Sobald der Speicher wieder lädt
 * oder entlädt, steht sofort wieder der gemessene Wert da. Gerundet wird nur
 * die Prozentzahl samt Balken — die Energieangabe („10,9 von 11,1 kWh“) bleibt
 * gemessen: Eine erfundene Kilowattstunde wäre etwas anderes als eine
 * gerundete Prozentzahl.
 */
function displaySoc(b) {
  return isFull(b) ? 100 : b.socPercent;
}

/**
 * Dasselbe für den Gesamtspeicher — voll ist er erst, wenn jeder verbundene
 * Speicher voll ist. Sonst stünde bei beiden Einzelkarten 100 % und in der
 * Summenkarte darunter 99 %.
 */
function displayAggSoc(agg, batteries) {
  const live = (batteries ?? []).filter((b) => !b.unavailableReason);
  return live.length > 0 && live.every(isFull) ? 100 : agg.socPercent;
}

function batState(b) {
  if (b.state === 'charging') return `lädt ${formatPower(b.chargeW)}`;
  if (b.state === 'discharging') return `entlädt ${formatPower(b.dischargeW)}`;
  return isFull(b) ? 'voll' : 'bereit';
}

// ── KPI strip ─────────────────────────────────────────────────────────
function kpiTile(label, value, unit, accent, sub, tip) {
  return `
    <div class="kpi accent-${accent}"${tip ? ` title="${esc(tip)}"` : ''}>
      <span class="kpi-label">${esc(label)}</span>
      <span class="kpi-value">${esc(value)}${unit ? `<span class="kpi-unit">${unit}</span>` : ''}</span>
      ${sub ? `<span class="kpi-sub">${esc(sub)}</span>` : ''}
    </div>`;
}
function renderKpis(d, today) {
  const net = d.storageAggregate?.netPowerW ?? 0;
  const gi = d.gridImport.valueW ?? 0, ge = d.gridExport.valueW ?? 0;
  const pvP = formatPowerParts(d.solar.valueW);
  const houseP = formatPowerParts(d.house.valueW);
  const batP = formatPowerParts(Math.abs(net));
  const gridP = formatPowerParts(Math.max(gi, ge));
  const aut = today?.derived?.autarkyPercent;
  const sc = today?.derived?.selfConsumptionPercent;
  el('kpi-strip').innerHTML =
    kpiTile('PV jetzt', pvP.value, pvP.unit, 'solar') +
    kpiTile('Haus', houseP.value, houseP.unit, 'house') +
    kpiTile('Batterie', batP.value, batP.unit, 'battery', net > 40 ? 'lädt' : net < -40 ? 'entlädt' : 'bereit') +
    kpiTile('Netz', gridP.value, gridP.unit, 'grid', ge > gi ? 'Einspeisung' : 'Bezug') +
    kpiTile('Autarkie heute', aut === null || aut === undefined ? '—' : Math.round(aut), aut === null || aut === undefined ? '' : '%', 'battery', '', 'Anteil Ihres Stromverbrauchs, der durch die eigene Anlage gedeckt wurde.') +
    kpiTile('Eigenverbrauch', sc === null || sc === undefined ? '—' : Math.round(sc), sc === null || sc === undefined ? '' : '%', 'solar', '', 'Anteil des erzeugten Solarstroms, den Sie selbst genutzt haben.');
}

// ── JETZT grid ────────────────────────────────────────────────────────
function metaText(m) {
  const src = SOURCE_LABEL[m.source] ?? m.source;
  const warn = QUALITY_WARN[m.quality] ?? '';
  return warn ? `Quelle: ${src} · ${m.ageLabel} · ${warn}` : `Quelle: ${src} · ${m.ageLabel}`;
}
function metaClass(q) { return q === 'stale' ? 'meta stale' : (q === 'offline' || q === 'unknown') ? 'meta offline' : 'meta'; }
function cardIconImg(key) { return `<img class="card-icon" src="${ICON[key]}" alt="${esc(ICON_ALT[key])}" loading="lazy" />`; }

// --- In-place-Aktualisierung: Struktur (inkl. Icons) einmal bauen, danach nur
//     die Werte patchen. Verhindert das Neu-Erzeugen der <img> pro Sekunde. ---
function setF(root, f, text) {
  const e = root.querySelector(`[data-f="${f}"]`);
  if (e && e.textContent !== String(text)) {
    e.textContent = String(text);
    flashValue(e);
  }
}

/**
 * Dezenter Übergang, wenn sich ein Wert wirklich ändert.
 *
 * Bewusst nur bei echter Änderung (setF prüft das vorher) — deshalb blinkt
 * nichts im Sekundentakt. Die Animation läuft rein in CSS; hier wird nur eine
 * Klasse kurz gesetzt und wieder entfernt.
 */
function flashValue(node) {
  if (!node.classList.contains('value-changed')) {
    node.classList.add('value-changed');
    setTimeout(() => node.classList.remove('value-changed'), 360);
  }
}
function setW(root, f, pct) {
  const e = root.querySelector(`[data-f="${f}"]`);
  if (!e) return;
  const w = `${Math.max(0, Math.min(100, pct))}%`;
  if (e.style.width !== w) e.style.width = w;
}
function setClassText(root, f, cls, text) {
  const e = root.querySelector(`[data-f="${f}"]`);
  if (!e) return;
  if (e.getAttribute('class') !== cls) e.setAttribute('class', cls);
  if (e.textContent !== String(text)) e.textContent = String(text);
}

function batState2(b) {
  if (b.state === 'charging' && b.chargeW > 0) return `Lädt mit ${formatPower(b.chargeW)}`;
  if (b.state === 'discharging' && b.dischargeW > 0) return `Entlädt mit ${formatPower(b.dischargeW)}`;
  return isFull(b) ? 'Voll geladen' : 'Bereit';
}
function batStored(b) {
  return (b.storedEnergyWh != null && b.usableCapacityWh)
    ? `${formatEnergyParts(b.storedEnergyWh).value} von ${formatEnergy(b.usableCapacityWh)}`
    : '';
}

function batteryCardHtml(b, i) {
  if (b.unavailableReason) {
    return `
      <div class="card battery pending">
        <div class="card-head">${cardIconImg(batteryIcon(b.source))}<h3>${esc(b.displayName)}</h3></div>
        <p class="value muted" data-f="bat-${i}-value">Nicht verbunden</p>
        <p class="sub" data-f="bat-${i}-sub">${esc(b.usableCapacityWh ? `Erwartet ${formatEnergy(b.usableCapacityWh)}` : 'Kapazität unbekannt')}</p>
        <p class="meta offline" data-f="bat-${i}-meta">${esc(b.unavailableReason)}</p>
      </div>`;
  }
  const brand = b.source && b.source.includes('victron') ? 'Victron' : 'Fronius';
  const cap = b.usableCapacityWh ? formatEnergy(b.usableCapacityWh) : null;
  return `
    <div class="card battery">
      <div class="card-head">${cardIconImg(batteryIcon(b.source))}<div><h3>${esc(b.displayName)}</h3><span class="card-sublabel">${brand}${cap ? ` · ${cap}` : ''}</span></div></div>
      <p class="value" data-f="bat-${i}-value">${formatSoc(displaySoc(b))}</p>
      <p class="sub" data-f="bat-${i}-sub">${esc(batState2(b))}</p>
      <div class="bat-visual"><div class="bat-body"><div class="bat-fill" data-f="bat-${i}-fill" style="width:${Math.max(0, Math.min(100, displaySoc(b) ?? 0))}%"></div></div></div>
      <p class="stored-line" data-f="bat-${i}-stored">${esc(batStored(b))}</p>
      <p class="${metaClass(b.quality)}" data-f="bat-${i}-meta">${esc(metaText(b))}</p>
    </div>`;
}

/** Baut das gesamte JETZT-Raster einmal (mit data-f-Ankern für spätere Updates). */
function buildNow(d) {
  const pv = formatPowerParts(d.solar.valueW);
  const invRows = (d.inverters ?? []).map((inv, idx) =>
    `<div class="breakdown-row"><span><img class="inv-mini" src="${ICON.inverter}" alt="" />${esc(inv.name)}</span><b data-f="inv-${idx}"></b></div>`).join('');
  const house = formatPowerParts(d.house.valueW);
  const agg = d.storageAggregate;
  const hasAgg = !!(agg && agg.socPercent !== null);
  const g = formatPowerParts(0);

  const cards = [];
  cards.push(`
    <div class="card solar">
      <div class="card-head">${cardIconImg('inverter')}<h3>PV Gesamt</h3></div>
      <p class="value"><span data-f="pv-value">${pv.value}</span><span class="unit" data-f="pv-unit">${pv.unit}</span></p>
      <div class="breakdown">${invRows}</div>
      <p data-f="solar-meta" class="${metaClass(d.solar.quality)}"></p>
    </div>`);
  cards.push(`
    <div class="card house">
      <div class="card-head">${cardIconImg('home')}<h3>Hausverbrauch</h3></div>
      <p class="value"><span data-f="house-value">${house.value}</span><span class="unit" data-f="house-unit">${house.unit}</span></p>
      <p class="sub" data-f="house-sub"></p>
      <p data-f="house-meta" class="${metaClass(d.house.quality)}"></p>
    </div>`);
  d.batteries.forEach((b, i) => cards.push(batteryCardHtml(b, i)));
  if (hasAgg) {
    cards.push(`
      <div class="card total">
        <div class="card-head">${cardIconImg('batteryTotal')}<h3>Gesamtspeicher</h3></div>
        <p class="value" data-f="agg-value"></p>
        <div class="bat-visual"><div class="bat-body"><div class="bat-fill" data-f="agg-fill" style="width:0%"></div></div></div>
        <div class="breakdown">
          <div class="breakdown-row"><span>Gespeichert</span><b data-f="agg-stored"></b></div>
          <div class="breakdown-row"><span>Kapazität</span><b data-f="agg-cap"></b></div>
        </div>
        <p class="meta" data-f="agg-meta"></p>
      </div>`);
  }
  cards.push(`
    <div class="card grid">
      <div class="card-head">${cardIconImg('grid')}<h3>Stromnetz</h3></div>
      <p class="value"><span data-f="grid-value">${g.value}</span><span class="unit" data-f="grid-unit">${g.unit}</span></p>
      <p class="sub" data-f="grid-sub"></p>
      <div class="breakdown">
        <div class="breakdown-row"><span>Bezug heute</span><b data-f="grid-imp">—</b></div>
        <div class="breakdown-row"><span>Einspeisung heute</span><b data-f="grid-exp">—</b></div>
      </div>
      <p data-f="grid-meta" class="${metaClass(d.gridImport.quality)}"></p>
    </div>`);
  cards.push(`
    <div class="card ev clickable" id="ev-card" role="button" tabindex="0" aria-label="Leapmotor C10 — Details öffnen">
      <div class="card-head">${cardIconImg('car')}<div><h3>Leapmotor C10</h3><span class="card-sublabel" data-f="ev-brand">Aimiler Ladegerät</span></div></div>
      <p class="value muted" data-f="ev-value">Nicht verbunden</p>
      <p class="ev-status-line"><span class="dot" data-f="ev-dot"></span><span data-f="ev-sub">Wallbox noch nicht verbunden</span></p>
      <div class="breakdown">
        <div class="breakdown-row"><span>Fahrzeug</span><b data-f="ev-plug">—</b></div>
        <div class="breakdown-row"><span>Akkustand</span><b data-f="ev-soc">—</b></div>
        <div class="breakdown-row"><span>Ladevorgang</span><b data-f="ev-session">—</b></div>
        <div class="breakdown-row"><span>Gesamt geladen</span><b data-f="ev-total">—</b></div>
        <div class="breakdown-row"><span>Max. Ladestrom</span><b data-f="ev-cur">—</b></div>
        <div class="breakdown-row"><span>Temperatur</span><b data-f="ev-temp">—</b></div>
      </div>
      <div class="card-actions">
        <span class="card-more">Details ansehen ›</span>
        <button class="connect-btn" id="ev-connect" type="button" title="Nur die Datenverbindung zum Ladegerät herstellen — startet keinen Ladevorgang">Verbinden</button>
      </div>
      <p data-f="ev-meta" class="meta"></p>
    </div>`);

  el('now-grid').innerHTML = cards.join('');

  // Fahrzeug-Karte öffnet die Detailansicht (Maus und Tastatur).
  const card = el('ev-card');
  if (card) {
    card.addEventListener('click', (e) => {
      if (e.target.closest('#ev-connect')) return; // Knopf hat Vorrang
      openEvDetail();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEvDetail(); }
    });
  }
  const connect = el('ev-connect');
  if (connect) {
    connect.addEventListener('click', (e) => { e.stopPropagation(); evConnect(connect); });
  }
}

/** Aktualisiert nur die Werte im bereits gebauten Raster (kein Icon-Neuaufbau). */
function updateNow(d) {
  const root = el('now-grid');
  const pv = formatPowerParts(d.solar.valueW);
  setF(root, 'pv-value', pv.value); setF(root, 'pv-unit', pv.unit);
  (d.inverters ?? []).forEach((inv, idx) => {
    const off = inv.quality === 'offline' || inv.quality === 'unknown';
    setF(root, `inv-${idx}`, off ? 'keine Daten' : formatPower(inv.powerW));
  });
  setClassText(root, 'solar-meta', metaClass(d.solar.quality), metaText(d.solar));

  const house = formatPowerParts(d.house.valueW);
  setF(root, 'house-value', house.value); setF(root, 'house-unit', house.unit);
  const houseToday = lastToday?.totals?.houseConsumptionWh;
  setF(root, 'house-sub', houseToday != null ? `Heute ${formatEnergy(houseToday)}` : 'Aktueller Verbrauch');
  setClassText(root, 'house-meta', metaClass(d.house.quality), metaText(d.house));

  d.batteries.forEach((b, i) => {
    if (b.unavailableReason) {
      setF(root, `bat-${i}-value`, 'Nicht verbunden');
      return;
    }
    setF(root, `bat-${i}-value`, formatSoc(displaySoc(b)));
    setF(root, `bat-${i}-sub`, batState2(b));
    setW(root, `bat-${i}-fill`, displaySoc(b) ?? 0);
    setF(root, `bat-${i}-stored`, batStored(b));
    setClassText(root, `bat-${i}-meta`, metaClass(b.quality), metaText(b));
  });

  const agg = d.storageAggregate;
  if (agg && agg.socPercent !== null) {
    const aggSoc = displayAggSoc(agg, d.batteries);
    setF(root, 'agg-value', formatSoc(aggSoc));
    setW(root, 'agg-fill', aggSoc);
    setF(root, 'agg-stored', formatEnergy(agg.storedWh));
    setF(root, 'agg-cap', formatEnergy(agg.totalCapacityWh));
    // Fusszeile wie bei den übrigen Karten — sonst endet diese Karte höher als
    // ihre Nachbarn und die Reihe bekommt keine gemeinsame Unterkante.
    const names = d.batteries.filter((b) => !b.unavailableReason).map((b) => b.displayName);
    setF(root, 'agg-meta', names.length ? `Beide Speicher zusammen: ${names.join(' + ')}` : 'Beide Speicher zusammen');
  }

  const gi = d.gridImport.valueW ?? 0, ge = d.gridExport.valueW ?? 0;
  const isExport = ge > gi;
  const g = formatPowerParts(isExport ? ge : gi);
  setF(root, 'grid-value', g.value); setF(root, 'grid-unit', g.unit);
  setF(root, 'grid-sub', d.gridImport.valueW === null ? 'Keine Daten' : isExport ? 'Netzeinspeisung' : gi > 0 ? 'Netzbezug' : 'Ausgeglichen');
  const gt = lastToday?.totals;
  setF(root, 'grid-imp', gt ? formatEnergy(gt.gridImportWh) : '—');
  setF(root, 'grid-exp', gt ? formatEnergy(gt.gridExportWh) : '—');
  setClassText(root, 'grid-meta', metaClass(d.gridImport.quality), metaText(d.gridImport));

  updateEv(root, d.ev ?? { state: 'not-connected' });
}

// Kurzform für die grosse Zeile, Langform für die Unterzeile — wie bei den
// übrigen Karten (Wert oben, Erklärung darunter).
const EV_SHORT = {
  'not-connected': 'Nicht eingerichtet',
  offline: 'Nicht erreichbar',
  idle: 'Bereit',
  connected: 'Angeschlossen',
  waiting: 'Wartet',
  charging: 'Lädt',
  paused: 'Pausiert',
  finished: 'Fertig',
  fault: 'Störung',
  unknown: 'Unbekannt',
};
/** Beschriftung je Ladezustand. Nie „0 kW“ erfinden, wenn nichts bekannt ist. */
const EV_STATE_TEXT = {
  'not-connected': 'Wallbox noch nicht eingerichtet',
  offline: 'Ladegerät nicht erreichbar',
  idle: 'Kein Fahrzeug angeschlossen',
  connected: 'Fahrzeug angeschlossen, lädt nicht',
  waiting: 'Fahrzeug angeschlossen, wartet',
  charging: 'Lädt gerade',
  paused: 'Ladevorgang pausiert',
  finished: 'Ladevorgang beendet',
  fault: 'Störung am Ladegerät',
  unknown: 'Zustand unbekannt',
};

/**
 * Wallbox-Karte aktualisieren.
 *
 * Grundregel: Was das Gerät nicht liefert, wird als „—“ bzw. „nicht verfügbar“
 * gezeigt — niemals als 0 und niemals geschätzt. Das gilt besonders für den
 * Fahrzeug-Akkustand: AC-Ladegeräte übertragen ihn technisch nicht.
 */
function updateEv(root, ev) {
  const charging = ev.state === 'charging';
  const hasPower = typeof ev.powerW === 'number' && Number.isFinite(ev.powerW);

  // Hauptwert: Ladeleistung, sobald geladen wird — sonst der Zustand im Klartext.
  setClassText(
    root, 'ev-value',
    charging ? 'value' : 'value muted',
    charging && hasPower ? formatPower(ev.powerW) : (EV_SHORT[ev.state] ?? 'Nicht verbunden'),
  );
  setF(root, 'ev-sub',
    ev.faultText ?? EV_STATE_TEXT[ev.state] ?? 'Wallbox noch nicht eingerichtet');

  setF(root, 'ev-plug',
    ev.vehicleConnected === true ? 'Angeschlossen'
      : ev.vehicleConnected === false ? 'Nicht angeschlossen'
      : '—');
  // Der Ladestand kann vom Ladegerät nicht kommen (IEC 61851, kein Datenkanal).
  setF(root, 'ev-soc', ev.socPercent == null ? 'nicht verfügbar' : formatSoc(ev.socPercent));
  setF(root, 'ev-session', ev.sessionEnergyWh == null ? '—' : formatEnergy(ev.sessionEnergyWh));
  setF(root, 'ev-total', ev.totalEnergyWh == null ? '—' : formatEnergy(ev.totalEnergyWh));
  setF(root, 'ev-cur', ev.maxCurrentA == null ? '—' : `${ev.maxCurrentA} A`);
  setF(root, 'ev-temp', ev.temperatureC == null ? '—' : `${ev.temperatureC} °C`);
  setF(root, 'ev-brand', ev.configured ? 'Aimiler Ladegerät' : 'Wallbox nicht eingerichtet');
  setClassText(root, 'ev-meta', metaClass(ev.quality ?? 'unknown'),
    ev.configured ? `Quelle: ${SOURCE_LABEL[ev.source] ?? ev.source ?? 'Wallbox'} · ${ev.ageLabel ?? ''}` : '');

  // Ladezustand sichtbar machen: die Karte lebt beim Laden dezent auf.
  const evCard = el('ev-card');
  if (evCard) evCard.classList.toggle('is-charging', charging);
  // Ampelpunkt der Statuszeile: grün = lädt, blau = angeschlossen,
  // grau = bereit, rot = Störung/nicht erreichbar.
  const dotCls =
    ev.state === 'fault' || ev.state === 'offline' ? 'dot bad'
      : charging ? 'dot ok'
      : ev.vehicleConnected === true ? 'dot warn'
      : 'dot';
  const dotEl = root.querySelector('[data-f="ev-dot"]');
  if (dotEl && dotEl.getAttribute('class') !== dotCls) dotEl.setAttribute('class', dotCls);

  // Verbinden-Knopf: zeigt den Zustand der DATENVERBINDUNG, nicht des Ladens.
  const connect = el('ev-connect');
  if (connect && !connect.disabled) {
    const online = ev.configured && ev.state !== 'offline' && ev.state !== 'not-connected';
    const label = online ? 'Verbunden' : 'Verbinden';
    if (connect.textContent !== label) connect.textContent = label;
    connect.classList.toggle('ok', online);
  }
}

/** Signatur der Struktur: nur bei Änderung wird komplett neu gebaut. */
function nowSignature(d) {
  const bats = d.batteries.map((b) => b.deviceId + (b.unavailableReason ? ':off' : '')).join(',');
  const invCount = (d.inverters ?? []).length;
  const hasAgg = !!(d.storageAggregate && d.storageAggregate.socPercent !== null);
  // Wallbox: nur "eingerichtet ja/nein" gehört in die Struktur-Signatur. Alle
  // laufenden Werte werden in-place aktualisiert (kein Neuaufbau, kein Flackern).
  const evCfg = d.ev?.configured ? 1 : 0;
  return `${invCount}|${bats}|${hasAgg}|${evCfg}`;
}

let _nowSig = null;
function renderNow(d) {
  const sig = nowSignature(d);
  if (sig !== _nowSig || !el('now-grid').firstChild) {
    buildNow(d);
    _nowSig = sig;
  }
  updateNow(d);
}

// ── TAGESVERLAUF: Zustand ─────────────────────────────────────────────
let dayData = null;                 // Antwort von /api/history/day
let selectedDate = null;            // 'YYYY-MM-DD'
let chartView = 'power';            // 'power' | 'soc'
const hiddenByView = { power: new Set(), soc: new Set() };
const seenSeriesKeys = new Set();   // damit Default-Sichtbarkeit nur einmal greift
let hoverIndex = null;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftDateStr(date, days) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return todayStrOf(d);
}
function todayStrOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function resolveColor(c) {
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(c);
  return m ? cssVar(m[1]) : c;
}

const INV_COLORS = ['#f59e0b', '#fb923c', '#eab308'];
const BAT_COLORS = ['var(--battery)', 'var(--ev)', '#14b8a6'];

/** Serien für die aktuelle Ansicht, aus den Geräten des geladenen Tages. */
function buildSeries() {
  if (!dayData) return [];
  const invs = dayData.inverters ?? [];
  const bats = dayData.batteries ?? [];
  const list = [];
  if (chartView === 'power') {
    list.push({ key: 'pv', label: 'PV gesamt', color: 'var(--solar)', on: true, get: (p) => p.pv });
    invs.forEach((inv, i) =>
      list.push({ key: 'inv:' + inv.id, label: inv.name, color: INV_COLORS[i % INV_COLORS.length], on: false, get: (p) => (p.inv ? p.inv[inv.id] ?? null : null) }));
    list.push({ key: 'house', label: 'Haus', color: 'var(--house)', on: true, get: (p) => p.house });
    list.push({ key: 'gridImport', label: 'Netzbezug', color: '#ef4444', on: true, get: (p) => p.gridImport });
    list.push({ key: 'gridExport', label: 'Einspeisung', color: 'var(--grid)', on: true, get: (p) => p.gridExport });
    bats.forEach((b, i) =>
      list.push({ key: 'bat:' + b.deviceId, label: b.name, color: BAT_COLORS[i % BAT_COLORS.length], on: false, signed: true, get: (p) => (p.bat && p.bat[b.deviceId] ? p.bat[b.deviceId].p : null) }));
  } else {
    bats.forEach((b, i) =>
      list.push({ key: 'soc:' + b.deviceId, label: b.name, color: BAT_COLORS[i % BAT_COLORS.length], on: true, get: (p) => (p.bat && p.bat[b.deviceId] ? p.bat[b.deviceId].soc : null) }));
    list.push({ key: 'socAgg', label: 'Gesamt', color: 'var(--text-dim)', on: true, get: (p) => p.socAgg });
  }
  // Default-Sichtbarkeit je Serie genau einmal anwenden (danach entscheidet der Nutzer).
  const hidden = hiddenByView[chartView];
  for (const s of list) {
    if (!seenSeriesKeys.has(s.key)) { seenSeriesKeys.add(s.key); if (!s.on) hidden.add(s.key); }
  }
  return list;
}
function activeSeries() {
  const hidden = hiddenByView[chartView];
  return buildSeries().filter((s) => !hidden.has(s.key));
}

// ── Tages-Zusammenfassung ─────────────────────────────────────────────
/** Kleines Kachel-Icon: echtes Geräte-Bild (ICON-Key) oder Emoji-Symbol. */
function statIcon(key) {
  return ICON[key]
    ? `<img class="stat-icon" src="${ICON[key]}" alt="" loading="lazy" />`
    : `<span class="stat-emoji">${key}</span>`;
}
function renderDaySummary() {
  const grid = el('today-grid');
  if (!dayData || !dayData.hasData) {
    grid.innerHTML = `<div class="day-summary-empty">Für diesen Tag liegen keine vollständigen Daten vor.</div>`;
    return;
  }
  const t = dayData.totals, der = dayData.derived ?? {};
  const stat = (icon, label, parts, extra, tip) => {
    const v = typeof parts === 'string' ? parts : parts.value;
    const u = typeof parts === 'string' ? '' : parts.unit;
    return `<div class="stat"${tip ? ` title="${esc(tip)}"` : ''}>` +
      `<div class="stat-head">${statIcon(icon)}<span class="s-label">${esc(label)}</span></div>` +
      `<span class="s-value">${esc(v)}${u ? `<span class="u">${u}</span>` : ''}</span>${extra ?? ''}</div>`;
  };
  // Vergleich zum Vortag — aber nur für abgeschlossene Tage. Am laufenden Tag
  // stünde eine halbe Tagesernte gegen einen ganzen Vortag; um acht Uhr früh
  // meldete das „−98 %", ohne dass etwas nicht stimmte.
  let delta = '';
  const prevProd = dayData.comparison?.previousTotals?.productionWh ?? null;
  if (prevProd && prevProd > 100 && selectedDate !== todayStr()) {
    const p = ((t.productionWh - prevProd) / prevProd) * 100;
    delta = `<span class="s-delta ${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '+' : ''}${Math.round(p)} % ggü. Vortag</span>`;
  }
  let html =
    stat('inverter', 'Produktion', formatEnergyParts(t.productionWh), delta) +
    stat('home', 'Verbrauch', formatEnergyParts(t.houseConsumptionWh)) +
    stat('grid', 'Netzbezug', formatEnergyParts(t.gridImportWh)) +
    stat('grid', 'Einspeisung', formatEnergyParts(t.gridExportWh)) +
    stat('🛡️', 'Autarkie', der.autarkyPercent == null ? '—' : { value: Math.round(der.autarkyPercent), unit: '%' }, '', 'Anteil Ihres Stromverbrauchs, der durch die eigene Anlage gedeckt wurde.') +
    stat('♻️', 'Eigenverbrauch', der.selfConsumptionPercent == null ? '—' : { value: Math.round(der.selfConsumptionPercent), unit: '%' }, '', 'Anteil des erzeugten Solarstroms, den Sie selbst genutzt haben.') +
    stat('💶', 'Ersparnis', der.costs ? { value: formatCurrency(der.costs.totalBenefitEUR).replace(' €', ''), unit: '€' } : '—');
  // Je Speicher: geladen / entladen (Anforderung 66).
  for (const b of dayData.batteries ?? []) {
    const bicon = b.deviceId && b.deviceId.includes('victron') ? 'batteryLarge' : 'batteryFronius';
    html += `<div class="stat">` +
      `<div class="stat-head">${statIcon(bicon)}<span class="s-label">${esc(b.name)}</span></div>` +
      `<span class="s-value" style="font-size:1rem">▲ ${esc(formatEnergy(b.chargeWh))}</span>` +
      `<span class="s-delta">▼ ${esc(formatEnergy(b.dischargeWh))}</span></div>`;
  }
  grid.innerHTML = html;
}

// ── KOSTEN ────────────────────────────────────────────────────────────
function renderCosts(t) {
  if (!t?.derived?.costs) { el('cost-grid').innerHTML = ''; return; }
  const c = t.derived.costs;
  const card = (cls, icon, label, big, rows) => `
    <div class="card ${cls}">
      <div class="card-head"><span class="card-icon-emoji">${icon}</span><h3>${esc(label)}</h3></div>
      <p class="value">${esc(big)}</p>
      <div class="breakdown">${rows.map((r) => `<div class="breakdown-row"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('')}</div>
    </div>`;
  el('cost-grid').innerHTML =
    card('battery', '💶', 'Gesamter Vorteil', formatCurrency(c.totalBenefitEUR),
      [['Eigenverbrauch', formatCurrency(c.savedGridCostEUR)], ['Einspeiseerlös', formatCurrency(c.feedInRevenueEUR)]]) +
    card('grid', '⚡', 'Netzkosten', formatCurrency(c.gridCostActualEUR),
      [['Ohne PV & Speicher', formatCurrency(c.gridCostWithoutSystemEUR)], ['Differenz', formatCurrency(c.gridCostWithoutSystemEUR - c.gridCostActualEUR)]]);
}

// ── Legende ───────────────────────────────────────────────────────────
function buildLegend() {
  const hidden = hiddenByView[chartView];
  el('chart-legend').innerHTML = buildSeries().map((s) => `
    <span class="legend-item ${hidden.has(s.key) ? 'off' : ''}" data-key="${esc(s.key)}">
      <span class="legend-swatch" style="background:${resolveColor(s.color)}"></span>${esc(s.label)}
    </span>`).join('');
  el('chart-legend').querySelectorAll('.legend-item').forEach((item) => {
    item.addEventListener('click', () => {
      const key = item.getAttribute('data-key');
      if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
      buildLegend(); renderChart();
    });
  });
}

// ── Chart-Geometrie ───────────────────────────────────────────────────
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
function niceCeil(v) {
  if (v <= 0) return 0;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  const nf = NICE_STEPS.find((s) => f <= s + 1e-9) ?? 10;
  return nf * e;
}
function dayBounds(date) {
  const start = new Date(`${date}T00:00:00`).getTime();
  return { start, end: start + 24 * 3600 * 1000 };
}
const GAP_MS = 4 * 60 * 1000; // Lücke, wenn Punkte weiter auseinander liegen

function renderChart() {
  const svg = el('today-chart');
  const rect = svg.getBoundingClientRect();
  const W = Math.max(320, Math.round(rect.width));
  const H = Math.max(220, Math.round(rect.height));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const pts = (dayData && dayData.series) || [];
  const series = activeSeries();
  const enoughData = dayData && dayData.hasData && pts.length >= 2 && series.length > 0;
  el('chart-empty').hidden = !!enoughData;
  if (!dayData || !dayData.hasData) {
    el('chart-empty').textContent = 'Für diesen Tag liegen keine Daten vor.';
  } else if (pts.length < 2) {
    el('chart-empty').textContent = 'Für diesen Tag liegen noch keine Verlaufsdaten vor.';
  }
  if (!enoughData) { svg.innerHTML = ''; return; }

  const padL = 48, padR = 16, padT = 14, padB = 28;
  const soc = chartView === 'soc';

  // Y-Domäne
  let maxRaw = soc ? 100 : 100;
  let minRaw = 0;
  if (!soc) {
    maxRaw = 200;
    for (const p of pts) for (const s of series) {
      const v = s.get(p);
      if (Number.isFinite(v)) { if (v > maxRaw) maxRaw = v; if (s.signed && v < minRaw) minRaw = v; }
    }
  }
  // Y-Skala: "nice" Schritt aus dem Maximum, ~6 % Headroom, stabil gerundet.
  let minY, maxY, ticks;
  if (soc) {
    minY = 0; maxY = 100; ticks = [0, 25, 50, 75, 100];
  } else {
    const stepKw = Math.max(0.1, niceCeil(((maxRaw / 1000) * 1.06) / 4));
    const maxKw = stepKw * Math.ceil(((maxRaw / 1000) * 1.06) / stepKw);
    maxY = maxKw * 1000;
    minY = minRaw < 0 ? -stepKw * Math.ceil(((-minRaw / 1000) * 1.06) / stepKw) * 1000 : 0;
    ticks = [];
    for (let v = minY; v <= maxY + 1e-6; v += stepKw * 1000) ticks.push(Math.round(v));
  }

  const { start, end } = dayBounds(selectedDate);
  const xOf = (t) => padL + ((t - start) / (end - start)) * (W - padL - padR);
  const yOf = (v) => padT + (1 - (v - minY) / (maxY - minY)) * (H - padT - padB);

  let out = '';
  // Horizontale Gitterlinien + Y-Beschriftung
  const lines = ticks;
  for (const val of lines) {
    const yy = yOf(val);
    const isZero = !soc && Math.abs(val) < 1e-6 && minY < 0;
    out += `<line class="${isZero ? 'chart-zero-line' : 'chart-grid-line'}" x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" />`;
    const label = soc ? `${val}%` : (val / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 });
    out += `<text class="chart-axis-label" x="${padL - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${label}</text>`;
  }
  // Y-Einheit oben links. Im SOC-Modus tragen die Tick-Beschriftungen bereits
  // „%", daher entfällt sie dort (sonst Überlappung mit „100%").
  if (!soc) out += `<text class="chart-axis-label" x="6" y="${(padT + 4).toFixed(1)}">kW</text>`;

  // X-Achse (Stunden)
  const stepH = W < 560 ? 6 : 3;
  for (let h = 0; h <= 24; h += stepH) {
    const t = start + h * 3600 * 1000;
    const xx = xOf(t);
    out += `<line class="chart-grid-line" x1="${xx.toFixed(1)}" y1="${padT}" x2="${xx.toFixed(1)}" y2="${H - padB}" opacity="0.5" />`;
    out += `<text class="chart-axis-label" x="${xx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${String(h).padStart(2, '0')}:00</text>`;
  }

  // Linien mit Lücken
  for (const s of series) {
    const color = resolveColor(s.color);
    let d = '', prevT = null, started = false;
    for (const p of pts) {
      const v = s.get(p);
      if (!Number.isFinite(v) || (prevT !== null && p.t - prevT > GAP_MS)) started = false;
      if (Number.isFinite(v)) {
        d += `${started ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(v).toFixed(1)} `;
        started = true;
        prevT = p.t;
      }
    }
    out += `<path class="chart-line" style="stroke:${color}" d="${d.trim()}" />`;
  }
  out += `<g class="hover-layer"></g>`;
  svg.innerHTML = out;

  // Geometrie für den Hover merken
  svg._chart = { W, H, padL, padR, padT, padB, start, end, minY, maxY, xOf, yOf, series, pts, soc };
  if (hoverIndex !== null) updateHover();
}

// ── Hover / Tooltip / Crosshair ───────────────────────────────────────
function setupChartHover() {
  const svg = el('today-chart');
  const move = (clientX) => {
    const c = svg._chart;
    if (!c || !c.pts.length) return;
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * c.W;
    // nächsten Punkt per Zeit finden
    const targetT = c.start + ((px - c.padL) / (c.W - c.padL - c.padR)) * (c.end - c.start);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < c.pts.length; i++) {
      const dd = Math.abs(c.pts[i].t - targetT);
      if (dd < bestD) { bestD = dd; best = i; }
    }
    hoverIndex = best;
    updateHover();
  };
  svg.addEventListener('pointermove', (e) => move(e.clientX));
  svg.addEventListener('pointerdown', (e) => move(e.clientX));
  svg.addEventListener('pointerleave', () => { hoverIndex = null; clearHover(); });
}
function clearHover() {
  const svg = el('today-chart');
  const layer = svg.querySelector('.hover-layer');
  if (layer) layer.innerHTML = '';
  el('chart-tooltip').hidden = true;
}
function updateHover() {
  const svg = el('today-chart');
  const c = svg._chart;
  const layer = svg && svg.querySelector('.hover-layer');
  if (!c || !layer || hoverIndex === null || hoverIndex >= c.pts.length) return;
  const p = c.pts[hoverIndex];
  const xx = c.xOf(p.t);
  let g = `<line class="chart-crosshair" x1="${xx.toFixed(1)}" y1="${c.padT}" x2="${xx.toFixed(1)}" y2="${c.H - c.padB}" />`;
  const rows = [];
  for (const s of c.series) {
    const v = s.get(p);
    if (!Number.isFinite(v)) continue;
    const yy = c.yOf(v);
    const color = resolveColor(s.color);
    g += `<circle class="chart-dot" cx="${xx.toFixed(1)}" cy="${yy.toFixed(1)}" r="4" fill="${color}" />`;
    const val = c.soc ? formatSoc(v) : batteryValueLabel(s, v);
    rows.push(`<div class="tt-row"><span class="tt-name"><span class="legend-swatch" style="background:${color}"></span>${esc(s.label)}</span><span class="tt-val">${esc(val)}</span></div>`);
  }
  layer.innerHTML = g;
  const tip = el('chart-tooltip');
  tip.innerHTML = `<div class="tt-time">${formatClock(p.t)}</div>${rows.join('')}`;
  tip.hidden = false;
  // Position (in Container-Pixeln)
  const wrap = el('chart-wrap');
  const leftPx = (xx / c.W) * wrap.clientWidth;
  const topPx = (c.padT / c.H) * wrap.clientHeight + 8;
  tip.style.left = `${Math.max(70, Math.min(wrap.clientWidth - 70, leftPx))}px`;
  tip.style.top = `${topPx}px`;
}
function batteryValueLabel(s, v) {
  if (s.signed) {
    if (v > 1) return `lädt ${formatPower(v)}`;
    if (v < -1) return `entlädt ${formatPower(-v)}`;
    return formatPower(0);
  }
  return formatPower(v);
}

// ── Datumsnavigation ──────────────────────────────────────────────────
function dayTitle(date) {
  if (date === todayStr()) return 'Heute';
  if (date === shiftDateStr(todayStr(), -1)) return 'Gestern';
  return new Date(`${date}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}
function syncDateUI() {
  el('history-title').textContent = dayTitle(selectedDate);
  const input = el('date-input');
  input.value = selectedDate;
  input.max = todayStr();
  el('date-next').disabled = selectedDate >= todayStr();
  document.querySelectorAll('.quick-chips .chip').forEach((chip) => {
    const target = chip.getAttribute('data-day') === 'today' ? todayStr() : shiftDateStr(todayStr(), -1);
    chip.classList.toggle('active', selectedDate === target);
  });
}

// ── Status / Quellen + Reconnect ──────────────────────────────────────
/**
 * Signatur des Detail-Panels: ändert sich nur bei echten Zustandsänderungen
 * (Status, angezeigter „Letzter Kontakt" in Minuten, laufender Reconnect,
 * negativer Verbrauch). Verhindert, dass Panel und Reconnect-Buttons bei jedem
 * Poll (Sekundentakt) neu erzeugt werden.
 */
function statusSignature(d) {
  const diags = d.diagnostics ?? [];
  return diags
    .map((x) => {
      const contact = x.lastSuccessAt ? formatClock(x.lastSuccessAt) : x.status;
      const busy = reconnecting.has(x.connectorId) ? '1' : '0';
      const canReconnect = x.reconnectable && (x.status === 'offline' || x.status === 'error' || x.status === 'stale') ? '1' : '0';
      return `${x.connectorId}:${x.status}:${contact}:${busy}:${canReconnect}`;
    })
    .join('|') + `|neg:${d.derivedConsumptionNegative ? 1 : 0}`;
}

let _statusSig = null;
function renderStatus(d) {
  const diags = d.diagnostics ?? [];
  // Kopfzeile (Ampel + Text) ist billig und wird bei jedem Poll aktualisiert.
  const real = diags.filter((x) => x.status !== 'not_configured' && x.status !== 'disabled');
  const problems = real.filter((x) => x.status !== 'online').length;
  const dot = el('status-dot'), text = el('status-text');
  dot.className = 'dot';
  // Zwei Fassungen: die ausführliche steht im Text, die kurze in data-short.
  // Auf schmalen Telefonen zeigt das Stylesheet die kurze — so bleibt der Name
  // der App vollständig, statt zu „Smart…" zu werden.
  const setStatus = (cls, long, short) => {
    if (cls) dot.classList.add(cls);
    if (text.textContent !== long) text.textContent = long;
    if (text.dataset.short !== short) text.dataset.short = short;
  };
  if (real.length === 0) setStatus('warn', 'Keine Quelle', 'Keine Quelle');
  else if (problems === 0) setStatus('ok', 'Alle Systeme online', 'Online');
  else if (problems < real.length) setStatus('warn', `${problems} Gerät${problems > 1 ? 'e' : ''} offline`, `${problems} offline`);
  else setStatus('bad', 'Verbindungsprobleme', 'Probleme');

  // Das Detail-Panel (Zeilen + Reconnect-Buttons + Hinweis) nur bei echter
  // Änderung neu bauen — nicht im Sekundentakt (spart DOM-Churn, kein Flackern
  // offener Buttons, Event-Listener werden nicht ständig neu gesetzt).
  const sig = statusSignature(d);
  if (sig === _statusSig) return;
  _statusSig = sig;

  const rows = diags.map((x) => {
    const meta = STATUS_META[x.status] ?? STATUS_META.offline;
    const busy = reconnecting.has(x.connectorId);
    const contact = x.lastSuccessAt ? `Letzter Kontakt: ${formatClock(x.lastSuccessAt)}` : (x.status === 'not_configured' ? 'Noch nicht eingerichtet' : 'Noch kein Kontakt');
    const canReconnect = x.reconnectable && (x.status === 'offline' || x.status === 'error' || x.status === 'stale');
    const btn = busy
      ? `<button class="reconnect-btn" disabled><span class="mini-spinner"></span>Verbindung …</button>`
      : canReconnect ? `<button class="reconnect-btn" data-id="${esc(x.connectorId)}">Neu verbinden</button>` : '';
    return `
      <div class="source-row">
        <div class="s-main">
          <span class="s-name"><span class="dot ${meta.cls}"></span>${esc(x.displayName)}</span>
          <span class="s-contact">${esc(contact)}</span>
        </div>
        <div class="s-right">
          <span class="s-state ${meta.cls}">${busy ? 'Verbindung wird hergestellt …' : esc(meta.label)}</span>
          ${btn}
        </div>
      </div>`;
  }).join('');
  const noticeHtml = d.derivedConsumptionNegative
    ? `<div class="notice">Der berechnete Hausverbrauch wäre negativ — es speist wahrscheinlich ein Erzeuger ein, den keine Quelle sieht.</div>`
    : '';
  el('source-panel').innerHTML =
    `<div class="source-title">Systemstatus</div>${rows || '<div class="source-row">Keine Quellen konfiguriert</div>'}${noticeHtml}`;

  el('source-panel').querySelectorAll('.reconnect-btn[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => doReconnect(btn.getAttribute('data-id')));
  });
}

async function doReconnect(id) {
  if (!id || reconnecting.has(id)) return;
  reconnecting.add(id);
  if (lastLive) renderStatus(lastLive);
  try {
    const resp = await fetch(`/api/devices/${encodeURIComponent(id)}/reconnect`, { method: 'POST' });
    const result = await resp.json();
    // Ergebnis sofort in den lastLive-Diagnostics widerspiegeln.
    if (lastLive) {
      const entry = (lastLive.diagnostics ?? []).find((x) => x.connectorId === id);
      if (entry && result && result.status) { entry.status = result.status; entry.online = result.online; entry.lastSuccessAt = result.lastSuccessAt; entry.lastError = result.lastError; }
    }
  } catch (err) {
    console.error('Reconnect fehlgeschlagen', err);
  } finally {
    reconnecting.delete(id);
    if (lastLive) renderStatus(lastLive);
  }
}

// ── Ladezustand ───────────────────────────────────────────────────────
/**
 * Platzhalter in der Grösse des späteren Inhalts.
 *
 * Ohne sie war die Seite bis zur ersten Messung unterhalb der Anlage leer und
 * alle Karten erschienen dann schlagartig — das Layout sprang sichtbar. Die
 * Platzhalter halten dieselbe Höhe, deshalb bewegt sich beim Eintreffen der
 * Daten nichts mehr. Sie werden vom ersten echten Render überschrieben.
 */
function renderSkeletons() {
  const kpi = el('kpi-strip');
  if (kpi && !kpi.firstChild) {
    kpi.innerHTML = Array.from({ length: 6 }, () =>
      '<div class="kpi is-loading"><span class="sk sk-label"></span><span class="sk sk-value"></span></div>').join('');
  }
  const now = el('now-grid');
  if (now && !now.firstChild) {
    now.innerHTML = Array.from({ length: 4 }, () =>
      '<div class="card"><div class="card-head"><span class="sk sk-icon"></span><span class="sk sk-label"></span></div>' +
      '<span class="sk sk-value"></span><span class="sk sk-line"></span><span class="sk sk-line short"></span></div>').join('');
  }
  const today = el('today-grid');
  if (today && !today.firstChild) {
    today.innerHTML = Array.from({ length: 4 }, () =>
      '<div class="stat"><span class="sk sk-label"></span><span class="sk sk-value"></span></div>').join('');
  }
}

// ── Render orchestration ──────────────────────────────────────────────
function renderLive(d) {
  lastLive = d;
  el('flow-updated').textContent = `aktualisiert ${new Date(d.polledAt).toLocaleTimeString('de-DE')}`;
  renderFlow(d);
  renderKpis(d, lastToday);
  renderNow(d);
  renderStatus(d);
  // Offene Detailansicht mitziehen (nur den Live-Teil neu zeichnen).
  if (!el('ev-detail').hidden) renderEvDetail();
}

// ── Data fetching ─────────────────────────────────────────────────────
function connectSSE() {
  const ev = new EventSource('/api/events');
  ev.addEventListener('message', (e) => { try { renderLive(JSON.parse(e.data)); } catch (err) { console.error(err); } });
  ev.addEventListener('error', () => {
    el('status-dot').className = 'dot bad';
    const t = el('status-text');
    t.textContent = 'Keine Verbindung';
    t.dataset.short = 'Getrennt';
  });
}
/** Lädt die vollständige Tagesansicht (Kurve + Zusammenfassung) für ein Datum. */
async function loadDay(date) {
  selectedDate = date;
  hoverIndex = null;
  syncDateUI();
  try {
    dayData = await (await fetch(`/api/history/day?date=${encodeURIComponent(date)}`)).json();
  } catch (err) {
    console.error(err);
    dayData = { date, hasData: false };
  }
  if (date === todayStr()) lastToday = dayData; // für die KPIs oben
  renderDaySummary();
  renderCosts(dayData);
  buildLegend();
  renderChart();
  if (lastLive) { renderKpis(lastLive, lastToday); renderNow(lastLive); }
}

/** Heutige Summen für die KPI-Leiste, auch wenn ein anderer Tag betrachtet wird. */
async function refreshTodayKpis() {
  try {
    if (selectedDate === todayStr()) {
      // Heute im Blick: loadDay lädt bereits den vollständigen Tag (Kurve +
      // Summen), setzt lastToday und zeichnet KPIs/JETZT neu. Ein zusätzlicher
      // summary-Aufruf wäre nur ein doppelter Request auf dieselben Daten.
      await loadDay(todayStr());
    } else {
      // Ein anderer Tag ist geöffnet: nur die heutigen Summen (ohne die große
      // Kurve) für die KPI-Leiste nachladen.
      lastToday = await (await fetch(`/api/history/day?date=${todayStr()}&summary=1`)).json();
      if (lastLive) { renderKpis(lastLive, lastToday); renderNow(lastLive); }
    }
  } catch (err) { console.error(err); }
}

// ── LEAPMOTOR-Detailansicht ───────────────────────────────────────────
let evSessions = null;      // { current, sessions[] }
let evStats = null;         // Antwort von /api/ev/stats
let evStatsRange = 'month'; // day | week | month | year | total
let evOpenSessionId = null; // aufgeklappter Ladevorgang in der Liste

/** Farbe je Energiequelle — dieselben Töne wie im übrigen Dashboard. */
function sourceColor(kind, index) {
  if (kind === 'pv') return cssVar('--solar');
  if (kind === 'grid') return cssVar('--grid');
  if (kind === 'unknown') return cssVar('--text-faint');
  return resolveColor(BAT_COLORS[index % BAT_COLORS.length]);
}

/** Anzeigename eines Speichers aus den Live-Daten, sonst die Geräte-ID. */
function batteryName(deviceId) {
  const hit = (lastLive?.batteries ?? []).find((b) => b.deviceId === deviceId);
  return hit?.displayName ?? deviceId;
}

/** Aufteilung -> Liste { label, wh, color } (nur Anteile > 0). */
function splitItems(split) {
  if (!split) return [];
  const out = [];
  if (split.pvWh > 0) out.push({ label: 'PV direkt', wh: split.pvWh, color: sourceColor('pv') });
  Object.entries(split.batteryWh ?? {}).forEach(([id, wh], i) => {
    if (wh > 0) out.push({ label: batteryName(id), wh, color: sourceColor('bat', i) });
  });
  if (split.gridWh > 0) out.push({ label: 'Stromnetz', wh: split.gridWh, color: sourceColor('grid') });
  if (split.unknownWh > 0) out.push({ label: 'nicht zuordenbar', wh: split.unknownWh, color: sourceColor('unknown') });
  return out;
}

/** Balken + Legende für eine Energieaufteilung. */
function splitMarkup(split) {
  const items = splitItems(split);
  const total = items.reduce((sum, i) => sum + i.wh, 0);
  if (total <= 0) {
    return `<p class="session-empty">Für diesen Zeitraum liegen noch keine zuordenbaren Energiedaten vor.</p>`;
  }
  const bar = items
    .map((i) => `<span style="width:${((i.wh / total) * 100).toFixed(2)}%;background:${i.color}" title="${esc(i.label)}"></span>`)
    .join('');
  const legend = items
    .map((i) => `<span class="src-item"><span class="src-dot" style="background:${i.color}"></span>${esc(i.label)} <b>${esc(formatEnergy(i.wh))}</b></span>`)
    .join('');
  return `<div class="src-bar">${bar}</div><div class="src-legend">${legend}</div>`;
}

/**
 * Eine Kachel der Detailansicht.
 *
 * `state` setzt zusätzlich einen Ampelpunkt („ok“, „warn“, „bad“). Er ergänzt
 * die Beschriftung, ersetzt sie nicht — der Zustand steht immer auch als Wort
 * da, damit die Angabe ohne Farbwahrnehmung verständlich bleibt.
 */
function tile(label, value, muted, state) {
  const dot = state ? `<span class="dot ${state}"></span>` : '';
  return `<div class="detail-tile"><span class="dt-label">${esc(label)}</span>` +
    `<span class="dt-value${muted ? ' muted' : ''}">${dot}${esc(value)}</span></div>`;
}

/** Live-Bereich der Detailansicht — trennt Ladegerät und Fahrzeug sauber. */
function evLiveMarkup(ev) {
  const chargerOnline = ev.configured && ev.state !== 'offline' && ev.state !== 'not-connected';
  const charging = ev.state === 'charging';
  return `
    <div class="detail-section">
      <h3>Live-Status</h3>
      <div class="detail-grid">
        ${tile('Ladegerät', chargerOnline ? 'Online' : (ev.configured ? 'Offline' : 'Nicht eingerichtet'), !chargerOnline, chargerOnline ? 'ok' : ev.configured ? 'bad' : '')}
        ${tile('Fahrzeug', ev.vehicleConnected === true ? 'Verbunden' : ev.vehicleConnected === false ? 'Nicht verbunden' : '—', ev.vehicleConnected !== true, ev.vehicleConnected === true ? 'ok' : '')}
        ${tile('Ladevorgang', EV_SHORT[ev.state] ?? '—', !charging, charging ? 'ok' : ev.state === 'fault' ? 'bad' : '')}
        ${tile('Ladeleistung', charging && ev.powerW != null ? formatPower(ev.powerW) : (chargerOnline ? '0 W' : '—'), !charging)}
        ${tile('Akkustand', ev.socPercent == null ? 'nicht verfügbar' : formatSoc(ev.socPercent), ev.socPercent == null)}
        ${tile('Max. Ladestrom', ev.maxCurrentA == null ? '—' : `${ev.maxCurrentA} A`, true)}
        ${tile('Temperatur', ev.temperatureC == null ? '—' : `${ev.temperatureC} °C`, true)}
        ${tile('Gesamt geladen', ev.totalEnergyWh == null ? '—' : formatEnergy(ev.totalEnergyWh), true)}
      </div>
      ${ev.socPercent == null ? `<p class="card-more">Der Fahrzeug-Akkustand wird beim Wechselstromladen technisch nicht übertragen (IEC 61851) — er kann nur aus dem Fahrzeug selbst kommen.</p>` : ''}
      ${ev.faultText ? `<p class="card-more" style="color:var(--danger)">${esc(ev.faultText)}</p>` : ''}
    </div>`;
}

/** Ein Ladevorgang als Kennzahlen-Raster. */
function sessionMarkup(s, heading) {
  const end = s.endedAt ? formatClock(s.endedAt) : 'läuft';
  return `
    <div class="detail-section">
      <h3>${esc(heading)}</h3>
      <div class="detail-grid">
        ${tile('Start', `${new Date(s.startedAt).toLocaleDateString('de-DE')} ${formatClock(s.startedAt)}`)}
        ${tile('Ende', end, !s.endedAt)}
        ${tile('Ladedauer', formatDuration(s.chargingSeconds))}
        ${tile('Angesteckt', formatDuration(s.connectedSeconds), true)}
        ${tile('Geladen', formatEnergy(s.energyWh))}
        ${tile('Ø Leistung', s.avgPowerW == null ? '—' : formatPower(s.avgPowerW), true)}
        ${tile('Max. Leistung', s.maxPowerW ? formatPower(s.maxPowerW) : '—', true)}
        ${tile('Akku Start / Ende', 'nicht verfügbar', true)}
      </div>
      <h3 style="margin-top:1rem">Woher kam der Strom?</h3>
      ${splitMarkup(s.split)}
      ${s.hasGaps ? `<p class="card-more">Während dieses Ladevorgangs fehlten zeitweise Messwerte — ein Teil ist als „nicht zuordenbar“ ausgewiesen.</p>` : ''}
    </div>`;
}

/** Balkendiagramm im Stil des Tagesverlaufs — ohne zusätzliche Bibliothek. */
function statsChartMarkup(buckets) {
  if (!buckets || buckets.length === 0) return '';
  const W = 640, H = 150, padL = 6, padB = 18, padT = 8;
  const max = Math.max(...buckets.map((b) => b.energyWh), 1);
  const n = buckets.length;
  const slot = (W - padL * 2) / n;
  const bw = Math.max(3, Math.min(38, slot * 0.62));
  let out = '';
  buckets.forEach((b, i) => {
    const h = ((b.energyWh / max) * (H - padT - padB));
    const x = padL + slot * i + (slot - bw) / 2;
    out += `<rect class="ev-bar" x="${x.toFixed(1)}" y="${(H - padB - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3"><title>${esc(b.key)}: ${esc(formatEnergy(b.energyWh))}</title></rect>`;
    if (n <= 16 || i % Math.ceil(n / 12) === 0) {
      const label = b.key.length > 7 ? b.key.slice(8) : b.key.slice(5);
      out += `<text class="ev-chart-label" x="${(x + bw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(label)}</text>`;
    }
  });
  return `<svg class="ev-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Ladeenergie je Zeitraum">${out}</svg>`;
}

const EV_RANGES = [
  ['day', 'Heute'], ['week', 'Woche'], ['month', 'Monat'], ['year', 'Jahr'], ['total', 'Gesamt'],
];

function evStatsMarkup() {
  const chips = EV_RANGES
    .map(([key, label]) => `<button class="vt-btn ${evStatsRange === key ? 'active' : ''}" type="button" data-range="${key}">${label}</button>`)
    .join('');
  const s = evStats;
  const body = s === null
    ? `<p class="session-empty">Wird geladen …</p>`
    : `<div class="detail-grid">
         ${tile('Geladen', formatEnergy(s.energyWh))}
         ${tile('Ladevorgänge', String(s.sessionCount), true)}
         ${tile('Ladedauer', formatDuration(s.chargingSeconds), true)}
       </div>
       <div style="margin-top:0.9rem">${splitMarkup(s.split)}</div>
       ${statsChartMarkup(s.buckets)}`;
  return `
    <div class="detail-section">
      <h3>Statistik</h3>
      <div class="view-toggle" id="ev-range" role="tablist" aria-label="Zeitraum">${chips}</div>
      <div style="margin-top:0.8rem">${body}</div>
    </div>`;
}

function evHistoryMarkup() {
  const list = evSessions?.sessions ?? [];
  if (list.length === 0) {
    return `<div class="detail-section"><h3>Letzte Ladevorgänge</h3>
      <p class="session-empty">Noch keine abgeschlossenen Ladevorgänge aufgezeichnet. Sobald das Fahrzeug angesteckt und geladen wird, erscheint hier automatisch ein Eintrag.</p></div>`;
  }
  const rows = list.map((s) => {
    const d = new Date(s.startedAt);
    const times = `${formatClock(s.startedAt)} – ${s.endedAt ? formatClock(s.endedAt) : 'läuft'} · ${formatDuration(s.chargingSeconds)}`;
    const open = evOpenSessionId === s.id;
    return `
      <button class="session-row" type="button" data-session="${esc(s.id)}" aria-expanded="${open}">
        <span class="session-when">
          <span class="session-date">${esc(d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }))}</span>
          <span class="session-time">${esc(times)}</span>
        </span>
        <span class="session-energy">${esc(formatEnergy(s.energyWh))}</span>
      </button>
      ${open ? `<div class="session-detail">${splitMarkup(s.split)}${s.hasGaps ? `<p class="card-more">Teilweise ohne Messwerte — als „nicht zuordenbar“ ausgewiesen.</p>` : ''}</div>` : ''}`;
  }).join('');
  return `<div class="detail-section"><h3>Letzte Ladevorgänge</h3><div class="session-list">${rows}</div></div>`;
}

function renderEvDetail() {
  const body = el('ev-detail-body');
  if (!body || el('ev-detail').hidden) return;
  const ev = lastLive?.ev ?? { state: 'not-connected', configured: false };
  const currentOrLast = evSessions?.current ?? (evSessions?.sessions ?? [])[0] ?? null;
  body.innerHTML =
    evLiveMarkup(ev) +
    (currentOrLast
      ? sessionMarkup(currentOrLast, evSessions?.current ? 'Laufender Ladevorgang' : 'Letzter Ladevorgang')
      : '') +
    evStatsMarkup() +
    evHistoryMarkup();

  // Zeitraum-Umschalter
  body.querySelectorAll('#ev-range .vt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      evStatsRange = btn.getAttribute('data-range');
      loadEvStats().then(renderEvDetail);
    });
  });
  // Ladevorgang auf-/zuklappen
  body.querySelectorAll('.session-row[data-session]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.getAttribute('data-session');
      evOpenSessionId = evOpenSessionId === id ? null : id;
      renderEvDetail();
    });
  });
}

async function loadEvSessions() {
  try {
    evSessions = await (await fetch('/api/ev/sessions?limit=50')).json();
  } catch (err) { console.error(err); evSessions = { current: null, sessions: [] }; }
}
async function loadEvStats() {
  try {
    evStats = await (await fetch(`/api/ev/stats?range=${encodeURIComponent(evStatsRange)}&date=${todayStr()}`)).json();
  } catch (err) { console.error(err); evStats = null; }
}

function openEvDetail() {
  el('ev-detail').hidden = false;
  document.body.style.overflow = 'hidden';
  renderEvDetail();
  Promise.all([loadEvSessions(), loadEvStats()]).then(renderEvDetail);
}
function closeEvDetail() {
  el('ev-detail').hidden = true;
  document.body.style.overflow = '';
}

/** Verbindet die Datenquelle neu — startet KEINEN Ladevorgang. */
async function evConnect(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Verbinde …'; }
  try {
    await fetch('/api/devices/ev-charger/reconnect', { method: 'POST' });
  } catch (err) { console.error('Verbinden fehlgeschlagen', err); }
  if (btn) btn.disabled = false;
}

// ── Mobile-Navigation ─────────────────────────────────────────────────
/**
 * Springt zu den bereits vorhandenen Abschnitten und hebt den sichtbaren
 * hervor. Bewusst keine Routen, keine neuen Seiten, keine Zustandslogik —
 * die Seite bleibt genau eine Seite, nur besser mit dem Daumen erreichbar.
 */
function setupTabbar() {
  const bar = el('tabbar');
  if (!bar) return;
  const buttons = [...bar.querySelectorAll('button[data-target]')];
  const sections = buttons
    .map((b) => el(b.getAttribute('data-target')))
    .filter(Boolean);

  buttons.forEach((btn, index) => {
    btn.addEventListener('click', () => {
      const target = el(btn.getAttribute('data-target'));
      if (!target) return;
      // Der erste Abschnitt bedeutet "ganz nach oben" — sonst bliebe ein Rest
      // stehen und die Seite wirkt, als hätte sie nicht reagiert.
      if (index === 0) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      // Versatz aus der TATSÄCHLICHEN Höhe der klebenden Kopfzeile berechnen
      // (sie ändert sich mit Schriftgrösse und Safe-Area), plus etwas Luft —
      // sonst klebt die Überschrift unsichtbar unter der Leiste.
      const bar = document.querySelector('.topbar');
      const barHeight = bar ? bar.getBoundingClientRect().height : 64;
      const top =
        target.getBoundingClientRect().top + window.scrollY - barHeight - 14;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    });
  });

  // Aktiven Reiter am tatsächlich sichtbaren Abschnitt ausrichten.
  if (!('IntersectionObserver' in window) || sections.length === 0) return;
  const visible = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) visible.set(entry.target.id, entry.intersectionRatio);
      let bestId = null, best = 0;
      for (const [id, ratio] of visible) if (ratio > best) { best = ratio; bestId = id; }
      if (bestId === null) return;
      for (const btn of buttons) {
        btn.classList.toggle('active', btn.getAttribute('data-target') === bestId);
      }
    },
    { rootMargin: '-72px 0px -55% 0px', threshold: [0, 0.15, 0.4, 0.75, 1] },
  );
  for (const section of sections) observer.observe(section);
}

// ── Einstellungen ─────────────────────────────────────────────────────
/**
 * Sammelt alle Vorlieben an einer Stelle, damit die Oberfläche selbst frei von
 * Schaltern bleibt. Alles hier ist reine Darstellung — ausser den Tarifen, die
 * über die bestehende Schnittstelle gespeichert werden.
 */
let tariffCache = null;

/** Ein Auswahlblock: Überschrift, Erklärung, Segmentschalter. */
function settingRow(title, hint, name, options, activeValue) {
  const buttons = options
    .map(([value, label]) =>
      `<button class="vt-btn ${value === activeValue ? 'active' : ''}" type="button"
               data-setting="${esc(name)}" data-value="${esc(value)}">${esc(label)}</button>`)
    .join('');
  return `
    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-title">${esc(title)}</span>
        ${hint ? `<span class="setting-hint">${esc(hint)}</span>` : ''}
      </div>
      <div class="view-toggle setting-toggle">${buttons}</div>
    </div>`;
}

function renderSettings() {
  const body = el('settings-body');
  if (!body) return;
  const t = tariffCache;
  body.innerHTML = `
    <div class="detail-section">
      <h3>Darstellung</h3>
      ${settingRow('Farbmodus', 'Automatisch folgt der Einstellung des Geräts.',
        'theme', THEME_MODES, currentThemeMode())}
      ${settingRow('Zahlen im Energiefluss', 'Grössere Werte — gut lesbar aus Entfernung.',
        'flowzoom', FLOW_SCALES.map((s, i) => [String(i), s.label]), String(flowScaleIndex))}
    </div>

    <div class="detail-section">
      <h3>Live-Energiefluss</h3>
      ${settingRow('Ansicht', 'Diagramm zeigt die Verbindungen, Haus zeigt die Anlage im Bild.',
        'flowview', FLOW_VIEWS, flowView)}
    </div>

    <div class="detail-section">
      <h3>Stromtarife</h3>
      <p class="setting-hint" style="margin:0 0 0.7rem">Grundlage für die Kosten- und Ersparnisanzeige.</p>
      <div class="detail-grid">
        <label class="detail-tile">
          <span class="dt-label">Bezugspreis (€/kWh)</span>
          <input class="setting-input" id="tariff-import" type="number" step="0.001" min="0"
                 inputmode="decimal" value="${t ? t.importPricePerKWh : ''}" />
        </label>
        <label class="detail-tile">
          <span class="dt-label">Einspeisung (€/kWh)</span>
          <input class="setting-input" id="tariff-export" type="number" step="0.001" min="0"
                 inputmode="decimal" value="${t ? t.exportPricePerKWh : ''}" />
        </label>
      </div>
      <div class="setting-actions">
        <button class="btn-primary" id="tariff-save" type="button">Tarife speichern</button>
        <span class="setting-hint" id="tariff-status"></span>
      </div>
    </div>

    <div class="detail-section">
      <h3>Über</h3>
      <p class="setting-hint" style="margin:0">
        SmartHome · Daten lokal aus Fronius und Victron, Ladegerät über Tuya (nur lesend).
        Die Einstellungen gelten nur auf diesem Gerät.
      </p>
    </div>`;

  // Segmentschalter
  body.querySelectorAll('[data-setting]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-setting');
      const value = btn.getAttribute('data-value');
      if (name === 'theme') {
        applyTheme(value);
      } else if (name === 'flowzoom') {
        flowScaleIndex = Number(value);
        localStorage.setItem('energie-flow-scale', String(flowScaleIndex));
        applyFlowZoom();
      } else if (name === 'flowview') {
        flowView = value;
        localStorage.setItem('energie-flow-view', value);
        applyFlowView();
      }
      renderSettings();
    });
  });

  // Tarife speichern
  const save = el('tariff-save');
  if (save) {
    save.addEventListener('click', async () => {
      const imp = Number(el('tariff-import').value);
      const exp = Number(el('tariff-export').value);
      const status = el('tariff-status');
      if (!Number.isFinite(imp) || !Number.isFinite(exp) || imp < 0 || exp < 0) {
        status.textContent = 'Bitte gültige Preise eingeben.';
        return;
      }
      save.disabled = true;
      status.textContent = 'Wird gespeichert …';
      try {
        const resp = await fetch('/api/tariff', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ importPricePerKWh: imp, exportPricePerKWh: exp }),
        });
        tariffCache = await resp.json();
        status.textContent = 'Gespeichert.';
        // Kosten mit dem neuen Tarif neu berechnen lassen.
        await loadDay(selectedDate);
      } catch (err) {
        console.error(err);
        status.textContent = 'Speichern fehlgeschlagen.';
      } finally {
        save.disabled = false;
      }
    });
  }
}

function openSettings() {
  el('settings').hidden = false;
  document.body.style.overflow = 'hidden';
  renderSettings();
  // Tarife nachladen und Anzeige auffrischen.
  fetch('/api/tariff')
    .then((r) => r.json())
    .then((t) => { tariffCache = t; renderSettings(); })
    .catch(() => undefined);
}
function closeSettings() {
  el('settings').hidden = true;
  document.body.style.overflow = '';
}

function setupSettings() {
  el('settings-btn').addEventListener('click', openSettings);
  el('settings-close').addEventListener('click', closeSettings);
  el('settings').addEventListener('click', (e) => {
    if (e.target === el('settings')) closeSettings();
  });
}

// ── Schriftgrösse im Energiefluss umschalten ──────────────────────────
/**
 * Normal / Groß / Sehr groß, dauerhaft gemerkt. Betrifft ausschliesslich die
 * Darstellung im Energiefluss — an den Werten selbst ändert sich nichts.
 *
 * Gewählt wird sie in den Einstellungen. In der Live-Ansicht selbst steht dafür
 * bewusst keine Taste: Dort soll nur die Anlage zu sehen sein.
 */
function applyFlowZoom() {
  const step = FLOW_SCALES[flowScaleIndex];
  const svg = el('flow-svg');
  // Namen und Zusatzzeilen wachsen gedämpfter als die Zahlen mit, damit
  // benachbarte Beschriftungen nicht zusammenstossen.
  if (svg) {
    svg.style.setProperty('--flow-name-scale', (1 + (step.value - 1) * 0.45).toFixed(3));
    svg.style.setProperty('--flow-sub-scale', (1 + (step.value - 1) * 0.6).toFixed(3));
  }
  // Dieselbe Einstellung wirkt auch in der Hausansicht — eine Wahl, beide Bilder.
  // Die Schilder wachsen leicht gedämpft mit: Sie sitzen auf festen Punkten
  // rund um das Haus, bei voller Vergrösserung stiessen sie sonst aneinander.
  const scene = el('scene-view');
  if (scene) scene.style.setProperty('--sc-chip-scale', chipScale().toFixed(3));
  // Am Telefon wachsen die Bänder mit der Schrift — deshalb braucht die Szene
  // dann auch mehr Rand. ensureScene baut sie mit der passenden viewBox neu.
  ensureScene();
  // Knoten einmal neu aufbauen, damit die neue Grösse greift.
  for (const key of Object.keys(_nodeSig)) delete _nodeSig[key];
  if (lastLive) renderFlow(lastLive);
}

// ── Init ──────────────────────────────────────────────────────────────
function init() {
  initTheme();
  renderSkeletons();
  applyFlowLayout(pickFlowLayout());
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const next = pickFlowLayout();
      const changed = next !== currentLayout;
      if (changed) applyFlowLayout(next);
      // Die Hausansicht hat eine eigene Bildschirmklasse (schmal/breit) —
      // ensureScene baut nur um, wenn sie tatsächlich wechselt.
      ensureScene();
      if (lastLive && (changed || flowView === 'house')) renderFlow(lastLive);
    }, 200);
  });
  el('status-chip').addEventListener('click', () => {
    const panel = el('source-panel');
    const open = panel.hidden;
    panel.hidden = !open;
    el('status-chip').setAttribute('aria-expanded', String(open));
  });

  // Datumsnavigation
  selectedDate = todayStr();
  el('date-prev').addEventListener('click', () => loadDay(shiftDateStr(selectedDate, -1)));
  el('date-next').addEventListener('click', () => { if (selectedDate < todayStr()) loadDay(shiftDateStr(selectedDate, 1)); });
  el('date-input').addEventListener('change', (e) => { if (e.target.value) loadDay(e.target.value); });
  document.querySelectorAll('.quick-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      loadDay(chip.getAttribute('data-day') === 'today' ? todayStr() : shiftDateStr(todayStr(), -1));
    });
  });
  // Ansichts-Umschalter Leistung / Batteriestand
  el('view-toggle').querySelectorAll('.vt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      chartView = btn.getAttribute('data-view');
      el('view-toggle').querySelectorAll('.vt-btn').forEach((b) => b.classList.toggle('active', b === btn));
      hoverIndex = null;
      buildLegend(); renderChart();
    });
  });
  setupChartHover();
  setupTabbar();
  applyFlowZoom();
  setupSettings();
  applyFlowView();

  // Detailansicht schliessen: Knopf, Klick auf den Hintergrund, Escape.
  el('ev-detail-close').addEventListener('click', closeEvDetail);
  el('ev-detail').addEventListener('click', (e) => {
    if (e.target === el('ev-detail')) closeEvDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el('ev-detail').hidden) closeEvDetail();
    else if (!el('settings').hidden) closeSettings();
  });

  // Chart bei Größenänderung neu zeichnen (responsives Pixel-Layout).
  let chartResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(() => renderChart(), 180);
  });

  connectSSE();
  // refreshTodayKpis() lädt für „heute" bereits den vollständigen Tag (via
  // loadDay) — daher kein separater loadDay-Aufruf beim Start (vermeidet
  // doppelte Requests auf dieselben Tagesdaten).
  refreshTodayKpis();
  setInterval(refreshTodayKpis, 30000);

  // PWA: Service Worker erst nach dem Laden registrieren, damit er den ersten
  // Render nicht ausbremst. Fehlschläge (z. B. in eingebetteten Browsern ohne
  // SW-Unterstützung) sind unkritisch — die App funktioniert auch ohne.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}
init();
