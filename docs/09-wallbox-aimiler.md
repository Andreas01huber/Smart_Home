# 09 – Aimiler EV Charger (Wallbox) — Integration

Read-only-Anbindung des mobilen Ladegeräts „Aimiler EV Charger“ an SmartHome.
Stand: 26.08.2026. **Es werden ausschliesslich Daten gelesen — nie gesteuert.**

---

## Gerät

| | |
| --- | --- |
| Produkt | Aimiler EV Charger (Tuya-Kategorie `qccdz`) |
| Device ID | `bf90221e7d69b1ec315154` |
| Ladestrom | 6–16 A, einphasig (≈ 3,7 kW max.) |
| App | „Smart Life“ (Tuya) |
| Lokale IPs im Netz | zwei Tuya-Geräte gefunden: `192.168.178.27`, `192.168.178.125` (das zweite ist der Rauchmelder) |

## Warum Cloud statt lokal

Der lokale Tuya-Port **6668 ist offen**, das Gerät beantwortet aber **keines** der
Standardprotokolle:

| Versuch | Ergebnis |
| --- | --- |
| Protokoll 3.3 (AES-ECB) | keine bzw. nicht entschlüsselbare Antwort |
| Protokoll 3.4 (Sitzungsschlüssel) | keine Aushandlung |
| Protokoll 3.5 (AES-GCM) | Verbindung wird abgebrochen (ECONNRESET) |

Die **Cloud-Abfrage funktioniert dagegen zuverlässig** (~440 ms). Deshalb wurde
sie gewählt — der Zugriff ist in `TuyaCloudClient` gekapselt, sodass ein lokaler
Transport später eingesetzt werden kann, **ohne** den Connector zu ändern.

> Die lokale Anbindung bleibt das Ziel, sobald bekannt ist, welche Protokoll­variante
> die Firmware spricht (z. B. nach einem Firmware-Update).

## Read-only — wie es erzwungen wird

`TuyaCloudClient` besitzt **ausschliesslich** eine private `get()`-Methode. Es
existiert keine Funktion, die POST/PUT sendet. Ein Steuerbefehl ist damit nicht
nur „nicht vorgesehen“, sondern technisch nicht möglich, ohne die Klasse zu
erweitern.

Das Gerät bietet Steuerfunktionen an (`switch`, `charge_cur_set`, `work_mode`) —
diese werden **bewusst nicht verwendet**. `charge_cur_set` wird nur *angezeigt*.

## Gelesene Datenpunkte (vom Gerät selbst gemeldete Spezifikation)

| Datenpunkt | Typ | Umrechnung | Anzeige |
| --- | --- | --- | --- |
| `work_state` | Enum (8 Werte) | → Zustand | Bereit / Angeschlossen / Lädt / … |
| `connection_state` | Enum | Control Pilot → Fahrzeug angeschlossen | „Angeschlossen“ / „Nicht angeschlossen“ |
| `power_total` | Integer, kW, scale 3 | W = Rohwert | Ladeleistung |
| `forward_energy_total` | Integer, kW·h, scale 2 | Wh = Rohwert × 10 | Gesamt geladen |
| `charge_energy_once` | Integer, kW·h, scale 2 | Wh = Rohwert × 10 | Ladevorgang |
| `temp_current` | Integer, °C | direkt | Temperatur |
| `charge_cur_set` | Integer, A (6–16) | direkt | Max. Ladestrom (nur Anzeige) |

### `connection_state` = Control Pilot (IEC 61851)

| Wert | Bedeutung |
| --- | --- |
| `controlpi_12v(_pwm)` | kein Fahrzeug |
| `controlpi_9v(_pwm)` | Fahrzeug angeschlossen |
| `controlpi_6v(_pwm)` | Fahrzeug lädt |
| `controlpi_error` | Kommunikationsfehler → Zustand **unbekannt**, nicht „nicht angeschlossen“ |

## ❗ Fahrzeug-Ladestand (SOC) — nicht verfügbar

**Der Charger kennt den SOC nicht — technisch unmöglich, nicht bloss
„nicht implementiert“.**

AC-Laden nach IEC 61851 kommuniziert nur über das Control-Pilot-Signal:
Der Charger teilt dem Auto den maximal verfügbaren Strom mit, das Auto meldet
über Widerstandswerte seinen Zustand (kein Fahrzeug / verbunden / lädt). **Einen
Datenkanal für den Ladestand gibt es dabei nicht.** SOC-Übertragung bräuchte
ISO 15118 („Plug & Charge“), das mobile Ladekabel praktisch nie beherrschen.

Die Geräte-Spezifikation bestätigt das: **kein SOC-Datenpunkt vorhanden.**

`vehicleSocPercent` ist daher **immer `null`** und wird durch einen Test
abgesichert. Die Oberfläche zeigt „nicht verfügbar“. Der Wert wird **niemals**
aus geladener Energie hochgerechnet oder geschätzt.

