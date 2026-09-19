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
  formatLadestrom, formatLadeleistung, dosenText, umsteckText,
} from './format.js';
import { buildScene, fitScene, createSkyGate, sceneViewBox, pickSceneLayout } from './scene.js';
import { befehlsfolge, bindeLadestromBestaetigung, ladezustand, sendeLadebefehl } from './ev-bedienung.js';
import { ApiFehler, holeJson, istUeberholt, letzteAnfrage } from './api.js';
import { pruefeTarif, TARIF_GRENZEN } from './tarif-regeln.js';

// ── Abgelaufene Sitzung ───────────────────────────────────────────────
/**
 * Läuft die Sitzung ab, antwortet der Server auf jede Schnittstelle mit 401.
 * Ohne Behandlung sähe das aus wie eine kaputte App: Kacheln ohne Werte, keine
 * Fehlermeldung.
 *
 * Statt jeden der rund zwölf fetch-Aufrufe einzeln zu prüfen — und den
 * dreizehnten künftig zu vergessen — wird fetch einmal umschlossen. Eine
 * Stelle, die alle abdeckt, auch die, die es noch nicht gibt.
 */
function zurAnmeldung() {
  const ziel = encodeURIComponent(location.pathname + location.search);
  location.replace(`/login?redirect=${ziel}`);
}

const echtesFetch = window.fetch.bind(window);
let leiteWeiter = false;
window.fetch = async (...args) => {
  const antwort = await echtesFetch(...args);
  // replace() wirkt nicht sofort; ohne die Sperre würde jeder noch laufende
  // Aufruf die Weiterleitung erneut auslösen.
  if (antwort.status === 401 && !leiteWeiter) {
    leiteWeiter = true;
    zurAnmeldung();
  }
  return antwort;
};

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

/**
 * Die kleine graue Zeile unter dem Hausverbrauch in der Hausansicht.
 *
 * Der grosse Wert bleibt der Hausverbrauch, wie ihn der Zähler misst — mit
 * allem, was hinter ihm hängt, also auch mit der Wallbox. Das ist die Zahl, die
 * zur Bilanz passt und mit der man rechnen kann.
 *
 * Nur: Während das Auto lädt, sagt sie über das HAUS nichts mehr aus. Sie
 * springt von 1,5 auf 11,5 kW, obwohl drinnen nichts anders läuft, und das Auto
 * steht im Bild dann doppelt — einmal als eigenes Gerät und einmal im Haus.
 * Deshalb steht der Wert ohne Auto klein darunter, statt den grossen zu
 * ersetzen: zwei Zahlen, die beide stimmen, jede in ihrer Bedeutung.
 *
 * Lädt gerade nichts, sind beide gleich — dann steht dort wie eh und je
 * "Verbrauch", und die Zeile bleibt ruhig.
 */
function hausNotiz(d) {
  const h = d?.hausOhneAuto;
  const auto = h?.autoAbgezogenW;
  if (h?.valueW == null || auto == null || auto <= FLOW_MIN_W) return 'gesamt inkl. Auto';
  // Eine Schätzung aus der Grundlast trägt ihr Zeichen.
  return (h.art === 'geschaetzt' ? '≈ ' : '') + formatPower(h.valueW) + ' ohne Auto';
}

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
  setF(svg, 'sc-grid', formatPower(netzfluss(d).w));
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
  setSceneNote(svg, 'sc-house', hausNotiz(d));
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
  renderNode('node-house', 'home', formatPower(house), 'Haus', 'gesamt inkl. Auto', 'below', cssVar('--house'), L.house.r);
  const gridSub = netzfluss(d).wort;
  renderNode('node-grid', 'grid', formatPower(netzfluss(d).w), 'Stromnetz', gridSub, L.nodes.grid.pos, cssVar('--grid'), L.nodes.grid.r);
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
/**
 * Netzfluss als Wort und Zahl.
 *
 * Bei 0 W heisst es "Ausgeglichen" — "0 W Bezug" behauptete eine Richtung, die
 * es nicht gibt. Unbekannt bleibt unbekannt.
 */
function netzfluss(d) {
  const gi = d.gridImport?.valueW, ge = d.gridExport?.valueW;
  if (gi == null || ge == null) return { w: null, wort: 'unbekannt' };
  if (ge > gi && ge >= 1) return { w: ge, wort: 'Einspeisung' };
  if (gi >= 1) return { w: gi, wort: 'Bezug' };
  return { w: 0, wort: 'Ausgeglichen' };
}

