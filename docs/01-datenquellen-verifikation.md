# Datenquellen-Verifikation: Fronius & Victron

Stand: 2026-08-18
Grundlage: ausschließlich offizielle Herstellerdokumentation (Quellen am Ende).
Dieses Dokument erfüllt Anforderung **4AB** (Verifikation vor Implementierung).

> Regel für dieses Projekt: Was hier nicht belegt ist, wird nicht implementiert.
> Keine geratenen Endpunkte, keine angenommenen Modbus-Register.

---

## 1. Fronius — Lokale Solar API V1

**Status: OK — offiziell dokumentiert, kostenlos, lokal, keine Cloud nötig.**
Quelle: Fronius Solar API V1 Operating Instructions, Dok.-Nr. `42,0410,2012,EN` (Rev. 05/2025).

### 1.1 Verifizierte Endpunkte

| Pfad | Zweck |
| --- | --- |
| `/solar_api/GetAPIVersion.cgi` | API-Version + `BaseURL` (Einstiegspunkt für Discovery) |
| `/solar_api/v1/GetPowerFlowRealtimeData.fcgi` | Energiefluss gesamt (PV, Netz, Last, Batterie) |
| `/solar_api/v1/GetInverterRealtimeData.cgi` | Wechselrichter-Detaildaten |
| `/solar_api/v1/GetInverterInfo.cgi` | Wechselrichter-Inventar + Statuscodes |
| `/solar_api/v1/GetActiveDeviceInfo.cgi` | **Device Discovery** (aktive Geräte je DeviceClass) |
| `/solar_api/v1/GetMeterRealtimeData.cgi` | Smart-Meter-Werte |
| `/solar_api/v1/GetStorageRealtimeData.cgi` | Batteriespeicher (SOC, Kapazität, Strom, Spannung) |
| `/solar_api/v1/GetOhmPilotRealtimeData.cgi` | Ohmpilot (falls vorhanden) |
| `/solar_api/v1/GetArchiveData.cgi` | Historische Werte |
| `/solar_api/v1/GetLoggerInfo.cgi` | Zeitzone, Einheiten, Logger-Metadaten |

Zusätzlich stellt Fronius für **GEN24 / Tauro / Verto** eine OpenAPI-Spec bereit
(`https://www.fronius.com/QR-link/0025`) — die nutzen wir zur Client-Generierung und Validierung.

### 1.2 Kritische Randbedingungen

1. **Die Solar API ist auf GEN24 ab Bundle-Version 1.14.1 werkseitig DEAKTIVIERT.**
   Aktivierung im Wechselrichter-WebUI unter **Kommunikation → Solar API**.
   Ist sie aus, liefert jeder Request **HTTP 404** mit der Meldung
   `Solar API disabled by customer config`.
   → Muss im Connection-Wizard als eigener, erklärter Fehlerfall behandelt werden.
2. **HTTP vs. HTTPS:** GEN24/Tauro/Verto ab FW 1.35 bieten zusätzlich HTTPS (EN 303645).
   Das Zertifikat ist von Fronius selbst signiert, also nicht per Default vertrauenswürdig.
   In privaten IP-Bereichen (`10.x`, `172.16–31.x`, `192.168.x`) bleibt HTTP erlaubt;
   außerhalb wird auf HTTPS umgeleitet.
   → Der Adapter braucht eine bewusste TLS-Policy (Pinning oder explizites Opt-in),
   kein pauschales Abschalten der Zertifikatsprüfung.
3. **Keine System-Requests über mehrere GEN24 hinweg.** Bei mehreren GEN24/Tauro/Verto muss
   jeder Wechselrichter einzeln abgefragt werden. Der Adapter darf nicht „genau ein Gerät"
   annehmen (**4X**).
4. **Authentifizierung:** Die Solar API kennt keine. Sie ist reiner LAN-Lesezugriff.
   → Absicherung über Netzwerksegmentierung, nicht über Credentials.

### 1.3 Vorzeichenkonventionen — direkt relevant für 4O

