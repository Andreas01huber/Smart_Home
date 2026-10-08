/**
 * HTTP-Server der Energy App.
 *
 * Liefert das Dashboard als statische Seite, die Messwerte über Server-Sent
 * Events (`live-strom.ts`) und die Auskünfte als JSON. Bewusst ohne
 * Web-Framework; die Routen stehen als Tabelle in `starteServer`.
 *
 * Bindung über config.host (Standard 0.0.0.0, damit das Handy im Heimnetz
 * zugreifen kann; auf 127.0.0.1 setzbar). Zugangsdaten verlassen den Server
 * niemals (Anforderung 4U).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  FroniusLocalConnector,
  VictronModbusConnector,
  TuyaEvseConnector,
  ManagedConnector,
  type EnergyConnector,
  type SteuerbaresLadegeraet,
} from '@energy/connectors';

import { LoginThrottle } from './auth.ts';
import { authGate } from './auth-gate.ts';
import { adminRouten } from './admin-routes.ts';
import { Kontenspeicher, type Benutzer } from './benutzer.ts';
import { Sitzungsspeicher } from './sitzungen.ts';
import { loadConfig, quellenNamen, KonfigurationsFehler, type AppConfig, type Quelle } from './config.ts';
import { EnergyEngine } from './engine.ts';
import { EnergyAccumulator, localDate } from './history.ts';
import { ChargeSessionLog } from './ev-log.ts';
import { Ladesteuerung } from './ladesteuerung.ts';
import { readBody, mitHttpFehlergrenze, herkunftErlaubt } from './http-util.ts';
import { pruefeBetriebsartAnfrage, pruefeStoppAnfrage } from './ev-anfragen.ts';
import { gesundheit } from './gesundheit.ts';
import { schreibstatus } from './persist.ts';
import { Serialisierer } from './serialisierung.ts';
import { LiveStrom } from './live-strom.ts';
import { Ereignisprotokoll } from './ereignisse.ts';

const PUBLIC_DIR = resolve(import.meta.dirname, '..', 'public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Baut einen Connector aus seiner Beschreibung — die einzige Stelle, die Typen kennt. */
function baueConnector(q: Quelle): EnergyConnector | null {
  switch (q.typ) {
    case 'fronius-solar-api':
      return new FroniusLocalConnector({
        host: q.host,
        connectorId: q.id,
        displayName: q.displayName,
        ...(q.speicher !== null ? { batteryDisplayName: q.speicher.displayName } : {}),
        ...(q.speicher?.usableCapacityWh != null
          ? { usableCapacityWhByDevice: { '0': q.speicher.usableCapacityWh } }
          : {}),
      });
    case 'victron-modbus':
      return new VictronModbusConnector({
        host: q.host,
        connectorId: q.id,
        displayName: q.displayName,
        batteryDisplayName: q.speicher?.displayName ?? 'Speicher',
        usableCapacityWh: q.speicher?.usableCapacityWh ?? null,
      });
    case 'tuya-evse':
      // Ohne Zugangsdaten bleibt die Wallbox "nicht eingerichtet" — kein Fehler.
      if (q.accessId === null || q.accessSecret === null) {
        console.warn(`[Konfiguration] ${q.displayName}: keine Tuya-Zugangsdaten in secrets.json — Wallbox wird übersprungen.`);
        return null;
      }
      return new TuyaEvseConnector({
        accessId: q.accessId,
        accessSecret: q.accessSecret,
        deviceId: q.deviceId,
        connectorId: q.id,
        displayName: q.displayName,
        region: q.region,
        ...(q.idleIntervalMs !== undefined ? { idleIntervalMs: q.idleIntervalMs } : {}),
        ...(q.activeIntervalMs !== undefined ? { activeIntervalMs: q.activeIntervalMs } : {}),
      });
  }
}

/**
 * Baut alle Connectoren hinter dem Health-Gate und reicht das steuerbare
 * Ladegerät heraus — durch das Gate hindurch, nicht daran vorbei.
 */