function renderKpis(d, today) {
  const agg = d.storageAggregate;
  const net = agg?.netPowerW ?? null;
  const netz = netzfluss(d);
  const pvP = formatPowerParts(d.solar.valueW);
  const houseP = formatPowerParts(d.house.valueW);
  const batP = formatPowerParts(net === null ? null : Math.abs(net));
  const gridP = formatPowerParts(netz.w);
  const aut = quoteTeile(today?.derived?.autarkyPercent, today?.derived?.autarkyStatus);
  const sc = quoteTeile(today?.derived?.selfConsumptionPercent, today?.derived?.selfConsumptionStatus);
  const batSub = net === null
    ? (agg && agg.verfuegbar < agg.erwartet ? `${agg.verfuegbar} von ${agg.erwartet} erreichbar` : 'unbekannt')
    : net > 40 ? 'lädt' : net < -40 ? 'entlädt' : 'bereit';
  el('kpi-strip').innerHTML =
    kpiTile('PV jetzt', pvP.value, pvP.unit, 'solar') +
    kpiTile('Haus gesamt', houseP.value, houseP.unit, 'house', 'inkl. Auto') +
    kpiTile('Speicher', batP.value, batP.unit, 'battery', batSub) +
    kpiTile('Netz', gridP.value, gridP.unit, 'grid', netz.wort) +
    kpiTile('Autarkie heute', aut.value, aut.unit, 'battery', aut.hinweis, 'Anteil des Verbrauchs, der nicht aus dem Netz kam.') +
    kpiTile('Eigenverbrauch', sc.value, sc.unit, 'solar', sc.hinweis, 'Anteil des Solarstroms, der nicht eingespeist wurde.');
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
  // Die Summenkarte gibt es, sobald mehr als ein Speicher erwartet wird — auch
  // wenn einer fehlt. Dann sagt sie genau das, statt still zu verschwinden.
  const hasAgg = !!(agg && agg.erwartet > 1);
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
      <div class="card-head">${cardIconImg('home')}<h3>Haus gesamt inkl. Auto</h3></div>
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
          <div class="breakdown-row"><span data-f="agg-stored-label">Gespeichert</span><b data-f="agg-stored"></b></div>
          <div class="breakdown-row"><span data-f="agg-cap-label">Kapazität</span><b data-f="agg-cap"></b></div>
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
        <div class="breakdown-row"><span>Lädt gerade mit</span><b data-f="ev-power">—</b></div>
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
  if (agg && agg.erwartet > 1) {
    // Unvollständig: kein Gesamt-SOC, sondern wie viele Speicher erreichbar
    // sind. Die bekannten Werte stehen als Teilmenge da, nicht als Gesamt.
    const aggSoc = agg.vollstaendig ? displayAggSoc(agg, d.batteries) : null;
    setF(root, 'agg-value', agg.vollstaendig ? formatSoc(aggSoc) : `${agg.verfuegbar} von ${agg.erwartet} erreichbar`);
    setW(root, 'agg-fill', aggSoc ?? 0);
    setF(root, 'agg-stored-label', agg.vollstaendig ? 'Gespeichert' : 'Gespeichert (nur erreichbare)');
    setF(root, 'agg-cap-label', agg.vollstaendig ? 'Kapazität' : 'Kapazität (nur erreichbare)');
    setF(root, 'agg-stored', formatEnergy(agg.energieBekanntWh));
    setF(root, 'agg-cap', formatEnergy(agg.kapazitaetBekanntWh));
    // Fusszeile wie bei den übrigen Karten — sonst endet diese Karte höher als
    // ihre Nachbarn und die Reihe bekommt keine gemeinsame Unterkante.
    const names = d.batteries.filter((b) => !b.unavailableReason).map((b) => b.displayName);
    setF(root, 'agg-meta', agg.vollstaendig
      ? `Alle Speicher: ${names.join(' + ')}`
      : `${agg.verfuegbar} von ${agg.erwartet} Speichern verfügbar; kein vollständiger Gesamtwert.`);
  }

  const netz = netzfluss(d);
  const g = formatPowerParts(netz.w);
  setF(root, 'grid-value', g.value); setF(root, 'grid-unit', g.unit);
  setF(root, 'grid-sub', netz.w === null ? 'Keine Daten' : netz.wort === 'Einspeisung' ? 'Netzeinspeisung' : netz.wort === 'Bezug' ? 'Netzbezug' : 'Ausgeglichen');
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
  // Beim Laden sagt die Unterzeile, wie viel von der eingestellten Begrenzung
  // gerade wirklich abgerufen wird — genau die Frage, die man vor der Wallbox
  // stehend hat.
  const pausiert = String(ev.regelung?.zustand ?? '').startsWith('pausiert');
  const ladeZeile =
    charging && ev.currentFromPowerA != null && ev.maxCurrentA != null
      ? `Lädt mit ca. ${Math.round(ev.currentFromPowerA)} A von max. ${ev.maxCurrentA} A`
      // Pausiert die Automatik, ist ihr Grund die nützlichste Auskunft der Karte.
      : pausiert && ev.regelung?.grund
        ? ev.regelung.grund
        : null;
  setF(root, 'ev-sub',
    ev.faultText ?? ladeZeile ?? EV_STATE_TEXT[ev.state] ?? 'Wallbox noch nicht eingerichtet');

  setF(root, 'ev-plug',
    ev.vehicleConnected === true ? 'Angeschlossen'
      : ev.vehicleConnected === false ? 'Nicht angeschlossen'
      : '—');
  // Der Ladestand kann vom Ladegerät nicht kommen (IEC 61851, kein Datenkanal).
  setF(root, 'ev-soc', ev.socPercent == null ? 'nicht verfügbar' : formatSoc(ev.socPercent));
  setF(root, 'ev-session', ev.sessionEnergyWh == null ? '—' : formatEnergy(ev.sessionEnergyWh));
  setF(root, 'ev-total', ev.totalEnergyWh == null ? '—' : formatEnergy(ev.totalEnergyWh));
  setF(root, 'ev-power', formatLadeleistung(ev));
  setF(root, 'ev-cur', formatLadestrom(ev));
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
  const hasAgg = !!(d.storageAggregate && d.storageAggregate.erwartet > 1);
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

/**
 * Kalendertag und Zeitzone der Anlage, aus dem Live-Zustand.
 *
 * "Heute" ist der Tag der Anlage, nicht der des Browsers. Wer im Urlaub in
 * einer anderen Zeitzone nachsieht, soll dieselben Tageswerte sehen wie zu
 * Hause. Bis die erste Messung da ist, gilt der Browsertag.
 */
let anlagenDatum = null;
let anlagenZeitzone = null;
function todayStr() {
  if (anlagenDatum) return anlagenDatum;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Uhrzeit in der Zeitzone der Anlage. */
function anlagenUhrzeit(ms) {
  try {
    return new Intl.DateTimeFormat('de-DE', {
      hour: '2-digit', minute: '2-digit', ...(anlagenZeitzone ? { timeZone: anlagenZeitzone } : {}),
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
}
/** Dauer in Stunden und Minuten, für Lücken. */
function formatLuecke(sekunden) {
  const min = Math.round(sekunden / 60);
  if (min < 1) return 'unter 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
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
/**
 * "Erfasst: 85 % · Datenlücke: 1 h" — wie belastbar die Tageszahlen sind.
 *
 * Ohne diese Zeile liest sich eine Summe aus zwei Messstunden genauso wie eine
 * aus vierundzwanzig. Tage von vor der Abdeckungsrechnung heissen ehrlich
 * "Abdeckung unbekannt".
 */
function abdeckungText(tag) {
  const c = tag?.coverage;
  if (!c) return '';
  if (!c.bekannt) return 'Abdeckung unbekannt (ältere Aufzeichnung)';
  const teile = [`Erfasst: ${Math.round(c.percent ?? 0)} %`];
  if (c.gapSeconds >= 60) teile.push(`Datenlücke: ${formatLuecke(c.gapSeconds)}`);
  if (c.erfasstAbMs && tag.tagBeginnMs && c.erfasstAbMs - tag.tagBeginnMs > 5 * 60_000) {
    teile.push(`Aufzeichnung seit ${anlagenUhrzeit(c.erfasstAbMs)}`);
  }
  return teile.join(' · ');
}

/** Fehlerhinweis mit Wiederholen — die bestätigten Daten bleiben daneben stehen. */
function fehlerHinweis(text) {
  return `<div class="lade-fehler" role="alert"><span>${esc(text)}</span>`
    + `<button type="button" class="btn-schlicht" data-wiederholen>Erneut laden</button></div>`;
}

/** Eine Quote — oder der Grund, warum es keine gibt. */
function quoteTeile(prozent, status) {
  if (status === 'unvollstaendig') return { value: '—', unit: '', hinweis: 'ungleich lang gemessen' };
  if (prozent == null) return { value: '—', unit: '', hinweis: '' };
  return {
    value: Math.round(prozent),
    unit: '%',
    hinweis: status === 'abdeckung-unbekannt' ? 'Abdeckung unbekannt' : '',
  };
}

function renderDaySummary() {
  const grid = el('today-grid');
  const hinweis = el('day-coverage');
  if (hinweis) hinweis.textContent = dayData?.hasData ? abdeckungText(dayData) : '';
  const fehler = dayFehler ? fehlerHinweis(dayFehler) : '';
  if (!dayData || !dayData.hasData) {
    grid.innerHTML = fehler || `<div class="day-summary-empty">Für diesen Tag liegen keine Daten vor.</div>`;
    grid.querySelector('[data-wiederholen]')?.addEventListener('click', () => loadDay(selectedDate));
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
  const aut = quoteTeile(der.autarkyPercent, der.autarkyStatus);
  const eig = quoteTeile(der.selfConsumptionPercent, der.selfConsumptionStatus);
  const nebenbei = (text) => (text ? `<span class="s-delta">${esc(text)}</span>` : '');
  let html = fehler +
    stat('inverter', 'Produktion', formatEnergyParts(t.productionWh), delta) +
    stat('home', 'Haus gesamt inkl. Auto', formatEnergyParts(t.houseConsumptionWh)) +
    stat('grid', 'Netzbezug', formatEnergyParts(t.gridImportWh)) +
    stat('grid', 'Einspeisung', formatEnergyParts(t.gridExportWh)) +
    stat('🛡️', 'Autarkie', aut, nebenbei(aut.hinweis), 'Anteil des Verbrauchs, der nicht aus dem Netz kam.') +
    stat('♻️', 'Eigenverbrauch', eig, nebenbei(eig.hinweis), 'Anteil des Solarstroms, der nicht eingespeist wurde.') +
    stat('💶', 'Gesamter Vorteil', der.costs ? { value: formatCurrency(der.costs.totalBenefitEUR).replace(' €', ''), unit: '€' } : '—',
      der.costs && !der.costs.vollstaendig ? nebenbei('unvollständig gemessen') : '');
  // Je Speicher: geladen / entladen (Anforderung 66).
  for (const b of dayData.batteries ?? []) {
    const bicon = b.deviceId && b.deviceId.includes('victron') ? 'batteryLarge' : 'batteryFronius';
    html += `<div class="stat">` +
      `<div class="stat-head">${statIcon(bicon)}<span class="s-label">${esc(b.name)}</span></div>` +
      `<span class="s-value" style="font-size:1rem">▲ ${esc(formatEnergy(b.chargeWh))}</span>` +
      `<span class="s-delta">▼ ${esc(formatEnergy(b.dischargeWh))}</span></div>`;
  }
  grid.innerHTML = html;
  grid.querySelector('[data-wiederholen]')?.addEventListener('click', () => loadDay(selectedDate));
}

// ── KOSTEN ────────────────────────────────────────────────────────────
/**
 * Kostenkarten — immer mit Tag, Tarifgrundlage und Vollständigkeit.
 *
 * Begriffe, einheitlich: "Ersparnis" ist nicht gekaufter Netzstrom,
 * "Einspeiseerlös" die Vergütung, "Gesamter Vorteil" die Summe aus beidem. Die
 * Grundgebühr steckt in keiner dieser Zahlen und wird das auch gesagt.
 */
function renderCosts(t) {
  const ziel = el('cost-grid');
  const kopf = el('cost-basis');
  if (!t?.derived?.costs) {
    ziel.innerHTML = '';
    if (kopf) kopf.textContent = '';
    return;
  }
  const c = t.derived.costs;
  const card = (cls, icon, label, big, rows) => `
    <div class="card ${cls}">
      <div class="card-head"><span class="card-icon-emoji">${icon}</span><h3>${esc(label)}</h3></div>
      <p class="value">${esc(big)}</p>
      <div class="breakdown">${rows.map((r) => `<div class="breakdown-row"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('')}</div>
    </div>`;
  ziel.innerHTML =
    card('battery', '💶', 'Gesamter Vorteil', formatCurrency(c.totalBenefitEUR),
      [['Ersparnis (nicht gekaufter Strom)', formatCurrency(c.savedGridCostEUR)], ['Einspeiseerlös', formatCurrency(c.feedInRevenueEUR)]]) +
    card('grid', '⚡', 'Netzkosten', formatCurrency(c.gridCostActualEUR),
      [['Ohne PV & Speicher', formatCurrency(c.gridCostWithoutSystemEUR)], ['Differenz', formatCurrency(c.gridCostWithoutSystemEUR - c.gridCostActualEUR)]]);

  if (kopf) {
    const tag = dayTitle(t.date);
    const tarif = c.tarif
      ? `${String(c.tarif.importPricePerKWh).replace('.', ',')} €/kWh Bezug, ${String(c.tarif.exportPricePerKWh).replace('.', ',')} €/kWh Einspeisung`
      : '';
    const teile = [
      `${tag} · Tarif: ${tarif}`,
      c.tarif?.grundlage === 'angenommen' ? 'Tarif für diesen Tag nicht bekannt, angenommen' : '',
      c.basis === 'naeherung' ? 'Näherung aus Tagessummen (ältere Aufzeichnung)' : '',
      c.vollstaendig ? '' : 'unvollständig gemessen — nur erfasste Intervalle',
      'Grundgebühr nicht enthalten',
    ].filter(Boolean);
    kopf.textContent = teile.join(' · ');
  }
}

// ── Legende ───────────────────────────────────────────────────────────
function buildLegend() {
  const hidden = hiddenByView[chartView];
  el('chart-legend').innerHTML = buildSeries().map((s) => `
    <button type="button" class="legend-item ${hidden.has(s.key) ? 'off' : ''}" aria-pressed="${!hidden.has(s.key)}" data-key="${esc(s.key)}">
      <span class="legend-swatch" style="background:${resolveColor(s.color)}"></span>${esc(s.label)}
    </button>`).join('');
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
/**
 * Tagesgrenzen — vom Server, in der Zeitzone der Anlage.
 *
 * Vorher rechnete der Browser "Mitternacht + 24 Stunden": falsch an den Tagen
 * der Zeitumstellung (23 bzw. 25 Stunden) und falsch in jeder anderen Zeitzone.
 */
function dayBounds(date) {
  if (dayData?.date === date && Number.isFinite(dayData.tagBeginnMs) && Number.isFinite(dayData.tagEndeMs)) {
    return { start: dayData.tagBeginnMs, end: dayData.tagEndeMs };
  }
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
  // Beschriftet in der Uhrzeit der Anlage. An Umstellungstagen stehen dort
  // deshalb ehrlich 00, 03, 07 … statt einer gleichmässigen, aber falschen Folge.
  const stepH = W < 560 ? 6 : 3;
  const zeitmarken = [];
  for (let t = start; t < end; t += stepH * 3600 * 1000) zeitmarken.push(t);
  // Auch 23- und 25-Stunden-Tage bekommen einen sichtbaren Endpunkt.
  if (end - zeitmarken.at(-1) < stepH * 1800_000) zeitmarken.pop();
  zeitmarken.push(end);
  for (const t of zeitmarken) {
    const xx = xOf(Math.min(t, end));
    const label = t >= end ? '24:00' : anlagenUhrzeit(t);
    out += `<line class="chart-grid-line" x1="${xx.toFixed(1)}" y1="${padT}" x2="${xx.toFixed(1)}" y2="${H - padB}" opacity="0.5" />`;
    out += `<text class="chart-axis-label" x="${xx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${label}</text>`;
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
  tip.innerHTML = `<div class="tt-time">${anlagenUhrzeit(p.t)}</div>${rows.join('')}`;
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
  const evKurz = el('ev-kurzstatus');
  if (evKurz) {
    // Dieselbe Zustandslogik wie in der Ladeansicht — eine Stelle, ein Wortlaut.
    const ev = d.ev;
    const r = ev?.regelung;
    const modus = r?.betriebsart === 'manuell' ? `Manuell ${r.manuellA} A`
      : r?.betriebsart === 'intelligent' ? 'Intelligent' : 'kein Modus gewählt';
    const z = ladezustand(r, ev);
    const leistung = Number.isFinite(ev?.powerW) && ev.powerW > 100 ? ` · ${formatPower(ev.powerW)}` : '';
    evKurz.textContent = !ev?.configured ? 'Wallbox nicht eingerichtet' : `${z.titel}${leistung} · ${modus}`;
  }
  // Tageswechsel der Anlage: Wer "heute" ansah, sieht jetzt bewusst den neuen
  // Tag. Wer einen Archivtag ausgewählt hat, bleibt dort.
  if (d.anlage?.datum && d.anlage.datum !== anlagenDatum) {
    const vorher = todayStr();
    anlagenDatum = d.anlage.datum;
    anlagenZeitzone = d.anlage.zeitzone ?? null;
    if (selectedDate === vorher && selectedDate !== anlagenDatum) void loadDay(anlagenDatum);
    else syncDateUI();
  }
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
    // Ein EventSource verrät den Statuscode nicht — eine abgelaufene Sitzung
    // sieht darin genauso aus wie ein Netzausfall. Eine gewöhnliche Anfrage
    // hinterher klärt das: Ist es die Sitzung, schickt zurAnmeldung() weiter,
    // sonst bleibt es bei „Keine Verbindung" und der EventSource versucht es
    // von selbst wieder.
    fetch('/api/snapshot').catch(() => {});
  });
}
/** Nur die jeweils letzte Tagesabfrage zählt — siehe api.js. */
const tagesAbfrage = letzteAnfrage();
const heuteAbfrage = letzteAnfrage();
/** Fehler der letzten Tagesabfrage; die bestätigten Daten bleiben daneben stehen. */
let dayFehler = null;

/** Lädt die vollständige Tagesansicht (Kurve + Zusammenfassung) für ein Datum. */
async function loadDay(date) {
  const anderesDatum = date !== selectedDate;
  selectedDate = date;
  hoverIndex = null;
  syncDateUI();
  // Eine neue Überschrift darf niemals noch die Zahlen des vorherigen Tages
  // tragen, auch nicht während einer langsamen Anfrage.
  if (anderesDatum) {
    dayData = null;
    dayFehler = null;
    renderDaySummary();
    el('today-grid').textContent = 'Tagesdaten werden geladen …';
    renderCosts(null);
    buildLegend();
    renderChart();
  }
  try {
    const daten = await tagesAbfrage(`/api/history/day?date=${encodeURIComponent(date)}`);
    if (daten.date !== date || typeof daten.hasData !== 'boolean') throw new ApiFehler('Unpassende Tagesdaten vom Server.', 200);
    dayData = daten;
    dayFehler = null;
    if (!anlagenZeitzone && dayData.zeitzone) anlagenZeitzone = dayData.zeitzone;
  } catch (err) {
    if (istUeberholt(err)) return;
    // Keine leere Historie behaupten: Beim selben Tag bleiben die zuletzt
    // bestätigten Daten stehen, bei einem anderen Tag gibt es eben keine.
    dayFehler = err instanceof ApiFehler ? err.message : 'Tagesdaten konnten nicht geladen werden.';
    if (anderesDatum || dayData?.date !== date) dayData = null;
  }
  if (dayData && date === todayStr()) lastToday = dayData; // für die KPIs oben
  renderDaySummary();
  renderCosts(dayData);
  buildLegend();
  renderChart();
  if (lastLive) { renderKpis(lastLive, lastToday); renderNow(lastLive); }
}

/** Heutige Summen für die KPI-Leiste, auch wenn ein anderer Tag betrachtet wird. */
async function refreshTodayKpis() {
  if (selectedDate === todayStr()) {
    // Heute im Blick: loadDay lädt bereits den vollständigen Tag.
    await loadDay(todayStr());
    return;
  }
  try {
    lastToday = await heuteAbfrage(`/api/history/day?date=${todayStr()}&summary=1`);
    if (lastLive) { renderKpis(lastLive, lastToday); renderNow(lastLive); }
  } catch (err) {
    if (!istUeberholt(err)) console.warn(err);
  }
}

// ── LEAPMOTOR-Detailansicht ───────────────────────────────────────────
let evSessions = null;      // { current, sessions[] }
let evRegelung = null;      // Zustand + Protokoll der Überschussregelung
let evRegelungGeholtAt = 0; // Drosselung: das Protokoll braucht keine 2-s-Frische
/**
 * Ob das Regelprotokoll aufgeklappt ist.
 *
 * Muss ausserhalb der Ansicht leben: Die Detailseite wird bei jedem Messwert neu
 * aufgebaut, also alle zwei Sekunden. Ein `<details>` ohne gemerkten Zustand
 * klappte dabei sofort wieder zu — für den Benutzer sah es aus, als liesse es
 * sich überhaupt nicht öffnen.
 */
let evProtokollOffen = false;
/**
 * Der Ampere-Wert, den der Schieberegler gerade zeigt.
 *
 * Aus demselben Grund ausserhalb der Ansicht wie `evProtokollOffen`: Die Seite
 * wird alle zwei Sekunden neu gebaut. Ohne diesen Merker spränge der Regler
 * beim Ziehen ständig auf den Serverwert zurück — man käme nie ans Ziel.
 * `null` heisst "noch nichts angefasst, nimm den Wert vom Server".
 */
let evSchieberA = null;
/** Reihenfolge der Bedienbefehle — nur die neueste Antwort ersetzt die Anzeige. */
const evBefehle = befehlsfolge();
let evBefehlFehler = '';
let evBefehlHinweis = '';
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

/**
 * Erklärt, wie aus Ampere Kilowatt werden.
 *
 * Die Wallbox lässt sich zwischen 6 und 16 A einstellen, zeigt aber nur die
 * Ampere. Ohne diese Zeile bleibt offen, was eine Änderung an der Einstellung
 * eigentlich bewirkt — und der Unterschied ist beträchtlich: Zwischen 6 und
 * 16 A liegt der Faktor knapp drei.
 */
function ampereErklaerung(ev) {
  if (!ev.configured || ev.phases == null || ev.voltageV == null) return '';
  const proAmpere = (ev.phases === 3 ? Math.sqrt(3) : 1) * ev.voltageV;
  const art = ev.phases === 3 ? 'Dreiphasig' : 'Einphasig';
  const formel = ev.phases === 3
    ? `P = √3 × ${ev.voltageV} V × I`
    : `P = ${ev.voltageV} V × I`;
  return `<p class="card-more">
    <b>Ampere in Kilowatt:</b> ${art} an ${ev.voltageV} V gilt ${formel}.
    Ein Ampere sind also rund ${formatPower(proAmpere)} —
    6 A ≈ ${formatPower(proAmpere * 6)}, 16 A ≈ ${formatPower(proAmpere * 16)}.
    Der Wert aus der Strombegrenzung ist eine Obergrenze; was tatsächlich
    fliesst, misst die Wallbox und steht oben unter „Ladeleistung“.
  </p>`;
}

/**
 * Was die Überschussregelung gerade tut — in einem Satz.
 *
 * Das ist die wichtigste Zeile der ganzen Seite: Sie beantwortet die Frage,
 * mit der man vor dem Auto steht — "warum lädt es gerade nicht?". Der Text
 * kommt aus dem Regler selbst, nicht aus einer Übersetzungstabelle hier: Nur
 * dort ist bekannt, welche Zahl den Ausschlag gegeben hat.
 */
function regelKopfMarkup(ev) {
  const r = ev.regelung;
  if (!r) return '';
  // Die Benennung steht in ev-bedienung.js und ist dort geprüft: Wunsch,
  // Befehl, Gerätemeldung und gemessener Stromfluss werden getrennt gewertet.
  const z = ladezustand(r, ev);
  const nurBeobachtet = r.modus === 'beobachten';
  return `
    <div class="ev-kopf ton-${esc(z.ton)}" role="status">
      <span class="ev-kopf-titel">${esc(z.titel)}</span>
      ${z.text ? `<span class="ev-kopf-grund">${esc(z.text)}</span>` : ''}
      ${nurBeobachtet ? `<span class="ev-kopf-hinweis">Beobachtungsmodus — die Wallbox wird noch nicht gestellt. Umschalten in config.json unter <code>ueberschussladen.modus</code>.</span>` : ''}
    </div>`;
}

/**
 * Woher der Strom fürs Auto käme — als Satz, nicht als drei Kästchen.
 *
 * Vorher standen "PV-Produktion", "Haus ohne Auto" und "Aus den Speichern" als
 * eigene Kacheln nebeneinander. Drei Zahlen, die einzeln nichts sagen: Erst
 * ihre Beziehung zueinander ergibt den Satz, den man im Kopf sowieso bildet.
 * Als Fliesstext ist er kürzer und in einem Blick gelesen.
 */
function herkunftMarkup(ev) {
  const r = ev.regelung;
  const live = lastLive ?? {};
  if (!r) return '';
  const pv = live.solar?.valueW;
  const haus = live.hausOhneAuto?.valueW;
  const teile = [];
  if (pv != null) teile.push(`${formatPower(pv)} Sonne`);
  if (haus != null) teile.push(`${formatPower(haus)} braucht das Haus`);
  if (r.speicherbeitragW > 0) teile.push(`${formatPower(r.speicherbeitragW)} könnten die Speicher`);
  if (teile.length === 0) return '';
  return `<p class="ev-herkunft">${esc(teile.join(' · '))}</p>`;
}

/**
 * Die zwei Betriebsarten — eine eindeutige Wahl, ohne Warndialog.
 *
 * Früher kam vor dem Handbetrieb jedes Mal eine Rückfrage. Jetzt ist die Wahl
 * ein Segmentschalter, und der Handbetrieb trägt dauerhaft den Hinweis "bei
 * Bedarf Netzstrom". Die Wahl gilt, bis sie geändert wird — auch nach dem
 * Abstecken und nach einem Neustart — und lässt sich ohne Auto treffen.
 */
const EV_ARTEN = [
  { id: 'intelligent', name: 'Intelligent', kurz: 'Überschuss aus Sonne und Speicher' },
  { id: 'manuell', name: 'Manuell', kurz: 'Fester Ladestrom · bei Bedarf Netzstrom' },
];

function betriebsartMarkup(ev) {
  const r = ev.regelung;
  if (!r || r.modus === 'aus') return '';
  const art = r.betriebsart ?? null;
  const minA = r.minA || 6;
  const maxA = r.maxA || 16;
  const schieber = evSchieberA ?? (r.manuellA >= minA ? r.manuellA : Math.round((minA + maxA) / 2));
  const dose = r.anschluss;
  const gestoppt = r.gestoppt === true;

  const haken = `<svg class="ev-art-haken" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const knoepfe = EV_ARTEN.map((a) => `
    <button type="button" class="ev-art${a.id === art ? ' aktiv' : ''}" data-art="${a.id}"
            aria-pressed="${a.id === art}">
      <b>${a.id === art ? haken : ''}${a.name}</b><span>${a.kurz}</span>
    </button>`).join('');

  // Die Haushaltsgrenze gilt nur an einer einphasigen Dose — nicht pauschal.
  const reglerMaxA = dose?.phasen === 1 ? Math.min(maxA, r.haushaltMaxA ?? maxA) : maxA;
  const regler = art === 'manuell'
    ? reglerMarkup(Math.min(schieber, reglerMaxA), minA, reglerMaxA, dose, schieber !== r.manuellA)
    : '';
  const geaendert = art === 'manuell' && evSchieberA !== null && evSchieberA !== r.manuellA;

  const erklaerung = art === null
    ? 'Noch kein Lademodus gewählt — bis dahin wird nicht geladen.'
    : art === 'intelligent'
      ? 'Regelziel: Netzbezug durch das Auto vermeiden. Geladen wird mit dem Überschuss aus Sonne und freigegebenen Speichern; wegen der Cloud-Verzögerung der Wallbox ist das ein Ziel, keine Garantie.'
      : `Fester Sollwert ${r.manuellA} A${dose?.phasen === 1 && r.manuellA > reglerMaxA ? ` (an dieser Dose wirksam ${reglerMaxA} A)` : ''}. Bei Bedarf wird Netzstrom verwendet.`;

  return `
    <div class="ev-betrieb${gestoppt ? ' gestoppt' : ''}">
      <div class="ev-arten" role="group" aria-label="Lademodus">${knoepfe}</div>
      ${regler}
      ${geaendert ? `<button type="button" class="btn-primary ev-bestaetigen" id="ev-ampere-bestaetigen">${esc(`${Math.min(schieber, reglerMaxA)} A übernehmen`)}</button>` : ''}
      <p class="ev-betrieb-text">${esc(erklaerung)}</p>
      ${dosenHinweis(ev)}
      ${umsteckHinweis(ev)}
      ${art === null ? '' : beendenMarkup(gestoppt)}
    </div>`;
}

/** Auf allen Eingabegeräten eine direkt erreichbare Pause-/Fortsetzen-Taste. */
function beendenMarkup(gestoppt) {
  const wort = gestoppt ? 'Laden fortsetzen' : 'Laden pausieren';
  return `<button type="button" class="ev-stopp${gestoppt ? ' an' : ''}"
    id="ev-stopp" data-an="${gestoppt}">${wort}</button>`;
}

/**
 * Der Schieberegler samt Skala.
 *
 * Jede Amperestufe bekommt ihren Strich, beschriftet werden nur so viele, wie
 * lesbar bleiben — bei elf Stufen auf einem Telefon wäre jede Zahl ein Gedränge.
 * Die eingestellte Stufe steht ohnehin gross darüber.
 *
 * Die Kilowatt daneben stammen aus dem erkannten Anschluss und nicht aus einer
 * Annahme: An der Haushaltssteckdose sind zehn Ampere 2,3 kW, an der
 * Starkstromdose 6,9 kW. Dieselbe Zahl am Regler, drei Mal so viel Leistung.
 */
function reglerMarkup(wert, minA, maxA, dose, vorschau = false) {
  const proA = dose?.wattProAmpere || 693;
  const stufen = [];
  for (let a = minA; a <= maxA; a++) {
    const anteil = maxA === minA ? 0 : ((a - minA) / (maxA - minA)) * 100;
    // Beschriftet wird der erste, der letzte und jede zweite Stufe dazwischen.
    const beschriftet = a === minA || a === maxA || (a - minA) % 2 === 0;
    stufen.push(
      `<span class="ev-stufe${beschriftet ? ' beschriftet' : ''}${a === wert ? ' aktiv' : ''}"`
      + ` style="left:${anteil.toFixed(4)}%">`
      + (beschriftet ? `<i>${a}</i>` : '')
      + '</span>',
    );
  }
  return `
    <div class="ev-regler${vorschau ? ' vorschau' : ''}">
      <div class="ev-regler-kopf">
        <span class="ev-regler-wert"><b id="ev-a-wert">${wert}</b> A</span>
        <span class="ev-regler-kw" id="ev-kw-wert">ca. ${formatPower(wert * proA)}</span>
      </div>
      <input type="range" id="ev-schieber" min="${minA}" max="${maxA}" step="1" value="${wert}"
             data-pro-a="${proA}" aria-label="Ladestrom in Ampere" />
      <div class="ev-skala">${stufen.join('')}</div>
    </div>`;
}

/** Die beiden Hinweistexte stehen in `format.js` — reine Texte, dort geprüft. */
function dosenHinweis(ev) {
  const text = dosenText(ev.regelung);
  return text === '' ? '' : `<p class="ev-hinweis">${esc(text)}</p>`;
}

function umsteckHinweis(ev) {
  const text = umsteckText(ev.regelung);
  return text === '' ? '' : `<p class="ev-hinweis warn">${esc(text)}</p>`;
}

/**
 * Live-Bereich der Detailansicht.
 *
 * Oben in einem Satz, was gerade passiert und warum; darunter die Zahlen, aus
 * denen sich das ergibt — in genau der Reihenfolge, in der man sie nachrechnet:
 * Sonne, Haus, Speicher, Netz, und was daraus für das Auto übrig bleibt.
 */
function evLiveMarkup(ev) {
  const charging = ev.state === 'charging';
  const r = ev.regelung;
  const live = lastLive ?? {};
  const netzW = (live.gridImport?.valueW ?? 0) - (live.gridExport?.valueW ?? 0);

  return `
    <div class="detail-section">
      ${regelKopfMarkup(ev)}
      <div class="detail-grid">
        ${tile('Wallbox · gemessene Leistung', formatPower(ev.wallboxPowerW), !charging, charging ? 'ok' : '')}
        ${tile('Wallbox · gemessener Strom (Phase A)', Number.isFinite(ev.stromA) ? `${ev.stromA.toLocaleString('de-DE', { maximumFractionDigits: 1 })} A` : '—', !charging)}
        ${tile('Von der Wallbox gemeldete Grenze', formatLadestrom(ev), true)}
        ${tile('Geprüfte Ladeleistung', formatLadeleistung(ev), true)}
        ${tile('Möglich wären', r ? formatPower(Math.max(0, r.verfuegbarW)) : '—', !r)}
        ${tile('Netz', netzW >= 0 ? `${formatPower(netzW)} Bezug` : `${formatPower(-netzW)} Einspeisung`, true, netzW > 100 ? 'bad' : 'ok')}
      </div>
      <p class="ev-hinweis">Tuya-Geräterückmeldung: ${esc(ev.ageLabel ?? 'keine Daten')}${ev.measuredAt ? ` · ${esc(formatClock(ev.measuredAt))}` : ''} · Qualität: ${esc(ev.quality ?? 'unbekannt')}. Neue Messwerte erscheinen automatisch; das Fahrzeug kann weniger als den Sollwert aufnehmen.</p>
      ${herkunftMarkup(ev)}
      ${betriebsartMarkup(ev)}
      ${ev.faultText ? `<p class="card-more" style="color:var(--danger)">${esc(ev.faultText)}</p>` : ''}
    </div>`;
}

/** Ein Ladevorgang als Kennzahlen-Raster. */
function sessionMarkup(s, heading) {
  const end = s.endedAt ? formatClock(s.endedAt) : 'läuft';
  // Pausenzeit ergibt sich aus der Differenz — angesteckt, aber ohne Ladefluss.
  const pauseSeconds = Math.max(0, (s.connectedSeconds ?? 0) - (s.chargingSeconds ?? 0));
  return `
    <div class="detail-section">
      <h3>${esc(heading)}</h3>
      <div class="detail-grid">
        ${tile('Zeitraum', `${formatClock(s.startedAt)} – ${end}`, false)}
        ${tile('Geladen', formatEnergy(s.energyWh))}
        ${tile('Ladezeit', formatDuration(s.chargingSeconds), true)}
        ${tile('Davon Pause', formatDuration(pauseSeconds), true)}
        ${tile('Ø Leistung', s.avgPowerW == null ? '—' : formatPower(s.avgPowerW), true)}
        ${tile('Max. Leistung', s.maxPowerW ? formatPower(s.maxPowerW) : '—', true)}
      </div>
      ${verlaufMarkup(s)}
      <h3 style="margin-top:1rem">Woher kam der Strom?</h3>
      ${splitMarkup(s.split)}
      ${s.hasGaps ? `<p class="card-more">Während dieses Ladevorgangs fehlten zeitweise Messwerte — ein Teil ist als „nicht zuordenbar“ ausgewiesen.</p>` : ''}
    </div>`;
}

/**
 * Der Leistungsverlauf innerhalb einer Session.
 *
 * Genau das, was früher als fünf getrennte Ladevorgänge in der Liste stand:
 * die Stufen. Hier gehören sie hin — in die Session, nicht daneben.
 *
 * Gestaltung, und warum so:
 *
 *   - Treppe, keine geglättete Kurve. Die Ladeleistung springt zwischen zwei
 *     Amperestufen, sie gleitet nicht. Eine weiche Linie würde etwas zeigen,
 *     das nie passiert ist.
 *   - Fläche unter der Treppe. Die Fläche IST die geladene Energie — das ist
 *     die Grösse, um die es geht, und man sieht sie so ohne Nachdenken.
 *   - Pausen als eigener Streifen statt als Loch in der Linie. Eine Lücke
 *     liest sich wie fehlende Daten; ein grauer Balken liest sich wie eine
 *     Pause, und genau das war es.
 *   - Beschriftete Achse links, Uhrzeiten unten. Ohne Bezugsgrössen ist eine
 *     Kurve nur Dekoration.
 *   - Ampere nur dort, wo sich etwas geändert hat, und nur wenn Platz ist.
 *     Zwölf Zahlen nebeneinander liest niemand.
 */
function verlaufMarkup(s) {
  const stufen = s.verlauf ?? [];
  if (stufen.length < 2) return '';

  // Eigene Maße für schmale Bildschirme. Ein 720 breites Bild auf 343 Pixel
  // gequetscht macht aus 11-Pixel-Schrift 5 Pixel — lesbar ist das nicht. Mit
  // einem kleineren Koordinatensystem bleibt die Schrift gross genug, und die
  // Breitenprüfung weiter unten lässt automatisch weniger Ampere-Marken zu.
  const schmal = typeof window !== 'undefined' && window.innerWidth < 560;
  const W = schmal ? 380 : 720;
  const H = schmal ? 215 : 210;
  const padL = schmal ? 42 : 46;
  const padR = schmal ? 8 : 14;
  const padT = 16;
  const padB = schmal ? 28 : 30;
  const innenB = W - padL - padR;
  const innenH = H - padT - padB;

  const von = new Date(s.startedAt).getTime();
  const bis = new Date(s.endedAt ?? stufen[stufen.length - 1].ab).getTime();
  const spanne = Math.max(60_000, bis - von);
  const roh = Math.max(...stufen.map((p) => p.leistungW), 1000);
  // Auf eine runde Kilowattzahl aufrunden, damit die Achse lesbare Werte trägt.
  const max = Math.ceil(roh / 1000) * 1000;

  const x = (zeit) => padL + ((zeit - von) / spanne) * innenB;
  const y = (w) => padT + innenH - (w / max) * innenH;

  // Abschnitte mit Anfang und Ende — daraus entstehen Treppe, Fläche und Pausen.
  const abschnitte = stufen.map((p, i) => ({
    von: new Date(p.ab).getTime(),
    bis: i + 1 < stufen.length ? new Date(stufen[i + 1].ab).getTime() : bis,
    leistungW: p.leistungW,
    stromA: p.stromA,
  }));

  let treppe = '';
  let flaeche = '';
  abschnitte.forEach((a, i) => {
    const x1 = x(a.von), x2 = x(a.bis), yy = y(a.leistungW);
    treppe += i === 0 ? `M ${x1.toFixed(1)} ${yy.toFixed(1)}` : ` L ${x1.toFixed(1)} ${yy.toFixed(1)}`;
    treppe += ` L ${x2.toFixed(1)} ${yy.toFixed(1)}`;
  });
  flaeche = `M ${x(von).toFixed(1)} ${y(0).toFixed(1)} `
    + abschnitte.map((a) => `L ${x(a.von).toFixed(1)} ${y(a.leistungW).toFixed(1)} L ${x(a.bis).toFixed(1)} ${y(a.leistungW).toFixed(1)}`).join(' ')
    + ` L ${x(bis).toFixed(1)} ${y(0).toFixed(1)} Z`;

  // Pausen: Abschnitte ohne nennenswerte Leistung.
  const pausen = abschnitte
    .filter((a) => a.leistungW < 200 && a.bis > a.von)
    .map((a) => `<rect class="vl-pause" x="${x(a.von).toFixed(1)}" y="${padT}" `
      + `width="${Math.max(1, x(a.bis) - x(a.von)).toFixed(1)}" height="${innenH}" />`)
    .join('');

  // Waagrechte Hilfslinien mit Beschriftung.
  const linien = [0, 0.5, 1]
    .map((anteil) => {
      const w = max * anteil;
      const yy = y(w);
      const text = schmal && w >= 1000 ? `${Math.round(w / 1000)} kW` : formatPower(w);
      return `<line class="vl-raster" x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" />`
        + `<text class="vl-achse" x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${esc(text)}</text>`;
    })
    .join('');

  // Uhrzeiten unten: Anfang, Mitte, Ende.
  const zeiten = [0, 0.5, 1]
    .map((anteil) => {
      const t = von + spanne * anteil;
      const anker = anteil === 0 ? 'start' : anteil === 1 ? 'end' : 'middle';
      return `<text class="vl-achse" x="${x(t).toFixed(1)}" y="${H - 10}" text-anchor="${anker}">${esc(formatClock(new Date(t)))}</text>`;
    })
    .join('');

  // Ampere-Wechsel beschriften — aber nur, wo der Abschnitt breit genug ist.
  const marken = abschnitte
    .map((a, i) => {
      if (a.stromA == null || a.leistungW < 200) return '';
      if (i > 0 && abschnitte[i - 1].stromA === a.stromA) return '';
      const breite = x(a.bis) - x(a.von);
      if (breite < 34) return '';
      const mx = x(a.von) + breite / 2;
      return `<text class="vl-ampere" x="${mx.toFixed(1)}" y="${(y(a.leistungW) - 6).toFixed(1)}" text-anchor="middle">${a.stromA} A</text>`;
    })
    .join('');

  const wechsel = abschnitte.filter((a, i) => i > 0 && a.stromA !== abschnitte[i - 1].stromA).length;
  // Zusammenhängende Nullabschnitte sind EINE Pause. Sie einzeln zu zählen
  // stünde im Widerspruch zum Bild, das nur einen grauen Streifen zeigt — und
  // wäre genau die Kleinteiligkeit, die aus der Ansicht verschwinden sollte.
  const pausenZahl = abschnitte.filter(
    (a, i) => a.leistungW < 200 && !(i > 0 && abschnitte[i - 1].leistungW < 200),
  ).length;
  const beschreibung = `Ladeleistung von ${formatClock(s.startedAt)} bis ${formatClock(bis)}, `
    + `Spitze ${formatPower(roh)}, ${wechsel} Änderungen des Ladestroms, ${pausenZahl} Pausen.`;

  return `
    <div class="ev-verlauf">
      <svg viewBox="0 0 ${W} ${H}" style="aspect-ratio:${W}/${H}"
           role="img" aria-label="${esc(beschreibung)}">
        ${pausen}
        ${linien}
        <path class="vl-flaeche" d="${flaeche}" />
        <path class="vl-linie" d="${treppe}" />
        ${marken}
        ${zeiten}
      </svg>
      <p class="vl-legende">
        <span><i class="vl-punkt laden"></i>${esc(formatPower(roh))} Spitze</span>
        ${pausenZahl > 0 ? `<span><i class="vl-punkt pause"></i>${pausenZahl} Pause${pausenZahl === 1 ? '' : 'n'}</span>` : ''}
        <span>${wechsel} Mal Ladestrom angepasst</span>
        <span class="vl-hinweis">alles ein Ladevorgang</span>
      </p>
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
    .map(([key, label]) => `<button class="vt-btn ${evStatsRange === key ? 'active' : ''}" type="button" role="tab" aria-selected="${evStatsRange === key}" data-range="${key}">${label}</button>`)
    .join('');
  const s = evStats;
  // Bei einem Fehler bleiben die zuletzt bestätigten Zahlen stehen, mit Hinweis.
  const fehler = evStatsFehler
    ? `<p class="notice" role="alert">${esc(evStatsFehler)} <button type="button" class="btn-schlicht" id="ev-stats-wiederholen">Erneut laden</button></p>`
    : '';
  const body = s === null
    ? (fehler || `<p class="session-empty">Wird geladen …</p>`)
    : `${fehler}${s.range !== evStatsRange ? '<p class="session-empty">Zeitraum wird geladen …</p>' : ''}
       <div class="detail-grid">
         ${tile('Geladen', formatEnergy(s.energyWh))}
         ${tile('Ladevorgänge', String(s.sessionCount), true)}
         ${tile('Ladedauer', formatDuration(s.chargingSeconds), true)}
       </div>
       <div style="margin-top:0.9rem">${splitMarkup(s.split)}</div>
       ${s.naeherungWh > 0 ? `<p class="card-more">${esc(formatEnergy(s.naeherungWh))} stammen aus älteren Ladevorgängen ohne Tagesaufteilung und sind ihrem Starttag zugerechnet (Näherung).</p>` : ''}
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
    const dauer = formatDuration(s.chargingSeconds);
    const schnitt = s.avgPowerW == null ? null : formatPower(s.avgPowerW);
    const times = `${formatClock(s.startedAt)} – ${s.endedAt ? formatClock(s.endedAt) : 'läuft'} · ${dauer}${schnitt ? ` · Ø ${schnitt}` : ''}`;
    const open = evOpenSessionId === s.id;
    return `
      <button class="session-row" type="button" data-session="${esc(s.id)}" aria-expanded="${open}">
        <span class="session-when">
          <span class="session-date">${esc(d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }))}</span>
          <span class="session-time">${esc(times)}</span>
        </span>
        <span class="session-energy">${esc(formatEnergy(s.energyWh))}</span>
      </button>
      ${open ? `<div class="session-detail">
          ${verlaufMarkup(s)}
          ${splitMarkup(s.split)}
          ${s.hasGaps ? `<p class="card-more">Teilweise ohne Messwerte — als „nicht zuordenbar“ ausgewiesen.</p>` : ''}
        </div>` : ''}`;
  }).join('');
  return `<div class="detail-section">
      <h3>Ladevorgänge</h3>
      <p class="card-more" style="margin:0 0 0.7rem">
        Eine Zeile ist ein zusammenhängender Ladevorgang — vom Anstecken bis zum
        Abstecken. Leistungswechsel und automatische Pausen stecken darin;
        antippen zeigt den Verlauf.
      </p>
      <div class="session-list">${rows}</div>
    </div>`;
}

