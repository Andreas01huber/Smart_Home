# Umsetzung des Projektreviews (Auftrag docs/17) — Ergebnis und Übergabe

Stand: 19.09.2026, Zweig `review-umsetzung` (nur lokal committet, **nicht**
gepusht, **nicht** ausgeliefert). Ein Push auf `main` löst den Deploy aus —
vorher die Hinweise unter „Vor dem ersten Deploy“ lesen.

Commits (älteste zuerst): `235eebf` Datenwahrheit · `8787c4c` Oberfläche
(Zwischenstand der Parallelsitzung, docs/18) · `54bb1e4` Ladebedienung ·
`3e3930e` Betrieb/Zugriffsschutz · `ec6b0d5` Health/Deploy/Docker/PWA ·
`5bc869e` Frische-Wächter und Ladekarte · `2a7ce56` Dunkelmodus, Diagramm in
Worten.

---

## Umgesetzt

### 1–2 Datenwahrheit und Bilanz
- Werte sind **gemessen**, **geschätzt** oder **unbekannt**; `null` bleibt
  unbekannt, eine gemessene 0 bleibt gültig, Schätzungen tragen „≈“.
- Haus/Auto-Aufteilung einmal je Messzyklus; Grundlast nur aus gemessener
  Aufteilung.
- Integration mit Haltewert, Schrittgrenze 15 s, längere Lücken als Lücke;
  Mitternachts- und Sommerzeitschnitt; Abdeckung mit festem Nenner
  (Tagesbeginn → jetzt bzw. tatsächliche Tageslänge 23/24/25 h).
- Quellen/Senken je Intervall zugeordnet; Netzladung des Speichers erzeugt
  keinen PV-Anteil und keine Ersparnis; Grundgebühr ausdrücklich nicht enthalten.
- Tarifhistorie mit `gueltigAb`; spätere Tarifänderungen verändern frühere
  Kosten nicht. Gemeinsame Validierung Browser/Server (`tarif-regeln.js`).

### 3 Ladebedienung
- Lademodus wird gespeichert (`data/lademodus.json`). **Ohne gespeicherte Wahl
  wird nicht geladen** (Zustand „Lademodus wählen“).
- Nutzerwunsch, Befehlsstatus (übermittelt/angenommen/bestätigt/fehlgeschlagen),
  Gerätesicht und gemessenes Laden sind getrennt; „freigegeben“ ist kein
  „lädt“.
- Stopp ist immer bedienbar und überholt laufende Befehle; neuere Antworten
  gewinnen (`befehlsfolge`). Regeländerungen kommen sofort per SSE.
- Kein Moduswechsel beim Abstecken; Pause endet nur bei bestätigtem Abstecken.
- Manuell ohne Warn-Dialog, dafür dauerhaft „bei Bedarf Netzstrom“;
  Haushaltsgrenze nur einphasig.
- Strikte Validierung der Schreib-APIs (400 ohne Zustandsänderung).

### 4–5 Oberfläche und Frontend-Zustand
- Mobile Navigation Übersicht/Laden/Verlauf/Kosten; kompakter Ladezugang oben.
- Ladekarte reduziert: „Eingestellt: 10 A · Grenze 16 A“, SOC „vom Ladegerät
  nicht übermittelt“, Knopf „Erneut abfragen“ statt „Verbinden“; Temperatur,
  Zählerstand, Quelle und Gerätegrenze im aufklappbaren Abschnitt „Ladegerät“
  der Detailansicht.
- Kopfzeile ehrlich: meldet auch einen fehlenden Speicher hinter einem
  antwortenden Gateway und eine nicht erreichbare Wallbox hinter erreichbarer
  Cloud. Der Live-Zustand der Wallbox geht vor dem letzten Regelurteil.
- **Frische-Wächter**: Server-Puls alle 10 s; offener, aber stummer Strom wird
  nach 25 s neu aufgebaut. Bei Ausfall „zuletzt bekannt HH:MM:SS · vor N s“
  (Alter tickt sekündlich), Flussanimationen stehen still, Kopfzeile
  „App-Verbindung unterbrochen“ getrennt von Geräteproblemen. Alte
  Gerätewerte trotz frischer Abfrage heissen „Messwerte veraltet“.