function buildConnectors(config: AppConfig): {
  connectors: ManagedConnector[];
  wallbox: SteuerbaresLadegeraet | null;
} {
  const connectors = config.quellen
    .map(baueConnector)
    .filter((c): c is EnergyConnector => c !== null)
    .map((c) => new ManagedConnector(c));
  const wallbox = connectors.map((c) => c.ladegeraet()).find((l) => l !== null) ?? null;
  return { connectors, wallbox };
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const requested = pathname === '/' ? '/index.html' : pathname;
  // Pfad-Traversal verhindern: normalisieren und auf PUBLIC_DIR einschränken.
  const candidate = join(PUBLIC_DIR, normalize(requested).replace(/^(\.\.[/\\])+/, ''));
  if (!candidate.startsWith(PUBLIC_DIR + sep) || !existsSync(candidate) || !(await stat(candidate)).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Nicht gefunden');
    return;
  }
  const body = await readFile(candidate);
  const ext = extname(candidate);
  const cacheable = ['.png', '.svg', '.ico', '.jpg', '.jpeg', '.webp', '.woff', '.woff2'];
  response.writeHead(200, {
    'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'cache-control': cacheable.includes(ext) ? 'public, max-age=86400' : 'no-cache',
  });
  response.end(body);
}

/** Private IPv4-Adressen dieses PCs im Heimnetz (für die Handy-URL). */
function lanAddresses(): string[] {
  const result: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) result.push(addr.address);
    }
  }
  return result;
}

/** Was ein Serverstart braucht. Alles Übrige leitet er daraus ab. */
export interface Startoptionen {
  readonly config: AppConfig;
  /** Wohin Historie, Sitzungen und Ladeprotokoll geschrieben werden. */
  readonly datenverzeichnis: string;
  /**
   * Datenquellen und Wallbox von aussen — für den Fixture-Server mit
   * simulierten Geräten. Ohne Angabe werden sie aus der Konfiguration gebaut.
   */
  readonly quellen?: { connectors: ManagedConnector[]; wallbox: SteuerbaresLadegeraet | null };
  /**
   * Wird vor jeder Anfrage gefragt; `true` heisst "bereits beantwortet". Nur
   * für Test- und Fixture-Betrieb (Verzögerungen, Fehlerantworten).
   */
  readonly vorbehandlung?: (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) => Promise<boolean>;
}

export interface LaufenderServer {
  readonly server: ReturnType<typeof createServer>;
  /** Geordnet beenden: Messung anhalten, alles speichern, Verbindungen schliessen. */
  stoppe(): Promise<void>;
}

/** Eine Route: Methode(n), Pfad (genau oder Muster) und Behandlung. */
interface Route {
  readonly methode: 'GET' | 'POST' | 'PUT' | 'ANY';
  readonly pfad: string | RegExp;
  /** Nur Administratoren. */
  readonly admin?: boolean;
  readonly behandle: (ctx: Anfrage) => Promise<void> | void;
}

interface Anfrage {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly treffer: RegExpMatchArray | null;
  readonly ich: Benutzer | null;
  readonly sitzungId: string | null;
  readonly darfVerwalten: boolean;
  json(status: number, payload: unknown): void;
}