/**
 * Das Regelprotokoll — was die Automatik entschieden hat und warum.
 *
 * Bewusst ganz unten und eingeklappt: Im Alltag will man es nicht sehen. Wenn
 * das Auto aber nicht lädt, obwohl die Sonne scheint, steht hier die Antwort.
 */
function regelProtokollMarkup() {
  const r = evRegelung;
  if (!r || r.modus === 'aus') return '';
  const zeilen = (r.protokoll ?? []).slice(0, 40).map((p) => `
    <tr>
      <td>${esc(formatClock(p.zeit))}</td>
      <td>${esc(formatPower(p.pvW))}</td>
      <td>${esc(formatPower(p.hausOhneAutoW))}</td>
      <td>${esc(formatPower(p.netzW))}</td>
      <td>${esc(formatPower(p.verfuegbarW))}</td>
      <td>${p.wunschA === 0 ? 'Pause' : `${p.wunschA} A`}</td>
      <td>${p.gesendet ? '✓' : ''}</td>
      <td class="regel-grund">${esc(p.fehler ?? p.grund)}</td>
    </tr>`).join('');

  return `
    <div class="detail-section">
      <details id="regel-details"${evProtokollOffen ? ' open' : ''}>
        <summary><span class="regel-titel">Regelprotokoll</span></summary>
        <p class="card-more">
          Alle ${esc(String(r.naechsteRegelungInS))} s bis zur nächsten Prüfung.
          Gesetzt: ${r.gesetztA === 0 ? 'Pause' : `${esc(String(r.gesetztA))} A`},
          zulässig ${esc(String(r.minA))}–${esc(String(r.maxA))} A.
          ${r.letzterFehler ? `<span style="color:var(--danger)">Letzter Fehler: ${esc(r.letzterFehler)}</span>` : ''}
        </p>
        <div class="regel-tabelle">
          <table>
            <thead><tr>
              <th>Zeit</th><th>PV</th><th>Haus</th><th>Netz</th>
              <th>Verfügbar</th><th>Ziel</th><th>Gesendet</th><th>Grund</th>
            </tr></thead>
            <tbody>${zeilen || '<tr><td colspan="8">Noch keine Regelschritte.</td></tr>'}</tbody>
          </table>
        </div>
      </details>
    </div>`;
}