Aus `GetPowerFlowRealtimeData`, Objekt `Site`, wörtlich aus der Doku:

| Feld | Konvention laut Fronius | Bedeutung |
| --- | --- | --- |
| `P_Grid` | `+ from grid`, `- to grid` | **positiv = Netzbezug**, negativ = Einspeisung |
| `P_Load` | `+ generator`, `- consumer` | **negativ = Hausverbrauch** (!) |
| `P_Akku` | `- charge`, `+ discharge` | **negativ = Laden** (!) |
| `P_PV` | `+ production` | positiv = Erzeugung |

Das ist exakt die Falle aus **4O**: `P_Load` und `P_Akku` sind gegenüber der Intuition invertiert.
Der Fronius-Adapter muss diese Werte zwingend nach `gridImportW` / `gridExportW` /
`batteryChargeW` / `batteryDischargeW` / `houseConsumptionW` übersetzen.
Rohwerte dürfen das Dashboard nie erreichen.

Weitere Fallstricke:

- `P_PV` meldet auf **GEN24 und Symo Hybrid die DC-Seite** (PV-Generator), auf SnapInverter
  die AC-Seite. Bei GEN24 ist PV-Leistung also nicht identisch mit der AC-Ausgangsleistung.
- `E_Day` und `E_Year` sind auf **GEN24/Tauro/Verto immer `null`**. Die Tageserzeugung muss
  dort anders hergeleitet werden (Archive-Request oder eigene Integration).
- `E_Total` existiert auf GEN24 erst ab FW 1.14 und wird **nur alle 5 Minuten** aktualisiert.
- `P_Grid`, `P_Load`, `rel_SelfConsumption`, `rel_Autonomy` sind `null`, wenn kein Smart Meter
  aktiv ist.