export async function starteServer(o: Startoptionen): Promise<LaufenderServer> {
  const { config, datenverzeichnis } = o;
  // Vor Messung, Persistenz und Ladebefehlen prüfen: Auth-Fehler dürfen keinen
  // teilweise laufenden, ungeschützten Server hinterlassen.
  const konten = Kontenspeicher.ladenFuerServer(config.kontenPfad, config.allowUnauthenticatedAccess, config.secretsPfad);
  const sitzungen = konten === null ? null : new Sitzungsspeicher(
    resolve(datenverzeichnis, 'sitzungen.json'), konten.sessionSecret,
    resolve(config.kontenPfad, '..', 'sitzungen-gesperrt.flag'),
  );
  const { connectors, wallbox } = o.quellen ?? buildConnectors(config);
  if (connectors.length === 0) {
    throw new Error(
      'Keine Datenquelle aktiviert. Bitte in config.json mindestens eine Quelle auf "enabled": true setzen.',
    );
  }
  const byId = new Map<string, ManagedConnector>();
  for (const c of connectors) byId.set(c.id, c);

  const ereignisse = new Ereignisprotokoll(datenverzeichnis);
  const engine = new EnergyEngine(connectors, config);
  const serialisierer = new Serialisierer(config);

  const pvSources = Array.isArray(config.sourceMapping.solarProductionW)
    ? config.sourceMapping.solarProductionW
    : [config.sourceMapping.solarProductionW];
  const accumulator = new EnergyAccumulator({
    dataDir: datenverzeichnis,
    pvSources,
    names: quellenNamen(config),
    tariff: config.tariff,
  });
  const evLog = new ChargeSessionLog(datenverzeichnis);

  const startMs = Date.now();
  let letzterZyklusMs: number | null = null;
  engine.subscribe(() => { letzterZyklusMs = Date.now(); });
  // Ein Abonnement für beide, damit sie garantiert mit derselben geprüften
  // Ladeleistung rechnen.
  engine.subscribe((state) => {
    const autoW = Serialisierer.geprueftAutoW(serialisierer.hausUndAuto(state));
    accumulator.integrate(state, autoW);
    evLog.integrate(state, autoW);
  });
  // Verbindungswechsel der Geräte ins Ereignisprotokoll.
  const geraeteStatus = new Map<string, string>();
  engine.subscribe((state) => {
    for (const d of state.diagnostics) {
      const status = (d as { status?: string }).status ?? (d.online ? 'online' : 'offline');
      const vorher = geraeteStatus.get(d.connectorId);
      if (vorher !== undefined && vorher !== status && (status === 'offline' || vorher === 'offline')) {
        ereignisse.notiere(`geraet.${status}`, `${d.displayName}: ${status}`, { connectorId: d.connectorId, lastError: d.lastError });
      }
      geraeteStatus.set(d.connectorId, status);
    }
  });

  const ladesteuerung = new Ladesteuerung(engine, wallbox, config, datenverzeichnis, ereignisse);
  ladesteuerung.lerneAus(
    accumulator.todaySeries().flatMap((p) =>
      Object.entries(p.bat).map(([id, b]) => ({
        id,
        entladenW: Math.max(0, -(b.p ?? 0)),
        tMs: p.t,
      })),
    ),
  );

  const live = new LiveStrom(
    engine,
    (state) => serialisierer.zustand(state, ladesteuerung.kurz()),
    (b) => ladesteuerung.abonniere(b),
  );

  const throttle = new LoginThrottle();

  // ── Routen ─────────────────────────────────────────────────────────────
  const ladeAnfrage = async (
    a: Anfrage,
    pruefe: (roh: unknown) => { ok: true; wert: unknown } | { ok: false; fehler: string },
    ausfuehren: (wert: never) => unknown,
  ): Promise<void> => {
    let roh: unknown;
    try {
      roh = JSON.parse(await readBody(a.request, 1_000));
    } catch {
      a.json(400, { error: 'Ungültige Anfrage.' });
      return;
    }
    const geprueft = pruefe(roh);
    if (!geprueft.ok) {
      a.json(400, { error: geprueft.fehler });
      return;
    }
    try {
      const extra = ausfuehren(geprueft.wert as never);
      a.json(200, extra ?? ladesteuerung.kurz());
    } catch (error) {
      a.json(500, { error: error instanceof Error ? error.message : 'Einstellung konnte nicht übernommen werden.' });
    }
  };
  const datum = (roh: string | null): string =>
    roh && /^\d{4}-\d{2}-\d{2}$/.test(roh) ? roh : localDate(new Date());

  const routen: readonly Route[] = [
    { methode: 'GET', pfad: '/api/ich', behandle: (a) => a.json(200, a.ich === null
      ? { enabled: konten !== null }
      : { enabled: true, username: a.ich.username, rolle: a.ich.rolle, istAdmin: a.ich.rolle === 'admin' }) },
    { methode: 'GET', pfad: '/api/events', behandle: (a) => {
      const kennung = a.sitzungId;
      const konto = a.ich;
      live.verbinde(a.request, a.response,
        sitzungen === null || kennung === null || konten === null
          ? undefined
          : () => sitzungen.gilt(kennung) && konten.nachId(konto?.id ?? '') !== null);
    } },
    { methode: 'GET', pfad: '/api/snapshot', behandle: (a) => {
      const state = engine.current();
      a.json(state === null ? 503 : 200, state === null
        ? { error: 'Noch keine Messung' }
        : serialisierer.zustand(state, ladesteuerung.kurz()));
    } },
    { methode: 'GET', pfad: '/api/today', behandle: (a) => a.json(200, accumulator.todayView()) },
    { methode: 'GET', pfad: '/api/today/series', behandle: (a) => a.json(200, { points: accumulator.todaySeries() }) },
    { methode: 'GET', pfad: '/api/history', behandle: (a) => {
      const allowed = ['day', 'month', 'year', 'total'] as const;
      const range = a.url.searchParams.get('range') ?? 'day';
      const r = (allowed as readonly string[]).includes(range) ? range : 'day';
      a.json(200, accumulator.historyView(r as (typeof allowed)[number]));
    } },
    { methode: 'GET', pfad: '/api/history/day', behandle: (a) => {
      const view = accumulator.dayView(datum(a.url.searchParams.get('date'))) as Record<string, unknown>;
      if (a.url.searchParams.get('summary') !== null && view) {
        const { series, ...rest } = view;
        void series;
        a.json(200, rest);
      } else {
        a.json(200, view);
      }
    } },
    { methode: 'GET', pfad: '/api/history/dates', behandle: (a) => a.json(200, { dates: accumulator.availableDates() }) },
    { methode: 'GET', pfad: '/api/ev/sessions', behandle: (a) => {
      const raw = Number(a.url.searchParams.get('limit') ?? '50');
      const limit = Number.isFinite(raw) ? Math.min(500, Math.max(1, raw)) : 50;
      a.json(200, { current: evLog.current(), sessions: evLog.list(limit) });
    } },
    { methode: 'GET', pfad: /^\/api\/ev\/sessions\/(.+)$/, behandle: (a) => {
      const session = evLog.find(decodeURIComponent(a.treffer?.[1] ?? ''));
      a.json(session === null ? 404 : 200, session ?? { error: 'Ladevorgang nicht gefunden' });
    } },
    { methode: 'GET', pfad: '/api/ev/stats', behandle: (a) => {
      const allowed = ['day', 'week', 'month', 'year', 'total'];
      const rangeRaw = a.url.searchParams.get('range') ?? 'month';
      a.json(200, evLog.stats(allowed.includes(rangeRaw) ? rangeRaw : 'month', datum(a.url.searchParams.get('date'))));
    } },
    { methode: 'POST', pfad: '/api/ev/stopp', behandle: (a) =>
      ladeAnfrage(a, pruefeStoppAnfrage, (w: { an: boolean }) => { ladesteuerung.setzeGestoppt(w.an); }) },
    { methode: 'POST', pfad: '/api/ev/betriebsart', behandle: (a) =>
      ladeAnfrage(a, pruefeBetriebsartAnfrage, (w: { art: 'intelligent' | 'manuell'; ampere?: number }) => {
        ladesteuerung.setzeBetriebsart(w.art, w.ampere);
      }) },
    // Alte Schnittstelle: "Volladung" ist Handbetrieb auf dem Höchstwert.
    { methode: 'POST', pfad: '/api/ev/volladung', behandle: (a) =>
      ladeAnfrage(a, pruefeStoppAnfrage, (w: { an: boolean }) => { ladesteuerung.setzeVolladung(w.an); return { volladung: w.an }; }) },
    { methode: 'GET', pfad: '/api/ev/regelung', behandle: (a) => a.json(200, ladesteuerung.zustand()) },
    { methode: 'GET', pfad: '/api/ereignisse', behandle: (a) => {
      const raw = Number(a.url.searchParams.get('limit') ?? '100');
      a.json(200, { ereignisse: ereignisse.letzte(Number.isFinite(raw) ? Math.min(500, Math.max(1, raw)) : 100), schreibfehler: ereignisse.schreibfehler() });
    } },
    { methode: 'GET', pfad: '/api/collector', behandle: (a) => a.json(200, accumulator.collectorHealth()) },
    { methode: 'POST', pfad: /^\/api\/devices\/([^/]+)\/reconnect$/, behandle: async (a) => {
      const deviceId = decodeURIComponent(a.treffer?.[1] ?? '');
      const connector = byId.get(deviceId);
      if (!connector) { a.json(404, { error: 'Unbekanntes Gerät', deviceId }); return; }
      try {
        const diag = await connector.reconnect();
        ereignisse.notiere('geraet.reconnect', `${connector.displayName}: manuell neu verbunden (${diag.status})`, { von: a.ich?.username ?? null });
        a.json(200, { ...diag, lastSuccessAt: diag.lastSuccessAt?.toISOString() ?? null, reconnectable: true });
      } catch (error) {
        a.json(500, { error: error instanceof Error ? error.message : 'Reconnect fehlgeschlagen' });
      }
    } },
    { methode: 'GET', pfad: '/api/tariff', behandle: (a) =>
      a.json(200, { ...accumulator.tarife.aktuell(), verlauf: accumulator.tarife.verlauf(), darfAendern: a.darfVerwalten }) },
    { methode: 'PUT', pfad: '/api/tariff', admin: true, behandle: async (a) => {
      let roh: unknown;
      try {
        roh = JSON.parse(await readBody(a.request));
      } catch {
        a.json(400, { error: 'Ungültige Anfrage' });
        return;
      }
      try {
        accumulator.tarife.setze(roh);
        ereignisse.notiere('tarif.geaendert', 'Tarif geändert.', { von: a.ich?.username ?? null });
        a.json(200, { ...accumulator.tarife.aktuell(), verlauf: accumulator.tarife.verlauf(), darfAendern: true });
      } catch (error) {
        if (error instanceof TypeError) a.json(400, { error: error.message });
        else a.json(500, { error: 'Tarif konnte nicht gespeichert werden. Bisheriger Tarif gilt weiter.' });
      }
    } },
  ];

  const server = createServer(mitHttpFehlergrenze(async (request, response, url) => {
    if (o.vorbehandlung && (await o.vorbehandlung(request, response, url))) return;

    // Healthcheck ohne Anmeldung, ohne private Daten; siehe gesundheit.ts.
    if (url.pathname === '/health' && request.method === 'GET') {
      const g = gesundheit({ startMs, letzterZyklusMs, jetztMs: Date.now(), speicher: schreibstatus() });
      response.writeHead(g.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(g.body));
      return;
    }
    if (!herkunftErlaubt(request)) {
      response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Anfrage von fremder Herkunft abgelehnt.' }));
      return;
    }

    let ich: Benutzer | null = null;
    let sitzungId: string | null = null;
    if (konten !== null && sitzungen !== null) {
      const schranke = authGate(request, response, url, {
        konten, sitzungen, throttle, vertrauteProxies: config.trustedProxies,
      });
      if (!schranke.weiter) return;
      ich = schranke.benutzer ?? null;
      sitzungId = schranke.sitzungId ?? null;
      if (ich !== null && adminRouten(request, response, url, ich, {
        konten, sitzungen, vertrauteProxies: config.trustedProxies, ereignisse,
      })) {
        return;
      }
    } else if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem;line-height:1.6">' +
          '<h1 style="font-size:1.2rem">Noch keine Anmeldung eingerichtet</h1>' +
          '<p>Auf dem Server-PC im Ordner der App ausf&uuml;hren: <code>npm run passwort</code>. ' +
          'Das erste Konto wird automatisch Administrator.</p>' +
          '<p><a href="/">Zur&uuml;ck zum Dashboard</a></p></body>',
      );
      return;
    }

    // Rechte, serverseitig: Familienkonten dürfen Dashboard und Ladebedienung
    // nutzen; Tarife und Konten verwaltet ein Administrator.
    const darfVerwalten = konten === null ? true : ich?.rolle === 'admin';
    const anfrage: Anfrage = {
      request, response, url, treffer: null, ich, sitzungId, darfVerwalten,
      json(status, payload) {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(payload));
      },
    };

    let pfadBekannt = false;
    for (const route of routen) {
      const treffer = typeof route.pfad === 'string'
        ? (url.pathname === route.pfad ? ([] as unknown as RegExpMatchArray) : null)
        : url.pathname.match(route.pfad);
      if (treffer === null) continue;
      pfadBekannt = true;
      if (route.methode !== 'ANY' && request.method !== route.methode) continue;
      if (route.admin && !darfVerwalten) {
        anfrage.json(403, { error: 'Nur ein Administrator darf das ändern.' });
        return;
      }
      await route.behandle({ ...anfrage, treffer });
      return;
    }
    if (pfadBekannt) {
      const erlaubt = routen.filter((r) => typeof r.pfad === 'string' ? r.pfad === url.pathname : url.pathname.match(r.pfad)).map((r) => r.methode);
      response.writeHead(405, { allow: erlaubt.join(', ') });
      response.end();
      return;
    }
    await serveStatic(url.pathname, response);
  }));

  let stopping: Promise<void> | null = null;
  const stoppe = (): Promise<void> => {
    stopping ??= (async () => {
      engine.stop();
      live.stop();
      // Erst die Wallbox in einen sicheren Zustand, dann speichern.
      await ladesteuerung.beimHerunterfahren();
      accumulator.persist();
      evLog.persist();
      sitzungen?.persist();
      ereignisse.notiere('server.stopp', 'Server geordnet beendet.');
      await new Promise<void>((fertig) => {
        server.close(() => fertig());
        server.closeAllConnections();
      });
    })();
    return stopping;
  };

  await new Promise<void>((bereit, fehler) => {
    server.once('error', fehler);
    server.listen(config.port, config.host, () => {
      server.off('error', fehler);
      bereit();
    });
  });
  meldeStart(config, connectors, konten);
  ereignisse.notiere('server.start', 'Server gestartet.', { quellen: connectors.map((c) => c.id), modus: config.ueberschuss.modus });
  // Ein belegter Port darf weder Messung noch Laderegelung im Hintergrund
  // zurücklassen. Erst nach erfolgreichem Listen starten.
  engine.start();
  live.start();
  ladesteuerung.start();
  return { server, stoppe };
}