// Erhalte DOM-Knoten beim Messwertwechsel: Fokus, Pointer-Capture und native
// Eingaben dürfen nicht durch innerHTML verloren gehen.
function aktualisiereDialogDom(ziel, vorlage) {
  const schluessel = (knoten) => knoten.nodeType !== 1 ? knoten.nodeName
    : `${knoten.tagName}:${knoten.id || knoten.getAttribute('data-art')
      || knoten.getAttribute('data-session') || knoten.getAttribute('data-range')
      || knoten.classList[0] || ''}`;
  let alt = ziel.firstChild;
  for (const neu of [...vorlage.childNodes]) {
    if (alt && schluessel(alt) !== schluessel(neu)) {
      let passend = alt.nextSibling;
      while (passend && schluessel(passend) !== schluessel(neu)) passend = passend.nextSibling;
      if (passend) {
        while (alt !== passend) {
          const weiter = alt.nextSibling;
          alt.remove();
          alt = weiter;
        }
      }
    }
    if (!alt || schluessel(alt) !== schluessel(neu)) {
      const ersatz = neu.cloneNode(true);
      ziel.insertBefore(ersatz, alt);
      continue;
    }
    if (alt.nodeType === 1) {
      for (const attribut of [...alt.attributes]) {
        if (!neu.hasAttribute(attribut.name)) alt.removeAttribute(attribut.name);
      }
      for (const attribut of [...neu.attributes]) {
        if (alt.getAttribute(attribut.name) !== attribut.value) alt.setAttribute(attribut.name, attribut.value);
      }
      // Der aktuelle Reglerwert gehört während der Bedienung dem Benutzer.
      if (alt.tagName === 'INPUT' && document.activeElement !== alt) alt.value = neu.value;
      aktualisiereDialogDom(alt, neu);
    } else if (alt.nodeValue !== neu.nodeValue) alt.nodeValue = neu.nodeValue;
    alt = alt.nextSibling;
  }
  while (alt) {
    const weiter = alt.nextSibling;
    alt.remove();
    alt = weiter;
  }
}

