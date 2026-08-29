# Historie, Tagesverlauf & Datensammlung

Stand: 2026-08-19. Diese Phase macht die App zum dauerhaften **Energiegedächtnis**
und liefert einen hochwertigen Tagesverlauf mit Datumsnavigation.

## 1. Datensammlung (dauerhaft, serverseitig)

Der `EnergyAccumulator` läuft im Server, angetrieben von der Engine
(`engine.subscribe → integrate`). Er läuft, **solange der Server läuft** —
unabhängig von Browser, Handy oder Login (Anforderung 2/49). Nach Serverneustart
startet er automatisch und stellt den heutigen Zwischenstand wieder her (50).

Erfasst wird alle ~2 s live; die **Tageskurve** wird im **1-Minuten-Raster**
gespeichert. Pro Punkt (`SeriesPoint`):

```
t, pv, house, gridImport, gridExport,
inv{ <connector>: W },              # PV je Wechselrichter
bat{ <deviceId>: { p, soc } },      # Netto-Leistung (+laden/−entladen) + SOC
socAgg                              # kapazitätsgewichteter Gesamt-SOC
```

Ein ausgefallener Connector stoppt die Sammlung der anderen **nicht** (51) —
fehlende Werte werden als `null` gespeichert, nicht als 0 (25).

## 2. Speicherstrategie (`data/`)

| Datei | Inhalt | Aufbewahrung |
| --- | --- | --- |
| `data/today.json` | heutiger Zwischenstand + Kurve | laufend, übersteht Neustart |
| `data/days/YYYY-MM-DD.json` | **abgeschlossener Tag**: volle 1-Min-Kurve + Aggregat | dauerhaft |
| `data/history.json` | Tagesaggregate (für Monat/Jahr) | dauerhaft |
| `data/tariff.json` | Stromtarife | dauerhaft |

**Kein Datenverlust beim Tageswechsel:** Beim Rollover (lokale Mitternacht) wird
der Vortag inklusive Kurve archiviert, bevor zurückgesetzt wird. War der Server
über Mitternacht aus, wird der letzte Tag beim nächsten Start nachträglich
archiviert. Größe: ~1440 Punkte/Tag ≈ einige Zehn-KB/Tag → wenige MB/Jahr,
mehrjährige Speicherung problemlos (41/42). **Nichts wird gelöscht.**

Zeitzone: lokale Hauszeit; Tagesgrenzen bei lokaler Mitternacht, DST-sicher (5).

## 3. API

| Endpunkt | Zweck |
| --- | --- |
| `GET /api/history/day?date=YYYY-MM-DD` | vollständige Tagesansicht (Kurve + Zusammenfassung + Geräte). `&summary=1` ohne Kurve (für die KPI-Leiste) |
| `GET /api/history/dates` | Datumsangaben mit vorhandener Historie |
| `GET /api/history?range=month\|year\|total` | Aggregate |
| `GET /api/collector` | Zustand des Datensammlers |

Fehlt ein Tag: `hasData:false` — es werden **keine Werte erfunden** (40).

## 4. Tagesverlauf (Frontend)

- Datumsnavigation: ‹ / › , Datumswähler, Schnellwahl **Heute / Gestern**.
- Diagramm deutlich größer & responsiv (Desktop 440, Tablet 340, Mobile 300 px)
  mit pixelgenauem Layout (kein Verzerren).
- **Y-Achse skaliert automatisch** auf die sichtbaren Serien (nice-Schritt, ~6 %
  Headroom, stabil gerundet — springt nicht bei jedem Live-Punkt).
- X-Achse 00:00–24:00, auf Mobile weniger Ticks.
- **Serien einzeln ein-/ausblendbar** (Legende als Chips): PV gesamt, je
  Wechselrichter, Haus, Netzbezug, Einspeisung, je Speicher.
- **Umschalter Leistung / Batteriestand:** SOC (%) als eigene 0–100-Ansicht (20).
- Tooltip + Crosshair bei Hover/Touch mit allen Werten zum Zeitpunkt (21/22).
- **Lücken statt Null:** fehlende Daten unterbrechen die Linie (25).
- Tages-Zusammenfassung inkl. je Speicher geladen/entladen und Vortagsvergleich (29/30/66).

## 5. Hersteller-Historie — geprüfte Machbarkeit (34/35/64)

Verifiziert an den **echten** Geräten, ausschließlich offizielle Schnittstellen,
kein Scraping (33):

| Quelle | Historie lokal abrufbar? | Befund |
| --- | --- | --- |
| Fronius **Symo 5.0-3-M** (`.121`) | **Ja** | `GetArchiveData.cgi` liefert historische Energiewerte (getestet: 293 Punkte). Nur PV-Energie dieses Wechselrichters. |
| Fronius **GEN24** (`.39`) | **Nein** | `GetArchiveData.cgi` → HTTP 404. GEN24 bietet **keine** lokale Archiv-API. Historie nur über Solar.web (kostenpflichtig, Geschäftskunden — siehe [01](01-datenquellen-verifikation.md)). |
| Victron **VRM** | Ja, aber | `/installations/{id}/stats` liefert Historie — **erfordert einen VRM Access Token**, der nicht hinterlegt ist. |

**Konsequenz für Backfill:** Der GEN24 trägt Zähler, Batterie und den Großteil
der PV — und hat keine lokale Historie. Ein **vollständiger** lokaler Backfill
(Haus/Netz/Speicher) ist damit nicht möglich. Ein Teil-Backfill nur der
Symo-PV-Energie hätte geringen Nutzen. Deshalb **nicht implementiert**, sondern
hier dokumentiert. Sinnvoller Weg für echte Historie vor Aufzeichnungsbeginn:
**Victron VRM** — sobald ein Access Token hinterlegt ist, kann ein `stats`-basierter
Import ergänzt werden (Datenqualität dann als `manufacturer_history` markiert, 39).

Das eigene Gedächtnis der App läuft ab jetzt lückenlos weiter — jeder Tag wird
dauerhaft gespeichert und ist später über die Datumsauswahl abrufbar.