function meldeStart(
  config: AppConfig,
  connectors: readonly ManagedConnector[],
  konten: Kontenspeicher | null,
): void {
  console.log('');
  console.log('  SmartHome läuft.');
  console.log('');
  console.log(`  Auf diesem PC:   http://localhost:${config.port}`);
  if (config.host === '0.0.0.0') {
    const lanIps = lanAddresses();
    if (lanIps.length > 0) {
      console.log('');
      console.log('  Auf dem Handy (gleiches WLAN), Adresse im Browser eingeben:');
      for (const ip of lanIps) console.log(`     http://${ip}:${config.port}`);
    }
  }
  console.log('');
  console.log(`  Quellen:     ${connectors.map((c) => c.displayName).join(', ')}`);
  console.log('');
  if (konten !== null) {
    const namen = konten
      .alle()
      .map((b) => (b.rolle === 'admin' ? `${b.username} (Admin)` : b.username))
      .join(', ');
    console.log(`  Anmeldung:   aktiv - ${konten.anzahl()} Konto/Konten: ${namen}`);
    console.log(`  Verwaltung:  http://localhost:${config.port}/admin`);
  } else {
    console.log('  ACHTUNG: Anmeldung ist per allowUnauthenticatedAccess abgeschaltet -');
    console.log('           die App ist für jeden erreichbar, der die Adresse kennt.');
  }
  console.log('');
  console.log('  Beenden: Strg+C (speichert vorher alles).');
  console.log('');
}

async function main(): Promise<void> {
  const laufend = await starteServer({
    config: loadConfig(),
    datenverzeichnis: resolve(process.cwd(), 'data'),
  });
  const beenden = (): void => {
    // Letzte Stufe, nur für diesen Prozess: Hängt das geordnete Beenden länger
    // als zehn Sekunden, wird hart beendet.
    setTimeout(() => process.exit(1), 10_000).unref();
    void laufend.stoppe().then(() => process.exit(0));
  };
  process.on('SIGINT', beenden);
  process.on('SIGTERM', beenden);
}

// Nur als Programm starten, nicht beim Import (Fixture-Server, Tests).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    if (error instanceof KonfigurationsFehler) console.error(error.message);
    else console.error(error instanceof Error ? error.message : 'Serverstart fehlgeschlagen');
    process.exitCode = 1;
  });
}