let evBedienungListener = null;
function renderEvDetail() {
  const body = el('ev-detail-body');
  if (!body || el('ev-detail').hidden) return;
  // Auch bei neu eingefügten Meldungen bleibt die Leseposition erhalten.
  const scrollVorher = body.scrollTop;
  const ev = lastLive?.ev ?? { state: 'not-connected', configured: false };
  const currentOrLast = evSessions?.current ?? (evSessions?.sessions ?? [])[0] ?? null;
  const vorlage = document.createElement('template');
  vorlage.innerHTML =
    evLiveMarkup(ev) +
    (evBefehlFehler ? `<p class="notice" role="alert">${esc(evBefehlFehler)}</p>` : '') +
    (evBefehlHinweis ? `<p class="notice" role="status">${esc(evBefehlHinweis)}</p>` : '') +
    (evBefehle.laeuft ? '<p class="notice" role="status">Wird übernommen …</p>' : '') +
    (currentOrLast
      ? sessionMarkup(currentOrLast, evSessions?.current ? 'Laufender Ladevorgang' : 'Letzter Ladevorgang')
      : '') +
    evStatsMarkup() +
    evHistoryMarkup() +
    regelProtokollMarkup();
  aktualisiereDialogDom(body, vorlage.content);
  evBedienungListener?.abort();
  evBedienungListener = new AbortController();
  const signal = evBedienungListener.signal;
  const binde = (knoten, typ, handler) => knoten.addEventListener(typ, handler, { signal });

  // Das Protokoll alle 15 s nachladen. Der Live-Strom aktualisiert die Ansicht
  // im Sekundentakt — das Protokoll so oft zu holen wäre sinnlose Last.
  if (Date.now() - evRegelungGeholtAt > 15_000) {
    void loadEvRegelung();
  }

  if (scrollVorher > 0) body.scrollTop = scrollVorher;

  // Aufgeklappt bleibt aufgeklappt, auch über den nächsten Messwert hinaus.
  const regelDetails = body.querySelector('#regel-details');
  if (regelDetails) {
    binde(regelDetails, 'toggle', () => {
      evProtokollOffen = regelDetails.open;
    });
  }

  // Lademodus wählen — direkt, ohne Rückfrage. Der Handbetrieb übernimmt den
  // zuletzt gewählten Strom; ändern lässt er sich danach am Regler.
  body.querySelectorAll('.ev-art').forEach((knopf) => {
    binde(knopf, 'click', () => {
      const art = knopf.getAttribute('data-art');
      const jetzt = lastLive?.ev?.regelung?.betriebsart ?? null;
      if (art === jetzt) return;
      void sendeBetriebsart(art, art === 'manuell' ? evSchieberA : null);
    });
  });



  const stopp = body.querySelector('#ev-stopp');
  if (stopp) {
    binde(stopp, 'click', () => {
      void sendeStopp(stopp.getAttribute('data-an') !== 'true');
    });
  }


  // Schieberegler für den Ladestrom
  const schieber = body.querySelector('#ev-schieber');
  if (schieber) {
    // Beim Ziehen nur die Anzeige mitführen. Jeden Zwischenwert an die Wallbox
    // zu schicken hiesse: ein Dutzend Tuya-Befehle für eine Bewegung, und das
    // Fahrzeug käme dem Sollwert ohnehin nicht hinterher.
    binde(schieber, 'input', () => {
      const a = Number(schieber.value);
      evSchieberA = a;
      evBefehlHinweis = '';
      const proA = Number(schieber.getAttribute('data-pro-a')) || 693;
      const wert = body.querySelector('#ev-a-wert');
      const kw = body.querySelector('#ev-kw-wert');
      if (wert) wert.textContent = String(a);
      if (kw) kw.textContent = `ca. ${formatPower(a * proA)}`;
      body.querySelectorAll('.ev-stufe').forEach((st, i) => {
        st.classList.toggle('aktiv', i === a - Number(schieber.min));
      });
    });
    // Auch Loslassen und Pfeiltasten sind nur Vorschau. Nur der Button sendet.
    const bestaetigung = body.querySelector('#ev-ampere-bestaetigen');
    if (bestaetigung) bindeLadestromBestaetigung(bestaetigung, schieber,
      (ampere) => sendeBetriebsart('manuell', ampere), { signal });
  }

  // Zeitraum-Umschalter
  body.querySelectorAll('#ev-range .vt-btn').forEach((btn) => {
    binde(btn, 'click', () => {
      evStatsRange = btn.getAttribute('data-range');
      loadEvStats().then(renderEvDetail);
    });
  });
  const statsNochmal = body.querySelector('#ev-stats-wiederholen');
  if (statsNochmal) binde(statsNochmal, 'click', () => { loadEvStats().then(renderEvDetail); });
  // Ladevorgang auf-/zuklappen
  body.querySelectorAll('.session-row[data-session]').forEach((row) => {
    binde(row, 'click', () => {
      const id = row.getAttribute('data-session');
      evOpenSessionId = evOpenSessionId === id ? null : id;
      renderEvDetail();
    });
  });
  // Während ein Befehl unterwegs ist, ruhen Moduswahl und Regler. Die
  // Pause-Taste ausdrücklich NICHT: Ein Stopp muss jederzeit durchgehen.
  body.querySelectorAll('.ev-art, #ev-schieber, #ev-ampere-bestaetigen').forEach((x) => {
    x.disabled = evBefehle.laeuft;
  });
}

