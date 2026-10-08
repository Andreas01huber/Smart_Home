# SmartHome

Fronius und Victron in einer gemeinsamen Oberfläche.

## Auf einem anderen PC einrichten

Soll die App durchgehend laufen, statt nur am Laptop: [INSTALLATION.md](INSTALLATION.md)
fuehrt Schritt fuer Schritt durch die Einrichtung eines Dauer-Servers im Heimnetz.

## Starten

Vor dem ersten Start mit `npm run passwort` ein Konto einrichten. Ohne gültige
Anmeldung startet der Server standardmäßig nicht; beschädigte Zugangsdaten
werden nicht mehr als Freigabe für einen offenen Betrieb behandelt.
Ein bewusst offener lokaler Betrieb muss ausdrücklich über
`allowUnauthenticatedAccess: true` in `config.json` gewählt werden. Diese Option
umgeht keine beschädigte oder vorhandene ungültige Anmeldekonfiguration.

Doppelklick auf **SmartHome** auf dem Desktop.
Das Fenster startet den Server, der Browser öffnet sich nach wenigen Sekunden
von selbst auf <http://localhost:4173>. Beenden mit `Strg+C` im Fenster.

Alternativ aus dem Projektordner:

```bash
npm start
```

## Was das Dashboard zeigt

Photovoltaik, Hausverbrauch, Stromnetz und alle Batteriespeicher in Echtzeit,
aktualisiert alle 2 Sekunden. Unter jedem Wert steht, aus welcher Quelle er
stammt und wie alt er ist. Veraltete Werte werden als solche markiert und
nicht als aktuell ausgegeben.

Stimmt die Energiebilanz nicht, weist das Dashboard darauf hin, statt eine
plausibel aussehende Zahl zu zeigen.

Tagessummen entstehen auf zwei Wegen: aus der Integration der Leistung (alle
2 s) und aus den **Zählerständen der Geräte** (Fronius Smart Meter, Symo
`E_Total`, Wallbox `forward_energy_total`). Die Zähler laufen auch, wenn der
Server nicht läuft; weichen beide Zahlen ab, zeigt die Tagesansicht den
Zählerwert daneben. Die Tageskurve zeigt Minutenmittel, keine Momentaufnahmen.

Was passiert ist — Befehle an die Wallbox, Stopps, Verbindungsabbrüche,
Anmeldungen — steht dauerhaft in `data/ereignisse.jsonl` und in der
Verwaltung (`/admin`) sowie unter `/api/ereignisse`.

## Konfiguration

`config.json` im Projektordner. Sie wird beim Start **streng geprüft**: Ein
unbekannter Schlüssel, eine fehlende Adresse oder ein unklarer Modus verhindern
den Start mit einer Liste aller Fundstellen — statt still auf einen Vorgabewert
zu fallen. Schlüssel mit `_` davor (`_hinweis`) sind Kommentare.

- `sources` — die Geräte, in zwei Schreibweisen:
  - bisherige Objektform `{ "fronius": …, "froniusGen24": …, "victron": …, "evCharger": … }`
    (feste IDs `fronius-local`, `fronius-gen24`, `victron-modbus`, `ev-charger`)
  - Listenform `[{ "id": "wr-nord", "typ": "fronius-solar-api", "host": "…" }, …]`
    mit `typ` aus `fronius-solar-api`, `victron-modbus`, `tuya-evse` — für
    einen weiteren Wechselrichter oder Speicher genügt ein Eintrag
- `batteryDisplayName` / `usableCapacityWh` an einer Quelle bedeuten: Dieses
  Gerät liefert einen Speicher. Fehlt er in der Messung, ist das eine Lücke.
- `sourceMapping` — welche Quelle für welche Messgrösse maßgeblich ist.
  Es wird immer genau eine Quelle ausgewählt, niemals addiert.

## Weitere Befehle

```bash
npm run preflight
```

Prüft den gesamten Datenpfad (echte Connectoren, Normalisierung, Aggregation,
Bilanz) und gibt einen Report aus. Vor grösseren Änderungen ausführen.

```bash
npm run discover
```

Sucht Fronius- und Victron-Geräte im lokalen Netz und meldet, was tatsächlich
gefunden wurde. Nützlich nach Änderungen an der Anlage.

```bash
npm run sicherung
```

Kopiert `data/` (Historie, Tagesarchive, Ladeprotokoll, Tarife, Ereignisse) nach
`sicherungen/<Zeitstempel>/`, behält die letzten 14. Mit `-- --ziel D:\Backup`
an einen anderen Ort, mit `-- --wiederherstellen <Ordner>` zurückspielen (bei
gestopptem Server; der aktuelle Stand wird vorher gesichert).

```bash
npm test
npm run typecheck
```

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `packages/core` | Datenmodell, Normalisierung, Source-of-Truth, Bilanzprüfung, Energy Accounting |
| `packages/connectors` | Adapter für Fronius Solar API und Victron Modbus TCP |
| `packages/discovery` | Automatische Geräteerkennung |
| `apps/server` | HTTP-Server, Persistenz/Historie, Premium-Dashboard (PWA) |
| `tools/preflight.ts` | Energy System Preflight |

## Installierbare App (PWA)

Das Dashboard ist eine Progressive Web App: im Browser über „Zum Startbildschirm
hinzufügen" installierbar, dann Vollbild mit eigenem Icon — ohne separate
native App.

## Dokumentation

- [docs/01-datenquellen-verifikation.md](docs/01-datenquellen-verifikation.md) —
  verifizierte Schnittstellen, ausschliesslich aus offizieller Herstellerdoku
- [docs/02-anlagen-inventar.md](docs/02-anlagen-inventar.md) —
  tatsächlich gefundene Hardware und abgeleitetes Source-of-Truth-Mapping

## Zugangsdaten

Kommen ausschliesslich aus `.env` (Vorlage: `.env.example`) und sind über
`.gitignore` von Git ausgeschlossen. Es werden keine Passwörter gespeichert,
nur Tokens. Die Bindung steuert `config.json` (`host`, Standard `0.0.0.0` für
den Handy-Zugriff im Heimnetz, auf `127.0.0.1` beschränkbar); Zugangsdaten gibt
der Server niemals an den Browser weiter.
