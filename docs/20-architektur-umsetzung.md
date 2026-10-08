# Architektur-Umsetzung nach dem Projektreview — Ergebnis und Übergabe

Stand: 08.10.2026. Grundlage: die externe Architekturbewertung (Gesamteinschätzung
A–E) vom selben Tag. Umgesetzt sind alle dort als notwendig bewerteten Punkte;
was offen bleibt, steht unten ehrlich.

---

## Umgesetzt

### 1. Gerätemodell aus der Konfiguration (B.5) und strikte Prüfung (B.6)
- `config.ts`: `sources` ist intern eine **Liste typisierter Quellen**
  (`fronius-solar-api` | `victron-modbus` | `tuya-evse`). Die bisherige Objektform
  wird weiter gelesen und auf die festen IDs abgebildet; neu ist die Listenform
  mit freien IDs. Ein viertes Gerät ist ein Eintrag in `config.json`.
- Connector-Fabrik (`baueConnector`), Speichererwartung (`speicherquellen`),
  Anzeigenamen (`quellenNamen`) und Ladeanschluss leiten sich aus dieser Liste
  ab — die String-Literale in `engine.ts`, `index.ts` und `quality.ts` sind weg.
- Validierung ohne Casts: unbekannte Schlüssel, fehlende Pflichtfelder, falsche
  Typen, Bereichsfehler und ein unklarer `modus` verhindern den Start mit **allen**
  Fundstellen auf einmal (`KonfigurationsFehler`). `_`-Schlüssel bleiben Kommentare.
  Verweise der `sourceMapping` auf unbekannte IDs sind eine Warnung (Fixture/Test
  reichen Quellen von aussen ein).
- Frischegrenzen hängen am **Typ** (`STALENESS_BY_TYPE`), nicht an der ID. Damit
  gilt für `fronius-gen24` dieselbe Grenze wie für den Symo (15 s statt 60 s
  Fallback); Tuya hat eine eigene, bewusst weite Policy.

### 2. Zählerstände als zweite Wahrheit (B.1)
- `ConnectorReading.counters` / `EnergySnapshot.counters` (`EnergyCounters`,
  `ResolvedCounters`), aufgelöst nach denselben Regeln wie Leistungen (Netz aus
  einer Quelle, PV-Summe nur vollständig).
- Fronius liest `GetMeterRealtimeData` (`EnergyReal_WAC_Sum_Consumed/Produced`
  des Meters mit `Meter_Location_Current === 0`) und `Site.E_Total` — letzteres
  **nur bei Wechselrichtern ohne Speicher** (beim Hybrid enthält der AC-Zähler
  die Speicherentladung; dann bleibt der PV-Zähler leer). Tuya liefert
  `forward_energy_total` ohnehin.
- `EnergyAccumulator` führt je Tag Zählerstände (Start/letzter/Summe, mit
  Rücksprung-Erkennung), überträgt sie über Mitternacht und Neustart, und weist
  `totals.zaehler` (`pvWh`, `bezugWh`, `einspeisungWh`, `autoWh`, je Wechselrichter)
  aus. Monats-/Gesamtsummen addieren Zähler nur, wenn alle Tage welche haben.
- Oberfläche: Tageszusammenfassung zeigt „Zähler: … kWh" neben Produktion,
  Netzbezug und Einspeisung, sobald der Wert vom integrierten abweicht.

### 3. Tageskurve als Minutenmittel
- Die Kurve ist je Minute der Mittelwert aller Messungen (aus denselben
  Integrationsintervallen wie die Tagessumme) statt einer Momentaufnahme je 60 s.
  Summe der Kurve × 60 s = Tagessumme. Werte in ganzen Watt, SOC auf 0,1 %.
- Die angefangene Minute ist in der Live-Ansicht sichtbar und wird in
  `today.json` mitgesichert (`fenster`), damit ein Neustart sie nicht verschluckt.