const evSitzungenAbfrage = letzteAnfrage();
const evStatsAbfrage = letzteAnfrage();
const evRegelungAbfrage = letzteAnfrage();
let evStatsFehler = '';

/** Ladevorgänge. Bei einem Fehler bleibt die zuletzt bestätigte Liste stehen. */
async function loadEvSessions() {
  try {
    evSessions = await evSitzungenAbfrage('/api/ev/sessions?limit=50');
  } catch (err) {
    if (!istUeberholt(err)) console.warn(err);
  }
}
/**
 * Betriebsart an den Server schicken und die Ansicht sofort nachziehen.
 *
 * Die kurze Wartezeit ist kein Zieren: Der Regeldienst rechnet auf den Befehl
 * hin neu und schickt seinen Tuya-Befehl hinaus. Ohne sie zeigte die Seite noch
 * den Zustand von davor, und es sähe aus, als hätte der Knopf nichts getan.
 */
/**
 * Einen Befehl absetzen und die Ansicht SOFORT nachziehen.
 *
 * Die Endpunkte antworten mit dem neuen Zustand der Regelung — genau dem
 * Objekt, das auch im Live-Strom steckt. Das wird hier direkt in `lastLive`
 * gesetzt und neu gezeichnet.
 *
 * Vorher stand hier eine Wartezeit von 800 ms und ein Nachladen des Protokolls.
 * Das war zweimal falsch: Es dauerte fast eine Sekunde, bis der gedrückte Knopf
 * reagierte, und die Antwort des Servers lag die ganze Zeit ungenutzt herum.
 *
 * Was NICHT sofort umspringt, ist die gemessene Ladeleistung — die kommt vom
 * Zähler und braucht, bis das Fahrzeug wirklich folgt. Das ist richtig so: An
 * dieser Stelle soll die App nichts behaupten, was noch nicht fliesst.
 */
