# Anlagen-Inventar: tatsächlich gefundene Hardware

Stand: 2026-08-18, ermittelt durch `npm run discover` im Netz `192.168.178.0/24`.
Erfüllt Anforderung **4W** (Hardware-Inventur) und **4X** (automatische Discovery).

> Alle Werte in diesem Dokument sind gemessen, nicht angenommen.
> Rohbericht: `discovery-report.json` (nicht in Git).

---

## 1. Übersicht

| Adresse | Gerät | Status |
| --- | --- | --- |
| `192.168.178.121` | Fronius **Symo 5.0-3-M** + Datamanager 2.0 | Solar API **aktiv** |
| `192.168.178.39` | Fronius, zweites Gerät (nginx, „Fronius Inverter") | Solar API **deaktiviert** |
| `192.168.178.73` | Victron GX (Venus OS, nginx 1.24.0) | **Modbus TCP aktiv**, MQTT aus |

Weitere erreichbare Hosts im Netz, nicht zum Energiesystem zugeordnet:
`.1` (Router), `.44` (TwistedWeb), `.55`, `.110`, `.143`.

---

## 2. Fronius Symo 5.0-3-M — `192.168.178.121`

Ausgelesen über die lokale Solar API V1.

| Merkmal | Wert |
| --- | --- |
| Modell | Symo 5.0-3-M |
| Device Type (DT) | 122 |
| Seriennummer | 32633714 |
| UniqueID | 1890380 |
| PV-Nennleistung | 5670 W |
| Statuscode | 7 (Betrieb), ErrorCode 0 |
| Datalogger | `fronius-datamanager-card`, HW 2.4E, **SW 3.34.1-5** |
| Zeitzone | Vienna (CEST, UTC+2) |
| Solar API | Version 1, Compatibility Range 1.8-1 |
| Gesamterzeugung | 26.381,3 kWh |

### Angeschlossene Geräte laut `GetActiveDeviceInfo?DeviceClass=System`

```
Inverter      : { "1": { DT: 122, Serial: "32633714" } }
Meter         : {}     <- leer
Storage       : {}     <- leer
Ohmpilot      : {}
SensorCard    : {}
StringControl : {}
```

### Konsequenz

`Site.Mode` meldet **`produce-only`**. Laut offizieller Doku bedeutet das
wörtlich „inverter only" — kein Zähler, keine Batterie.

Damit liefert dieser Wechselrichter:

- ✅ `P_PV` — eigene PV-Leistung
- ✅ `E_Day`, `E_Total` — Erzeugungszähler (E_Day funktioniert, also SnapInverter-Linie)
- ❌ `P_Grid` — **null**
- ❌ `P_Load` — **null**
- ❌ `P_Akku` — **null**
- ❌ `rel_SelfConsumption`, `rel_Autonomy` — **null**

**Der in Abschnitt 4B beschriebene 12-kWh-Speicher hängt nicht an diesem Gerät.**
Ein Symo 5.0-3-M ist ein Non-Hybrid-SnapInverter und kann keine DC-gekoppelte
Fronius-Batterie führen.

Das Gerät sagt es selbst. `GetStorageRealtimeData.cgi?Scope=System` antwortet:

```json
"Status": {
  "Code": 255,
  "Reason": "GetStorageRealtimeData request is not supported by this device."
}
```

Das ist kein leeres Ergebnis, sondern eine ausdrückliche Ablehnung — der
Wechselrichter kennt den Batterie-Endpunkt überhaupt nicht.

---

## 3. Fronius, zweites Gerät — `192.168.178.39`

Antwortet auf HTTP und HTTPS mit:

```
HTTP/1.1 404 Not Found
Server: nginx

SolarAPI disabled by customer config
```

Das ist exakt die in der Doku (Abschnitt 3) beschriebene Antwort bei
deaktivierter Solar API. Der nginx-Webserver und der Seitentitel
„Fronius Inverter" sprechen für ein Gerät der **GEN24-Linie**
(der Datamanager der SnapInverter meldet sich anders).

**Dies ist mit hoher Wahrscheinlichkeit das Gerät, an dem der Fronius Smart
Meter und der ~12-kWh-Speicher hängen.** Bestätigen lässt sich das erst nach
Aktivierung der Solar API.

### Es gibt aktuell keinen anderen Weg zu diesem Gerät

Portprüfung auf `192.168.178.39`:

| Port | Dienst | Status |
| --- | --- | --- |
| 80, 443 | WebUI | offen |
| 502 | Modbus TCP | **geschlossen** |
| 1502 | Modbus TCP (alternativ) | **geschlossen** |
| 1883, 8883 | MQTT | **geschlossen** |

Weder Modbus TCP noch MQTT sind aktiviert. Die Solar API ist damit der
einzige Weg zu diesem Wechselrichter und zu allem, was daran hängt.

### Erforderliche Aktion

Im WebUI von `192.168.178.39` unter **Kommunikation → Solar API** aktivieren.
Danach `npm run discover` erneut ausführen. Das ist ein reiner Lesezugriff
und ändert nichts am Anlagenbetrieb.

---

## 4. Victron GX — `192.168.178.73`

Modbus TCP war bereits aktiviert. Ausgelesen mit Unit-ID 100
(`com.victronenergy.system`) anhand der offiziellen Registerliste.

| Merkmal | Wert |
| --- | --- |
| System-Serial (Register 800) | `c0619abd1723` (MAC-Adresse des GX) |
| Batteriespannung (840) | ~56 V → 48-V-System |
| Batterie-SOC (843) | 100 % |
| Batteriezustand (844) | wechselnd charging/discharging |
| Batteriedienst | Unit-ID **225** |
| VE.Bus-/Multi-Dienst | Unit-ID **228** |
| PV-Wechselrichter-Dienst | Unit-ID **20** |

### Gemessener Energiefluss (Beispielabtastung)

```
Netz            [908] :  -27 W   (-72 / -11 / 56)   negativ = Einspeisung
Hausverbrauch   [902] :  754 W   (138 / 274 / 342)
PV AC am Eingang[890] :  854 W   (283 / 285 / 286)
PV AC am Ausgang[884] :    0 W
PV DC-gekoppelt [850] :    0 W
```

Die Energiebilanz geht auf: PV 854 − Verbrauch 754 − Batterieladung 72 ≈ Netz −27 W.
Das GX-System sieht damit **die vollständige Hausbilanz**, nicht nur einen Teilbereich.

### ⚠️ Der wichtigste Fund des gesamten Projekts

Der PV-Wechselrichter-Dienst auf Unit-ID 20 meldet:

```
Serial       [1039] : 32633714
Position     [1026] : AC input 1
Total Power  [1052] : 854 W
```

**Seriennummer 32633714 ist exakt der Fronius Symo aus Abschnitt 2.**

Das Victron-System liest den Fronius Symo also bereits selbst aus und führt
ihn als AC-gekoppelten PV-Wechselrichter am Netzeingang. Zum selben Zeitpunkt
meldete die Fronius Solar API direkt `P_PV = 836 W` und Victron `854 W` — das
ist derselbe physikalische Wechselrichter über zwei Wege.

Würde man beide Quellen addieren, ergäbe das rund **1,7 kW PV bei tatsächlich
0,85 kW**. Genau die in **4L** beschriebene Doppelzählung, hier empirisch belegt.

### Batteriekapazität

Register 309 (`/Capacity`) meldet **0 Ah**. Das Batteriesystem gibt seine
Kapazität nicht über Modbus preis. Die nutzbare Kapazität (~50 kWh laut
Abschnitt 4E) muss daher **manuell konfigurierbar** sein — wie in **4J**
ohnehin gefordert. Der SOC von 100 % ist plausibel, die Kapazität ist es
nicht ableitbar.

---

## 4a. GEN24 nachträglich angebunden (18.08.2026)

Nach Aktivierung der Solar API am GEN24 (`192.168.178.39`) ist das Hybrid-System
vollständig auslesbar:

| Merkmal | Wert |
| --- | --- |
| Wechselrichter | GEN24, DT 1, Serial 34475741 |
| Modus | `bidirectional` (Wechselrichter + Zähler + Batterie) |
| Smart Meter | **Fronius Smart Meter TS 65A-3**, Serial 3262842287, Location „grid" (Netz-Einspeisepunkt) |
| Batterie | **BYD Battery-Box Premium HV**, Serial P030T020Z2308181718 |
| Nennkapazität | 11.059 Wh (Gerät meldet sie selbst) |
| Spannung | 214,7 V |

### Empirisch bestätigte Vorzeichen (stabile Messreihe)

| Feld | Messwert | Konvention |
| --- | --- | --- |
| `P_Grid` = `PowerReal_P_Sum` | −1518 W | **negativ = Einspeisung**. Doku stimmt. |
| `P_Load` | **+265 W** (Haus zieht ~265 W) | **positiv = Verbrauch**. Doku-Notiz „− = consumer" ist irreführend. |
| `P_Akku` / `Current_DC` | ~0 (Batterie voll) | negativ / positiv = Laden (siehe 4O) |

### Topologie geklärt

Gleichzeitiger Schnappschuss aus allen drei Systemen:

| Messung | Fronius | Victron | Ergebnis |
| --- | --- | --- | --- |
| Netz | −1518 W | −1501 W | **identisch → derselbe Netzpunkt** |
| Symo-PV | 601 W | 601 W (als AC-PV) | **identisch → Symo doppelt gemeldet** |
| GEN24-PV | 1362 W | wird nicht gesehen | **nur Fronius** |

Damit steht fest:

- **Netz** wird von Fronius-Zähler UND Victron gemessen → nur **eine** Quelle nehmen.
- **Symo-PV** wird von Symo-API UND Victron gemessen → nur **eine** Quelle nehmen.
- **Gesamt-PV** = GEN24 + Symo (zwei verschiedene Wechselrichter) → **summieren**.
- **Hausverbrauch** misst kein Gerät vollständig (GEN24 `P_Load` untererfasst den
  Symo) → aus der **Energiebilanz berechnen**.

## 5. Umgesetztes Source-of-Truth-Mapping (4L / 4M)

Nach Anbindung des GEN24 gilt das folgende, in `config.json` umgesetzte Mapping:

| Messgröße | Behandlung | Quelle(n) | Begründung |
| --- | --- | --- | --- |
| PV-Produktion gesamt | **Summe** | `fronius-gen24` + `fronius-local` (Symo) | Zwei verschiedene Wechselrichter, jeder einmal |
| Netzbezug / Netzeinspeisung | eine Quelle | `fronius-gen24` (Smart Meter TS 65A-3) | Echter Zähler am Netz-Einspeisepunkt |
| Hausverbrauch | **berechnet** | Energiebilanz | Kein Gerät misst den Gesamtverbrauch allein |
| Speicher ~12 kWh | eine Quelle | `fronius-gen24` (BYD) | Einzige Quelle |
| Speicher ~50 kWh | eine Quelle | `victron-modbus` | Einzige Quelle |

Victron bleibt als Quelle für den großen Speicher und als Gegenprobe für Netz
und Symo-PV aktiv, wird aber bewusst **nicht** für die PV-Summe oder das Netz
herangezogen — sonst würden Symo und Netz doppelt gezählt.

**Ergebnis der Umstellung:** Die Energiebilanz schließt jetzt (Residual wenige
Watt). Die zuvor offene ~2-kW-Lücke stammte allein aus der nicht erfassten
GEN24-Erzeugung.

---

## 6. Vorzeichenkonventionen, empirisch bestätigt

| Quelle | Feld | Konvention | Beleg |
| --- | --- | --- | --- |
| Fronius | `Site.P_Grid` | + = Bezug, − = Einspeisung | Doku |
| Fronius | `Site.P_Load` | − = Hausverbrauch | Doku |
| Fronius | `Site.P_Akku` | − = Laden, + = Entladen | Doku |
| Fronius | `Current_DC` (Storage) | + = Laden | Doku |
| Victron | Register 842 `/Dc/Battery/Power` | **+ = Laden, − = Entladen** | gemessen: +72 W bei Zustand `charging` |
| Victron | Register 908 `/Ac/Grid/L*/Power` | + = Bezug, − = Einspeisung | gemessen: −27 W bei PV-Überschuss |

**Fronius und Victron verwenden bei der Batterieleistung gegensätzliche
Vorzeichen.** Genau der in **4O** beschriebene Fall — beide Adapter müssen
zwingend über `splitBatteryPower()` normalisieren.

---

## 7. Offene Punkte

1. **Solar API auf `.39` aktivieren** — schließt die Lücke bei 12-kWh-Speicher
   und Fronius Smart Meter. Höchste Priorität.
2. **Nutzbare Kapazität des Victron-Speichers** bestätigen (~50 kWh laut 4E,
   über Modbus nicht auslesbar).
3. **GX-Modell** (Cerbo GX / Ekrano GX / Venus GX) und Venus-OS-Version —
   entscheidet, ob MQTT ab 3.20 als Push-Quelle verfügbar ist.
4. **MQTT am GX aktivieren** (Einstellungen → Dienste → MQTT) — würde Polling
   durch Push ersetzen.
5. **VRM Access Token** — für Historie, Alarme und Fernzugriff.
6. **Wird die GEN24-PV im Victron-System erfasst?** Aktuell kennt Victron nur
   einen PV-Wechselrichter (den Symo). Falls der GEN24 hinter demselben
   Netzanschluss einspeist, ist seine Produktion derzeit in **keiner** Quelle
   sichtbar.