- Lücken werden an Lücken markiert (Neustart, zu langer Abstand), nicht erst
  beim nächsten Punkt.
- Tagesarchive älter als 90 Tage werden beim Start auf 15-Minuten-Mittel
  verdichtet (`seriesIntervalSeconds` im Archiv und in der Tagesansicht).
  Geparste Archive liegen in einem kleinen Cache.

### 4. Regelung (B.2, B.3, B.4)
- `core/ladeentscheidung.ts`: die Übersteuerungen (fordert-nicht → Handbetrieb →
  keine Wahl → Stopp → Dosengrenze) als **reine Funktion** `uebersteuere` mit
  Tabelle in `ladeentscheidung.test.ts`.
- `server/ladebefehl.ts`: `Befehlsausfuehrung` — Senden, Bestätigen, Backoff,
  Befehlsstatus — getrennt vom Regler.
- `Ladesteuerung.zyklus()` besteht aus benannten Stufen (`erkenneDose`,
  `gleicheMitWirklichkeitAb`, `pruefeFahrzeugnachfrage`, `uebersteuere`,
  Beruhigung, Befehl); der Fahrzeugzustand ist ein Objekt (`Fahrzeuglage`).
- Schnittstelle `SteuerbaresLadegeraet` in `@energy/connectors`; `ManagedConnector`
  reicht sie durch (`ladegeraet()`) und führt Befehlsfehler in der Diagnose
  (`letzterBefehlFehler`). Der Regler kennt nur die Schnittstelle — kein
  Tuya-Typ, kein Weg am Health-Gate vorbei.
- **Ausfallverhalten:** `beimHerunterfahren()` sendet im intelligenten Betrieb
  einen Stopp, wenn die Wallbox freigegeben ist (im Handbetrieb nicht); `start()`
  läuft sofort einen Abgleichzyklus statt erst nach 30 s. Beides im Server
  verdrahtet (`stoppe()`).
- Eine Schwelle für „lädt": `LADEN_AB_W = 50` aus `core` gilt in Historie,
  Protokoll, Regler, Serialisierung und `ev-bedienung.js` (vorher 50/100/200).
- `melde()` benachrichtigt den Live-Strom nur bei tatsächlicher Änderung.

### 5. Server (B.8)
- `serialisierung.ts` (`Serialisierer`, eine Instanz je Server — kein
  Modul-Singleton mehr für die Haus/Auto-Aufteilung), `live-strom.ts` (`LiveStrom`:
  einmal serialisieren, an alle schreiben, ein Puls), `index.ts` mit Routentabelle
  (Methode, Pfad/Muster, Admin-Flag) und 405 mit `Allow`.
- `tageszeit.ts` bündelt `localDate`, `shiftDate`, `tagesgrenzen`,
  `naechsterTagesbeginn` (vorher doppelt); `http-util.ts` bündelt `sendeSeite`,
  `leiteWeiter`, `KEIN_CACHE`; die Verwaltung nutzt denselben Herkunftsschutz.

### 6. Ereignisprotokoll und Sicherung (C)
- `ereignisse.ts`: `data/ereignisse.jsonl`, eine Zeile je Ereignis, Rotation ab
  5 MB. Mitgeschrieben: Server-Start/-Stopp, Befehle und Befehlsfehler,
  Zustandswechsel der Regelung, Stopp/Betriebsart vom Benutzer, Fahrzeug
  an/abgesteckt, Wallbox erreichbar/offline, Geräte offline/online, manueller
  Reconnect, Tarif, Kontenverwaltung. Sichtbar in `/admin` und `/api/ereignisse`.
- `npm run sicherung` (`tools/sicherung.ts`): `data/` nach `sicherungen/<Zeit>/`,
  Aufbewahrung konfigurierbar, Wiederherstellung mit Vorab-Sicherung.
- `wallbox.json` wird atomar geschrieben; `discovery-report.json` ist aus Git
  entfernt und ignoriert.