- Tages- und Zeitraumabfragen gegen vertauschte Antworten geschützt; Fehler
  zeigen die letzten bestätigten Daten plus „Erneut laden“, nie eine leere
  Historie. Tageswechsel wechselt „heute“ bewusst, ein Archivdatum bleibt.
- Dialog mit Fokusfalle/inert/Escape; Legenden als Buttons mit
  `aria-pressed`; Tabs mit `aria-selected`; Diagramm zusätzlich in Worten
  (Höchstwert und Uhrzeit je sichtbarer Reihe).
- **Behobener Fehler:** Theme „Automatisch“ wurde nie dunkel (das Stylesheet
  kennt nur `data-theme='dark'`). Jetzt folgt es der Systemeinstellung.

### 6–7 Geräte, Persistenz, Zugriff
- Modbus-Client prüft alle Kopffelder, begrenzt die Länge, beendet bei
  vorzeitigem Ende, hat eine absolute Frist; ManagedConnector teilt laufende
  Prüfungen; Engine mit Frist je Quelle (30 s).
- Fachliche Validierung gespeicherter Dateien; beschädigte Dateien bleiben
  erhalten, Schreibsperre falls sie nicht beiseitegelegt werden können;
  Schreibstatus in der Verwaltung sichtbar.
- Sitzungswiderruf mit Notfall-Marker bei doppeltem Schreibfehler.
- Weitergeleitete Adressen nur von `trustedProxies`; Herkunftsschutz (403) für
  fremde Origins; Tarif- und Kontenverwaltung serverseitig nur für Admins.

### 8 Betrieb
- `GET /health` ohne Anmeldung und ohne private Daten (`ok`, `laufzeitS`,
  `messung: startet|laeuft|steht`, `letzterZyklusVorS`, `speicher: ok|fehler|gesperrt`).
  503 nur, wenn die Messung steht — ein ausgefallenes Gerät macht den Dienst
  nicht krank.
- Deploy-Workflow: vorbereiten bei laufendem Server (`C:\SmartHome-neu`, bei
  neuem Lockfile `npm ci` + Probeladen), sichern (`C:\SmartHome-vorher`),
  umschalten, `/health` prüfen, bei Fehler **oder Abbruch** zurück zum
  gesicherten Stand. Neue Pushes warten statt abzubrechen
  (`cancel-in-progress: false`). **`config.json` wird nicht mehr überschrieben**
  (nur beim allerersten Deploy; Abweichung → `config.repo.json` + Warnung).
- Docker: `secrets.json` bleibt schreibgeschützt; Konten/Sitzungsgeheimnis in
  `data/konten.json` über `SMARTHOME_KONTEN`, einmalige Übernahme aus
  `secrets.json`. Healthchecks auf `/health`.
- PWA: App-Shell netzwerk-zuerst (Cache nur offline), keine umgeleiteten oder
  `no-store`-Antworten im Cache; neue Fassung wartet auf „Neu laden“ statt
  selbst neu zu laden (keine Unterbrechung am Regler).
- Anleitungen (deploy/README.md, GIT-WORKFLOW.md, INSTALLATION.md) an
  Anmeldepflicht und neuen Deploy angepasst.

---

## Tests

- `npm run typecheck`: fehlerfrei.
- `npm test`: **481 von 481** bestanden.
  Neu u. a.: Hausverbrauch, Bilanzmodell, Historie mit Lücken/Mitternacht/
  Sommerzeit (TZ Europe/Vienna), Ladeprotokoll über Monatsgrenzen,
  Tarifhistorie, Lademodus-Persistenz und Befehlsstatus, Stopp-Vorrang,
  Anfragevalidierung, Modbus gegen Fake-TCP-Server (fragmentiert, falsche IDs,
  Exception, vorzeitiges Ende, überlang, Tropfantwort, Abbruch),
  Connector-/Engine-Fristen, Proxy-Vertrauen, Herkunftsschutz,
  Sitzungs-Doppelfehler, Healthcheck (auch mit aktiver Anmeldung),
  Kontenumzug für Docker, Ladezustand-Vorrang des Live-Zustands.

## Browserprüfung (isolierter Fixture-Server, simulierte Geräte)

Geprüft mit `tools/fixture-server.ts` (Ports 4180/4181, Konfigurationen
„fixture“/„fixture-leer“), keine echte Anlage, keine echten Gerätebefehle:

- Szenarien sonnig, nachts, wartet, kein Auto, voll, Speicher offline,
  Messwerte veraltet, Wallbox offline: Texte und Kopfzeile stimmig (dabei drei
  Fehler gefunden und behoben, siehe oben).
- Leere Historie: „Erfasst: 0 % · Datenlücke …“ statt Null-Tag.
- HTTP-Fehler (500 auf Tagesdaten): Fehlerhinweis mit „Erneut laden“.
- Langsame Antwort: „Gestern“ 3 s verzögert, danach „Heute“ → Heute bleibt.
- Serverausfall und stummer SSE-Strom: Kennzeichnung, stehende Animationen,
  Wiederverbindung ohne Neuladen.
- PWA-Update: Übergang v74→v75 automatisch, danach Hinweis und Übernahme per
  „Neu laden“.
- Stopp während eines verzögerten Befehls gewinnt; Reglervorschau bleibt über
  Live-Updates erhalten; Fokus bleibt.
- Mobil 360/390, Tablet 768, Desktop 1440: kein horizontaler Seitenüberlauf
  (die Diagrammlegende scrollt auf dem Handy absichtlich seitlich). Hell und
  Dunkel mobil fotografisch geprüft.

## Vor dem ersten Deploy (Migrationen und Konfiguration)

1. **Lademodus neu wählen:** Nach dem Update gibt es noch keine gespeicherte
   Wahl → die Wallbox lädt **nicht**, bis in der App einmal „Intelligent“ oder
   „Manuell“ gewählt ist. Direkt nach dem Deploy erledigen.
2. **config.json:** wird ab jetzt nicht mehr vom Repository überschrieben.
   Änderungen daran direkt auf dem Server vornehmen.
3. Neue optionale Einstellung `trustedProxies` (Vorgabe `["127.0.0.1","::1"]`,
   passend für den Cloudflare-Tunnel auf demselben Rechner).
4. Dateiformate (werden beim Laden automatisch übernommen, alte Dateien bleiben
   lesbar): `tariff.json` Fassung 2 (Tarifhistorie), Ladeprotokoll Fassung 3,
   Historie Fassung 2, `lademodus.json` neu, `sitzungen-gesperrt.flag` nur im
   Notfall (steht in `.gitignore`).
5. Docker (nur falls genutzt): `SMARTHOME_KONTEN=/app/data/konten.json`; der
   erste Start übernimmt die Konten aus `secrets.json`.
6. Der neue Deploy-Workflow legt `C:\SmartHome-neu` und `C:\SmartHome-vorher`
   an; der Runner braucht dort Schreibrechte.

## Offene Grenzen — ehrlich

- **Deploy-Workflow ungetestet:** Er ist nur statisch geprüft; Vorbereiten,
  Rückkehr und Abbruch wurden nicht auf dem echten Runner ausgeführt. Das
  Probeladen (`tsx -e import(...)`) läuft nur bei geändertem Lockfile.
- **Keine Prüfung an der echten Anlage:** weder Fronius/Victron noch die
  Tuya-Wallbox. Tuya-Latenz und -Abfragetakt sind unverändert; „Netzbezug
  vermeiden“ ist ein Regelziel, keine Garantie.
- Wallbox-Zustand nach Wiederkehr: Der Kurzstatus folgt sofort dem
  Live-Zustand, das Regelurteil aber erst mit der nächsten Regelprüfung
  (zeigt bis dahin „Regelung gestört“ statt „nicht erreichbar“).
- Die Kopfzeile kennt nur Verbindungen, nicht jeden einzelnen Messwert;
  Detailgründe stehen in den Gerätezeilen.
- 200 % Zoom nur über die entsprechende CSS-Breite (~720 px) geprüft, nicht mit
  echter Browser-Vergrösserung. Screenreader nicht getestet.
- `app.js` ist nicht in Module aufgeteilt (Auftrag: nur mit funktionalem
  Grund); weiterhin eine grosse Datei.
- Sitzungswiderruf: Schlagen Speichern und Marker gleichzeitig fehl, ist ein
  Widerruf nach Neustart nicht garantiert — das wird in der Verwaltung
  angezeigt, nicht verschwiegen.
- Der Service Worker gilt pro Browser; ein Gerät, das die App wochenlang nicht
  öffnet, sieht beim nächsten Start einmal den Hinweis „Neue Version“.