- `Meter_Location` (`load` / `grid` / `unknown`) entscheidet über die korrekte Interpretation
  der Zählerwerte — die Doku hat dafür eigene Abschnitte
  („Meter Location Dependend Directions", primär und sekundär).

### 1.4 Batteriespeicher (12 kWh)

`GetStorageRealtimeData.cgi` liefert unter anderem:
`StateOfCharge_Relative` (%), `Capacity_Maximum`, `DesignedCapacity`,
`Current_DC` (**+ = laden**), `Voltage_DC`, `Temperature_Cell`, `TimeStamp`, `Enable`.

Offiziell unterstützt laut Doku: Fronius Solar Battery (Symo Hybrid), Fronius Reserva
(GEN24/Verto), BYD Battery-Box HV, LG Chem RESU H, LG RESU Flex (GEN24/Verto).
Welche Kanäle tatsächlich geliefert werden, hängt vom Batteriehersteller ab —
nicht alle Felder sind bei allen Modellen vorhanden.

---

## 2. Fronius — Solar.web Query API (Cloud)

**Status: Achtung — kostenpflichtig und nur für Geschäftskunden.**

Verifizierte Bedingungen (fronius.com/en/solarweb-query-api/api-access):

- Nutzung ist **auf Business-Partner / Firmenkunden beschränkt**.
- **Demo-Zugang:** kostenlos, zeitlich begrenzt, **nur Beispielanlagen** — nicht die eigene Anlage.
- **Zugang zur eigenen Anlage:** Vertrag und Registrierung erforderlich, **kostenpflichtig**,
  monatliche Abrechnung nach Datenpunkten (Staffeln von 500.000 bis 60.000.000 Datenpunkte/Monat).
- API-Key-Verwaltung: Solar.web → Benutzereinstellungen → REST API Settings → Key ID + Secret.
- **Kein OAuth.** Im Wizard darf daher auch kein OAuth-Flow gebaut werden (**4D**).

**Empfehlung:** Für ein privates Haussystem lohnt sich das nicht. Die lokale Solar API deckt
alle in **4B** geforderten Live-Werte ab. Solar.web bleibt in der Architektur als optionaler
Adapter vorgesehen, wird aber **nicht implementiert**, solange kein Vertrag besteht.
Scraping des Solar.web-Logins ist laut **4B** ausgeschlossen und wird nicht gebaut.

---

## 3. Victron — VRM API (Cloud)

**Status: OK — offiziell dokumentiert, öffentlich zugänglich, ohne Zusatzkosten.**
Quelle: offizielle OpenAPI-3.1-Spec unter `vrm-api-docs.victronenergy.com`.

- **Base URL:** `https://vrmapi.victronenergy.com/v2`
- **Authentifizierung:** Header `x-authorization: Token <token_value>`
  - Access Token anlegen: `POST /users/{idUser}/accesstokens` mit Body `{"name": "..."}`,
    optional `expiry` (Unix-Timestamp).
  - **Der Token wird genau einmal zurückgegeben und ist danach nie wieder abrufbar.**
  - **`Bearer <token>` ist seit 01.06.2026 deprecated.** Wir implementieren ausschließlich `Token`.
- **Rate Limit:** Rolling Window von max. 200 Requests, alle 0,33 s fällt einer heraus
  → im Mittel **maximal ca. 3 Requests pro Sekunde**. Bei HTTP 429 nennt der
  `Retry-After`-Header die Wartezeit in Sekunden.

### 3.1 Relevante Endpunkte

| Endpunkt | Nutzen im Projekt |
| --- | --- |
| `GET /users/me` | liefert die eigene `idUser` |
| `GET /users/{idUser}/installations` | Installationsliste → Auswahl im Wizard (**4I**) |
| `GET /installations/{idSite}/system-overview` | **Geräteliste** (Name, Produktcode, Firmware, Instance, `lastConnection`) → Device Discovery (**4I**, **4X**) |
| `GET /installations/{idSite}/diagnostics` | **Aktuellste Messwerte je Datenattribut**, mit `code`, `dbusServiceType`, `dbusPath`, `rawValue`, `formattedValue`, `timestamp`, `instance`. Tragende Live-Quelle über die Cloud. Parameter `count`, `page`. |
| `GET /installations/{idSite}/stats` | Zeitreihen. `type=venus\|live_feed\|consumption\|solar_yield\|kwh\|generator\|forecast\|custom`, `interval=15mins…years`. Bei `custom` mit `attributeCodes[]`. |
| `GET /installations/{idSite}/overallstats` | Lifetime-Summen |
| `GET /installations/{idSite}/alarms`, `/alarm-log` | Alarme (**4G**) |

Maximale Zeiträume für `stats`: 31 Tage bei `15mins` und `hours`, 180 Tage bei `days`,
140 Tage bei `weeks`, 24 Monate bei `months`, 5 Jahre bei `years`.

### 3.2 Hinweis von Victron selbst

Victron schreibt in der Doku ausdrücklich, dass die API zwar öffentlich verfügbar ist, für
Endkunden aber **kein Support** dafür geleistet wird. Das ist kein Blocker — aber wir dürfen
uns nicht darauf verlassen, dass Feldnamen dauerhaft stabil bleiben. Der Adapter braucht
defensives Parsing und muss unbekannte Attribute überspringen statt zu scheitern.

---

## 4. Victron — Lokaler Zugriff über das GX-Gerät

Zwei offiziell dokumentierte Wege, beide kostenlos und ohne Cloud.

### 4.1 MQTT — empfohlen für Live-Daten

Seit **Venus OS 3.20** über `dbus-flashmq` integriert; der alte `dbus-mqtt` ist archiviert.

- Aktivierung: **Einstellungen → Dienste → MQTT** am GX-Gerät.
- Lokaler Broker: Port **1883** (unverschlüsselt), Port **8883** (TLS).
- Topic-Schema: `<PREFIX>/<portal ID>/<service_type>/<device instance>/<D-Bus path>`
  - `N/` = Notification (Wertänderung), `W/` = Write, `R/` = Read-Request
  - Beispiel: `N/<portal ID>/pvinverter/20/Ac/Power` mit Payload `{"value": 936}`
- **Keepalive ist Pflicht:** alle **unter 60 s** auf `R/<portal ID>/keepalive` publizieren,
  sonst versiegt der Datenstrom. Den Abschluss eines Full-Publish signalisiert
  `N/<portal ID>/full_publish_completed`.
- Portal ID: GX → Einstellungen → VRM Online Portal → VRM Portal ID.
- **Kein Auth per Default** — nur in vertrauenswürdigen Netzen aktivieren.

Damit bekommen wir **Push statt Polling** und umgehen das VRM-Rate-Limit vollständig.
Wir schreiben ausschließlich über `R/` (Keepalive) — `W/` wird in diesem Projekt nicht benutzt,
das System bleibt read-only.

### 4.2 Modbus TCP — Alternative

- Aktivierung: **Einstellungen → Dienste → Modbus/TCP**, per Default aus.
- Die Unit-ID wählt das Zielgerät; **Unit-ID 100 = systemweite Daten** (von Victron bevorzugt
  gegenüber ID 0).
- Offizielle Registerliste: `CCGX-Modbus-TCP-register-list.xlsx`
  (Repo `victronenergy/dbus_modbustcp` bzw. Whitepapers-Bereich auf victronenergy.com).
- Nicht alle Register existieren auf jedem Gerät — Bulk-Reads über nicht vorhandene Register
  vermeiden. Parallel- und Dreiphasen-Einheiten sind nicht einzeln adressierbar.
- **Register werden erst nach Bestätigung der Hardware aus der offiziellen XLSX übernommen,
  nicht aus dem Gedächtnis.**

---

## 5. Ableitung für die Live-Daten-Strategie (4Q)

| Messgröße | Primärquelle (Live) | Fallback | Historie |
| --- | --- | --- | --- |
| PV, Hausverbrauch, Netz, 12-kWh-Batterie | Fronius Solar API (lokal, LAN) | — (Solar.web nur mit Vertrag) | Fronius `GetArchiveData` |
| 50-kWh-Batterie, Victron-Systemdaten | GX MQTT lokal (Push) | VRM `diagnostics` (max. ~3 req/s) | VRM `stats` |

**Wichtig:** VRM ist wegen des Rate-Limits von rund 3 Requests/Sekunde **nicht** als
Sekundentakt-Livequelle für ein Dashboard geeignet. Für flüssige Live-Werte brauchen wir den
lokalen MQTT-Zugang zum GX-Gerät. Ist das GX-Gerät nicht im selben Netz erreichbar, muss das
Dashboard bei Victron auf ein längeres Aktualisierungsintervall gehen — und das laut **4P**
auch ehrlich als solches anzeigen.

---

## 6. Offene Punkte

Die Hardware-Inventur nach **4W** steht noch aus. Ohne sie bleibt offen:

- Fronius-Generation (GEN24/Tauro/Verto vs. SnapInverter/Symo Hybrid) → entscheidet über
  `E_Day`-Verfügbarkeit, DC-/AC-Bedeutung von `P_PV` und Multi-Inverter-Handling.
- GX-Modell und Venus-OS-Version → entscheidet, ob MQTT (ab 3.20) verfügbar ist.
- **Elektrische Topologie** → entscheidet über das Source-of-Truth-Mapping (**4L**).

---

## Quellen

- Fronius Solar API V1 Operating Instructions (42,0410,2012,EN, Rev. 05/2025) —
  <https://www.fronius.com/~/downloads/Solar%20Energy/Operating%20Instructions/42,0410,2012.pdf>
- Fronius Solar.web Query API, API-Zugang —
  <https://www.fronius.com/en/solarweb-query-api/api-access>
- Victron VRM API, offizielle OpenAPI-Spec —
  <https://vrm-api-docs.victronenergy.com/>
- Victron `dbus-flashmq` (MQTT auf Venus OS ab 3.20) —
  <https://github.com/victronenergy/dbus-flashmq>
- Victron GX Modbus-TCP Manual —
  <https://www.victronenergy.com/live/ccgx:modbustcp_faq>