async function sendeUndZeige(pfad, koerper) {
  // Ein Stopp darf auch während eines laufenden Befehls hinaus; nur die Antwort
  // auf den jeweils neuesten Befehl ersetzt danach die Anzeige.
  const nummer = evBefehle.beginne();
  evBefehlFehler = '';
  evBefehlHinweis = '';
  renderEvDetail();
  let kurz = null;
  let fehler = null;
  try {
    kurz = await sendeLadebefehl(pfad, koerper);
  } catch (err) {
    fehler = err;
  }
  const neueste = evBefehle.beende(nummer);
  if (neueste) {
    if (fehler) {
      // Die Anzeige behält den zuletzt bestätigten Zustand.
      evBefehlFehler = fehler instanceof Error ? fehler.message : 'Befehl konnte nicht bestätigt werden.';
    } else if (kurz && lastLive?.ev) {
      lastLive.ev.regelung = kurz;
      evRegelung = { ...(evRegelung ?? {}), ...kurz };
      if (koerper.art === 'manuell') {
        evSchieberA = null;
        evBefehlHinweis = `Sollwert ${kurz.manuellA ?? koerper.ampere} A gespeichert. Ob Strom fliesst, zeigt die nächste Messung.`;
      }
      void loadEvRegelung();
    }
  }
  renderEvDetail();
}

function sendeBetriebsart(art, ampere) {
  const koerper = ampere === null || ampere === undefined ? { art } : { art, ampere };
  return sendeUndZeige('/api/ev/betriebsart', koerper);
}

function sendeStopp(an) {
  return sendeUndZeige('/api/ev/stopp', { an });
}

async function loadEvRegelung() {
  evRegelungGeholtAt = Date.now();
  try {
    evRegelung = await evRegelungAbfrage('/api/ev/regelung');
  } catch (err) {
    if (!istUeberholt(err)) console.warn(err);
  }
}
/** Statistik des gewählten Zeitraums — nur die neueste Auswahl zählt. */
async function loadEvStats() {
  try {
    evStats = await evStatsAbfrage(`/api/ev/stats?range=${encodeURIComponent(evStatsRange)}&date=${todayStr()}`);
    evStatsFehler = '';
  } catch (err) {
    if (istUeberholt(err)) return;
    evStatsFehler = err instanceof ApiFehler ? err.message : 'Statistik konnte nicht geladen werden.';
  }
}

/**
 * Laufende Session und Statistik nachführen, solange die Ansicht offen ist.
 *
 * Nicht pro Messwert: höchstens alle 30 Sekunden, und nie zwei Läufe
 * gleichzeitig. Die Live-Werte oben kommen ohnehin über den Ereignisstrom.
 */
let evNachfuehrenTimer = null;
let evNachfuehrenLaeuft = false;
function starteEvNachfuehren() {
  if (evNachfuehrenTimer !== null) return;
  evNachfuehrenTimer = setInterval(async () => {
    if (el('ev-detail').hidden) {
      clearInterval(evNachfuehrenTimer);
      evNachfuehrenTimer = null;
      return;
    }
    if (evNachfuehrenLaeuft) return;
    evNachfuehrenLaeuft = true;
    try {
      await Promise.all([loadEvSessions(), loadEvStats()]);
      renderEvDetail();
    } finally {
      evNachfuehrenLaeuft = false;
    }
  }, 30_000);
}