### 7. Oberfläche
- Das Laden-Kästchen oben („Laden › …") ist entfernt; der Zugang bleibt über die
  Fahrzeugkarte. Service-Worker-Cache `v76`.

---

## Tests

- `npm run typecheck`: fehlerfrei.
- `npm test`: **518 von 518** (vorher 481). Neu: `config.test.ts` (beide
  Schreibweisen, Fehlerliste, Doppel-IDs, Kommentare), `ladeentscheidung.test.ts`
  (jede Stufe und die Reihenfolge), `ereignisse.test.ts`, `fronius-local.test.ts`
  (Zähler, Hybrid-Ausnahme, Policy je Typ), Historie (Minutenmittel, Kurve = Summe,
  Verdichtung, Zähler über Neustart/Mitternacht/Rücksprung),
  ManagedConnector-Durchreichung. Ein bestehender Kurventest wurde an die
  Mittelwert-Semantik angepasst (ein Mittel braucht ein Intervall).
- Rauchtest mit `tools/fixture-server.ts`: Snapshot, Tagesansicht mit Serie,
  `/health`, 405 mit `Allow`, Ereignisse nach Stopp, Startseite ohne Laden-Kästchen.

## Vor dem ersten Deploy

1. `config.json` wird jetzt streng geprüft. Die aktuelle Datei der Anlage
   besteht die Prüfung (nur bekannte Schlüssel plus `_hinweis*`). Nach dem
   Deploy das Serverlog auf `[Konfiguration]` prüfen.
2. Dateiformate: `history.json` und Tagesarchive Fassung 3 (Feld `zaehler`,
   `seriesIntervalSeconds`); `today.json` zusätzlich `zaehlerstaende`, `fenster`.
   Alte Dateien bleiben lesbar; Zählersummen beginnen mit dem ersten Stand nach
   dem Update.
3. Neue Datei `data/ereignisse.jsonl` (wächst langsam, rotiert bei 5 MB).
4. Beim ersten Start werden Tagesarchive älter als 90 Tage verdichtet (einmalig,
   wenige Sekunden, Logzeile `[Historie]`).
5. Verhalten beim Herunterfahren: Im intelligenten Betrieb wird die Wallbox beim
   Stopp des Dienstes abgeschaltet. Ein Deploy während eines intelligenten
   Ladevorgangs unterbricht ihn also kurz; nach dem Start läuft sofort ein
   Abgleich. Im Handbetrieb ändert sich nichts.

## Offene Grenzen — ehrlich

- **Victron-Energieregister** sind nicht angebunden; docs/01 verlangt verifizierte
  Register, und die Netzzähler kommen ohnehin vom Fronius Smart Meter. Der Victron
  liefert deshalb keine Zähler.
- **PV-Zähler des GEN24** bleibt leer (Hybrid). Die PV-Tagessumme „laut Zähler"
  ist deshalb an dieser Anlage nicht vollständig; je Wechselrichter steht der
  Symo-Zähler zur Verfügung. Ein Weg über `GetInverterRealtimeData`/DC-Zähler
  wäre erst nach Verifikation an der Anlage sinnvoll.
- **Absturz ohne Herunterfahren** bleibt eine Lücke: Dann steht der letzte
  Befehl an der Wallbox. Nur ein lokaler Steuerpfad (andere Wallbox, Relais)
  schliesst sie; die Schnittstelle `SteuerbaresLadegeraet` ist dafür vorbereitet.
- `app.js` ist weiterhin eine Datei; entfernt wurde nur das Laden-Kästchen. Die
  Zähleranzeige ist eine Nebenzeile in der Tageszusammenfassung, nicht in
  Monats-/Jahresansichten.
- Die Rolle `benutzer` darf weiterhin Laden stoppen/umstellen und Geräte neu
  verbinden (bewusst so belassen; Tarife/Konten bleiben Admin).
- Nichts davon wurde an der echten Anlage oder gegen die Tuya-Cloud geprüft —
  nur gegen Tests und den Fixture-Server.