**Einzige mögliche Quelle:** das Fahrzeug selbst über die (inoffizielle)
Leapmotor-Cloud-API. Das wäre ein eigener Connector (`leapmotor-cloud`) und ist
bewusst noch nicht umgesetzt.

## Keine Doppelzählung (4L)

Die Wallbox hängt **hinter dem Hauszähler**. Ihre Ladeleistung ist im
`houseConsumptionW` (Modus `derived`) **bereits enthalten**.

Deshalb gilt:
- Die Ladeleistung wird in `resolveSnapshot` **nur durchgereicht**, nie addiert.
- In der Energiebilanz taucht sie **nicht** als zusätzliche Last auf.
- In der Historie wird `evChargeWh` **separat** mitgeschrieben (bisher immer 0)
  und ebenfalls **nicht** zum Hausverbrauch addiert.

Verifiziert: Nach dem Einbau meldet die Bilanz weiterhin `verdict: ok`,
Residuum 0 W.

## Zustände und Robustheit

| Situation | Anzeige |
| --- | --- |
| Wallbox nicht konfiguriert | „Nicht eingerichtet“ (kein Fehler) |
| Cloud nicht erreichbar | „Nicht erreichbar“, Status `offline`, Werte `—` |
| Charger da, kein Fahrzeug | **„Bereit“ / „Kein Fahrzeug angeschlossen“** ← aktueller Normalfall |
| Fahrzeug angeschlossen, lädt nicht | „Angeschlossen“ |
| Fahrzeug lädt | Ladeleistung in kW |
| Störung | „Störung“ + Klartext |
| Einzelne Felder fehlen | jeweils `—`, nie 0 |

Sobald das Auto angesteckt wird, erscheinen Ladeleistung und Sitzungsenergie
**automatisch** — keine zusätzliche Konfiguration nötig.

## Abfragetakt / Schonung des Kontingents

Die Engine pollt alle 2 s. Der Connector fragt die Cloud aber nur alle
**30 s** ab (im Ruhezustand) bzw. **10 s** während eines Ladevorgangs. Zwischen­
durch liefert er den Zwischenspeicher; die Abfrage läuft im Hintergrund und
bremst die anderen Quellen nie.

## Konfiguration

`config.json` → `sources.evCharger` (Gerät, Intervalle, Anzeigename).
Zugangsdaten stehen **getrennt** in `secrets.json` (per `.gitignore`
ausgeschlossen) und werden nie protokolliert.

## Offene Punkte

1. **`charge_energy_once`** — laut Spezifikation die Energie eines einzelnen
   Ladevorgangs; ob es die *gemessene* oder die *geplante* Menge ist, lässt sich
   erst mit einem echten Ladevorgang endgültig verifizieren. Bis dahin wird der
   Wert nur angezeigt, solange ein Fahrzeug angeschlossen ist.
2. **Fahrzeug-SOC** — nur über einen künftigen Leapmotor-Connector.
3. **Lokale Anbindung** — offen, siehe oben.
4. **Tuya-Cloud-Projekt** — Trial-Zeiträume laufen ab und müssen (kostenlos)
   verlängert werden, sonst endet die Abfrage. Ein weiterer Grund, die lokale
   Anbindung weiterzuverfolgen.

---

# Erweiterung: Ladeprotokoll, Statistik, Detailansicht (26.08.2026)

## Session-Erkennung

Maßgeblich ist der **Anschlusszustand** (Control Pilot), nicht die Ladeleistung:

```
vehicleConnected  false -> true   Session beginnt
vehicleConnected  true  -> false  Session endet (endReason "unplugged")
Ladegerät offline                 Session endet (endReason "interrupted")
```

Warum nicht über die Leistung? Eine Ladepause (Leistung kurz 0 W) würde sonst
fälschlich als zwei Ladevorgänge gezählt. Innerhalb einer Session werden
`connectedSeconds` (Steckzeit) und `chargingSeconds` (echte Ladezeit) **getrennt**
gezählt. Anstecken ohne nennenswerte Energie (< 10 Wh) gilt nicht als Ladevorgang.

Die Energie wird aus der Leistung **integriert (P·t)** statt aus dem Gerätezähler
übernommen — unabhängig von unklaren Zählerfeldern und deckungsgleich mit den
Zeitfenstern der Quellen-Zuordnung.

## Woher kam der Strom? (Energiequellen je Ladevorgang)

Strom ist nicht markierbar: Wenn PV, Batterie und Netz gleichzeitig liefern,
lässt sich **physikalisch nicht messen**, welches Elektron ins Auto floss. Jede
Aufteilung ist ein Modell. Verwendet wird das übliche Mischungsmodell, je
Messintervall:

```
pvToLoad  = PV − Einspeisung − Batterieladung        (was PV an Lasten liefert)
supply    = pvToLoad + Netzbezug + Σ Batterieentladung
Anteil_x  = Quelle_x / supply
```

