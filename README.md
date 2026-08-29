# SmartHome

Fronius und Victron in einer gemeinsamen Oberfläche.

## Auf einem anderen PC einrichten

Soll die App durchgehend laufen, statt nur am Laptop: [INSTALLATION.md](INSTALLATION.md)
fuehrt Schritt fuer Schritt durch die Einrichtung eines Dauer-Servers im Heimnetz.

## Starten

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

## Konfiguration

`config.json` im Projektordner:

- `sources.fronius.host` — IP des Fronius Symo
- `sources.froniusGen24.enabled` — auf `true`, sobald die Solar API am GEN24
  aktiviert ist
- `sources.victron.usableCapacityWh` — nutzbare Kapazität des grossen
  Speichers; das Batteriesystem meldet sie nicht über Modbus
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