function openEvDetail() {
  oeffneDialog('ev-detail');
  renderEvDetail();
  Promise.all([loadEvSessions(), loadEvStats(), loadEvRegelung()]).then(renderEvDetail);
  starteEvNachfuehren();
}
function closeEvDetail() {
  schliesseDialog('ev-detail');
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
/** Eingaben im Tarifformular — bleiben bei einem Fehler stehen. */
let tarifEntwurf = {};
let tarifMeldung = '';
let tarifSpeichert = false;
let tarifRevision = 0;
const tarifAbfrage = letzteAnfrage();
const kontoAbfrage = letzteAnfrage();

/**
 * Wer gerade angemeldet ist — aus /api/ich.
 *
 * Steht bewusst nicht im Live-Zustand: Der ist für alle Betrachter derselbe und
 * wird über einen Ereignisstrom verteilt, die Antwort auf „wer bin ich" gilt
 * dagegen nur für diese eine Verbindung.
 */
let ichCache = null;

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
  const fokusId = body.contains(document.activeElement) ? document.activeElement.id : null;
  const scroll = body.scrollTop;
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
      <p class="setting-hint" style="margin:0 0 0.7rem">
        Gilt für alle Geräte. Jeder Tag wird mit dem Tarif gerechnet, der an ihm galt —
        eine Änderung verändert vergangene Kosten nicht.
        ${t?.grundlage === 'angenommen' ? ' Für heute ist noch kein Tarif gespeichert; die Vorgabe wird angenommen.' : ''}
      </p>
      ${!t ? '<p class="setting-hint">Tarifdaten werden benötigt, bevor Änderungen möglich sind.</p>' : t.darfAendern !== true ? `
      <p class="setting-hint">Aktuell: ${esc(String(t.tarif?.importPricePerKWh ?? '—'))} €/kWh Bezug,
        ${esc(String(t.tarif?.exportPricePerKWh ?? '—'))} €/kWh Einspeisung. Ändern kann nur ein Administrator.</p>` : `
      <div class="detail-grid">
        <label class="detail-tile">
          <span class="dt-label">Bezugspreis (€/kWh)</span>
          <input class="setting-input" id="tariff-import" type="number" step="0.001"
                 min="${TARIF_GRENZEN.importPricePerKWh.min}" max="${TARIF_GRENZEN.importPricePerKWh.max}"
                 inputmode="decimal" value="${esc(tarifEntwurf.import ?? (t?.tarif ? String(t.tarif.importPricePerKWh) : ''))}" />
        </label>
        <label class="detail-tile">
          <span class="dt-label">Einspeisung (€/kWh)</span>
          <input class="setting-input" id="tariff-export" type="number" step="0.001"
                 min="${TARIF_GRENZEN.exportPricePerKWh.min}" max="${TARIF_GRENZEN.exportPricePerKWh.max}"
                 inputmode="decimal" value="${esc(tarifEntwurf.export ?? (t?.tarif ? String(t.tarif.exportPricePerKWh) : ''))}" />
        </label>
        <label class="detail-tile">
          <span class="dt-label">Gültig ab</span>
          <input class="setting-input" id="tariff-ab" type="date"
                 value="${esc(tarifEntwurf.ab ?? todayStr())}" />
        </label>
      </div>
      <div class="setting-actions">
        <button class="btn-primary" id="tariff-save" type="button" ${tarifSpeichert ? 'disabled' : ''}>${tarifSpeichert ? 'Wird gespeichert …' : 'Tarif speichern'}</button>
      </div>`}
      <p class="setting-hint" id="tariff-status" role="status">${esc(tarifMeldung)}</p>
      ${!t ? '<button type="button" class="btn-schlicht" id="tariff-retry">Erneut laden</button>' : ''}
      ${t?.verlauf?.length ? `
      <details class="tarif-verlauf">
        <summary>Tarifverlauf (${t.verlauf.length})</summary>
        <ul>${[...t.verlauf].sort((a, b) => String(b.gueltigAb ?? '').localeCompare(String(a.gueltigAb ?? ''))).map((e) =>
          `<li>${e.gueltigAb ? `ab ${esc(e.gueltigAb)}` : `bekannt seit ${esc(e.bekanntSeit)}`}: ${esc(String(e.importPricePerKWh))} € Bezug, ${esc(String(e.exportPricePerKWh))} € Einspeisung</li>`).join('')}</ul>
      </details>` : ''}
    </div>

    ${ichCache?.enabled ? `
    <div class="detail-section">
      <h3>Konto</h3>
      <div class="setting-actions">
        <button class="btn-primary" id="logout-btn" type="button">Abmelden</button>
        <span class="setting-hint">Angemeldet als ${esc(ichCache.username ?? '')}${
          ichCache.istAdmin ? ' — Administrator' : ''}.</span>
      </div>
      ${ichCache.istAdmin ? `
      <div class="setting-actions">
        <a class="btn-primary" href="/admin" style="text-decoration:none">Benutzer verwalten</a>
        <span class="setting-hint">Wer ist angemeldet, wer darf hinein.</span>
      </div>` : ''}
      <p class="setting-hint" style="margin:0.6rem 0 0">
        Die Anmeldung bleibt sonst ein Jahr gespeichert und verlängert sich bei
        jedem Besuch. Abmelden lohnt nur auf einem fremden Gerät.
      </p>
    </div>` : ''}

    <div class="detail-section">
      <h3>Über</h3>
      <p class="setting-hint" style="margin:0">
        SmartHome · Daten lokal aus Fronius und Victron, Wallbox über die Tuya-Cloud
        (bei aktiver Regelung wird dort auch der Ladestrom gestellt). Die Darstellung
        oben gilt nur in diesem Browser; Tarife und Lademodus gelten für alle Geräte.
      </p>
    </div>`;

  const abmelden = body.querySelector('#logout-btn');
  if (abmelden) abmelden.addEventListener('click', () => { location.href = '/logout'; });

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

  // Tarif speichern — dieselbe Prüfung wie auf dem Server, Erfolg erst nach
  // bestätigtem Speichern, Eingaben bleiben bei einem Fehler stehen.
  const save = el('tariff-save');
  el('tariff-retry')?.addEventListener('click', ladeEinstellungen);
  if (save) {
    const merke = () => {
      tarifEntwurf = {
        import: el('tariff-import').value,
        export: el('tariff-export').value,
        ab: el('tariff-ab').value,
      };
    };
    ['tariff-import', 'tariff-export', 'tariff-ab'].forEach((id) => {
      el(id).disabled = tarifSpeichert;
      el(id).addEventListener('input', merke);
    });
    save.addEventListener('click', async () => {
      if (tarifSpeichert) return;
      merke();
      const status = el('tariff-status');
      const zahl = (s) => (s === '' ? undefined : Number(String(s).replace(',', '.')));
      const eingabe = {
        importPricePerKWh: zahl(tarifEntwurf.import),
        exportPricePerKWh: zahl(tarifEntwurf.export),
        ...(tarifEntwurf.ab ? { gueltigAb: tarifEntwurf.ab } : {}),
      };
      const geprueft = pruefeTarif(eingabe);
      if (!geprueft.ok) {
        tarifMeldung = geprueft.fehler;
        status.textContent = tarifMeldung;
        return;
      }
      tarifSpeichert = true;
      tarifRevision++;
      tarifMeldung = 'Wird gespeichert …';
      renderSettings();
      try {
        tariffCache = await holeJson('/api/tariff', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(geprueft.tarif),
        });
        tarifEntwurf = {};
        tarifMeldung = `Gespeichert, gültig ab ${geprueft.tarif.gueltigAb ?? todayStr()}.`;
        // Kosten mit dem gültigen Tarif neu berechnen lassen.
        await loadDay(selectedDate);
      } catch (err) {
        // Bisheriger bestätigter Tarif gilt weiter; die Eingaben bleiben stehen.
        tarifMeldung = err instanceof ApiFehler ? err.message : 'Speichern fehlgeschlagen.';
      } finally {
        tarifSpeichert = false;
        if (!el('settings').hidden) renderSettings();
      }
    });
  }
  body.scrollTop = scroll;
  if (fokusId && el(fokusId) && !el(fokusId).disabled) el(fokusId).focus({ preventScroll: true });
}

function openSettings() {
  oeffneDialog('settings');
  renderSettings();
  if (!tarifSpeichert) void ladeEinstellungen();
}
async function ladeEinstellungen() {
  const revision = tarifRevision;
  await Promise.all([
    tarifAbfrage('/api/tariff')
      .then((t) => {
        if (!tarifSpeichert && revision === tarifRevision) {
          tariffCache = t;
          tarifMeldung = '';
        }
      })
      .catch((err) => { if (!istUeberholt(err) && revision === tarifRevision) tarifMeldung = err.message ?? 'Tarif nicht abrufbar.'; }),
  // Und wer gerade angemeldet ist — davon hängt ab, ob der Abmelden-Knopf und
  // der Zugang zur Verwaltung erscheinen.
    kontoAbfrage('/api/ich').then((i) => { ichCache = i; }).catch(() => undefined),
  ]);
  if (!el('settings').hidden && revision === tarifRevision) renderSettings();
}
function closeSettings() {
  schliesseDialog('settings');
}

let dialogAusloeser = null;
let offenerDialog = null;
let hintergrundZustand = [];
function oeffneDialog(id) {
  if (offenerDialog) return;
  dialogAusloeser = document.activeElement;
  offenerDialog = el(id);
  offenerDialog.hidden = false;
  hintergrundZustand = [...document.body.children].filter((x) => x !== offenerDialog).map((x) => [x, x.inert]);
  for (const [x] of hintergrundZustand) x.inert = true;
  document.body.style.overflow = 'hidden';
  offenerDialog.querySelector('.detail-head button')?.focus();
}
function schliesseDialog(id) {
  if (offenerDialog !== el(id)) return;
  offenerDialog.hidden = true;
  offenerDialog = null;
  for (const [x, inert] of hintergrundZustand) x.inert = inert;
  hintergrundZustand = [];
  document.body.style.overflow = '';
  if (dialogAusloeser?.isConnected) dialogAusloeser.focus({ preventScroll: true });
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
      el('view-toggle').querySelectorAll('.vt-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', String(b === btn));
      });
      hoverIndex = null;
      buildLegend(); renderChart();
    });
  });
  setupChartHover();
  setupTabbar();
  applyFlowZoom();
  setupSettings();
  document.querySelectorAll('[data-ev-open]').forEach((knopf) => knopf.addEventListener('click', openEvDetail));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !offenerDialog) return;
    const ziele = [...offenerDialog.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')]
      .filter((x) => !x.disabled && x.tabIndex >= 0 && x.getClientRects().length > 0);
    const erstes = ziele[0], letztes = ziele.at(-1);
    if (!erstes) return;
    if (!offenerDialog.contains(document.activeElement) || (e.shiftKey ? document.activeElement === erstes : document.activeElement === letztes)) {
      e.preventDefault();
      (e.shiftKey ? letztes : erstes).focus();
    }
  });
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
      navigator.serviceWorker.register('/sw.js').then(beobachteUpdates).catch(() => {});
    });
  }
}

/**
 * Neue Fassung nach einem Deploy: ein Hinweis mit „Neu laden“, nie ein
 * Neuladen von selbst — mitten im Verschieben des Ladestrom-Reglers wäre das
 * eine verlorene Eingabe. Der neue Service Worker wartet, bis hier getippt wird.
 */
function beobachteUpdates(reg) {
  const wartet = () => {
    if (reg.waiting && navigator.serviceWorker.controller) zeigeUpdateHinweis(reg);
  };
  wartet();
  reg.addEventListener('updatefound', () => {
    const neu = reg.installing;
    neu?.addEventListener('statechange', () => { if (neu.state === 'installed') wartet(); });
  });
  // Eine offen gelassene App erfährt sonst erst beim nächsten Start davon.
  setInterval(() => { reg.update().catch(() => {}); }, 30 * 60 * 1000);

  let angefordert = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (angefordert) window.location.reload();
  });
  document.addEventListener('click', (e) => {
    const knopf = e.target instanceof Element ? e.target.closest('[data-update]') : null;
    if (!knopf) return;
    if (knopf.dataset.update === 'spaeter') {
      document.getElementById('update-hinweis')?.remove();
      return;
    }
    angefordert = true;
    knopf.disabled = true;
    // Hat der Worker schon übernommen (anderes Fenster), direkt neu laden.
    if (reg.waiting) reg.waiting.postMessage('neue-version-uebernehmen');
    else window.location.reload();
  });
}

function zeigeUpdateHinweis() {
  if (document.getElementById('update-hinweis')) return;
  const el = document.createElement('div');
  el.id = 'update-hinweis';
  el.className = 'update-hinweis';
  el.setAttribute('role', 'status');
  el.innerHTML = '<span>Eine neue Version der App ist bereit.</span>'
    + '<button type="button" class="btn-primary" data-update="laden">Neu laden</button>'
    + '<button type="button" class="update-spaeter" data-update="spaeter">Später</button>';
  document.body.appendChild(el);
}
init();