Aus der Energiebilanz folgt `supply == Hausverbrauch`; die Anteile ergeben also
exakt die Ladeenergie. Jeder Speicher wird über seine **eigene** Entladeleistung
getrennt zugeordnet (Kleiner/Großer Speicher).

**Ehrlichkeit vor Vollständigkeit:** Fehlt ein Messwert oder ist `supply`
unplausibel (≤ 0), wird die Energie dieses Intervalls **nicht geraten**, sondern
als `unknownWh` ausgewiesen und in der Oberfläche als „nicht zuordenbar“
angezeigt. Die Session wird zusätzlich mit `hasGaps` markiert.

## Persistenz

`data/ev-sessions.json` — dieselbe Ablage wie die übrige Historie, **keine
zweite Datenbank**. Geschrieben bei Session-Ende, alle 60 s bei Änderungen und
beim Herunterfahren. Eine beim Beenden offene Session wird beim nächsten Start
als `interrupted` übernommen; ihre Daten gehen nicht verloren.

## API

| Endpunkt | Zweck |
| --- | --- |
| `GET /api/ev/sessions?limit=N` | laufender + letzte Ladevorgänge |
| `GET /api/ev/sessions/{id}` | ein Ladevorgang mit voller Aufteilung |
| `GET /api/ev/stats?range=day\|week\|month\|year\|total&date=` | Aggregat + Verlauf |
| `POST /api/devices/ev-charger/reconnect` | **nur Datenverbindung** (bereits vorhanden) |

## Oberfläche

Die Fahrzeug-Karte ist anklickbar (Maus, Tastatur, Escape zum Schliessen) und
öffnet eine Detailansicht: Live-Status · laufender/letzter Ladevorgang ·
Statistik mit Zeitraum-Umschalter und Balkendiagramm · Liste der Ladevorgänge
(aufklappbar mit Energieaufteilung).

Umgesetzt mit den vorhandenen Design-Variablen, `.vt-btn`-Umschaltern und der
gleichen Inline-SVG-Technik wie der Tagesverlauf — **keine neue Bibliothek**.
Auf dem Handy erscheint die Ansicht als Bottom-Sheet.

## Charger-Verbindung ≠ Fahrzeug-Verbindung

Bewusst getrennte Zustände, in der Detailansicht als eigene Kacheln:

| | |
| --- | --- |
| **Ladegerät** | Online / Offline — ist das Gerät erreichbar? |
| **Fahrzeug** | Verbunden / Nicht verbunden — hängt das Kabel am Auto? |

„Ladegerät online, Fahrzeug nicht verbunden“ ist der **Normalfall**, kein Fehler.

## Wiederfinden nach Aus- und Einstecken

Der Charger wird über seine **stabile Tuya-Geräte-ID** angesprochen, nicht über
eine IP. Ein Wechsel der lokalen IP-Adresse (DHCP) ist damit **irrelevant** —
das ist die robusteste verfügbare Zuordnung, mDNS oder MAC-Suche wären
schwächer.

Ablauf beim Ausstecken:
1. Die Cloud meldet `online: false` → Verbindung gilt als getrennt.
   **Wichtig:** Ohne diese Prüfung würde die Cloud die *letzten* Werte
   weiterliefern und die App veraltete Daten als aktuell zeigen.
2. Die Konfiguration bleibt vollständig erhalten.
3. `ManagedConnector` prüft mit Backoff (5/10/30/60 s) automatisch weiter.
4. Sobald das Gerät wieder meldet, wird automatisch reconnectet.
5. Live-Daten laufen weiter, eine unterbrochene Session ist sauber abgeschlossen.

Zusätzlich der Knopf **„Verbinden“ / „Verbunden“** auf der Karte: Er verwirft den
Zwischenspeicher (`invalidateCache`) und erzwingt eine echte Abfrage.
**Er stellt ausschliesslich die Datenverbindung her** — er startet oder stoppt
keinen Ladevorgang und ändert keine Einstellung.

## Weiterhin strikt read-only

`TuyaCloudClient` besitzt unverändert nur `get()`. Auch die Erweiterung sendet
keinen einzigen Schreibbefehl an das Ladegerät.

## Tests

101 Tests gesamt. Neu abgesichert:
- Anstecken → Laden → Abstecken = **eine** Session
- Ladepause erzeugt **keine** zweite Session
- kurzes Anstecken ohne Energie wird verworfen
- Quellenaufteilung (Netz / PV / zwei Speicher getrennt, anteilig)
- **kein Raten** bei fehlenden Messwerten → `unknownWh`
- Ausfall des Ladegeräts → Session sauber als `interrupted`
- **Sessions überleben einen Neustart**
- Statistik filtert korrekt nach Tag/Jahr
- ohne Ladegerät kein Absturz, keine Geister-Session
