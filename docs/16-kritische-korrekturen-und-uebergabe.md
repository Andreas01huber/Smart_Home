# Kritische Korrekturen und Übergabe an Claude

Stand: 19.09.2026. Ausgangspunkt: Commit `2f12403`.
Änderungen liegen lokal; kein Deploy, keine echten Gerätebefehle, keine Änderung
an `config.json`, `secrets.json` oder produktiven Laufzeitdaten.

## Erledigt

- Review-Punkt 1: Phase-N-Spannung aus Tuya wird für dreiphasige Berechnungen
  zentral in die erwartete verkettete Spannung übersetzt. Alte gespeicherte
  Werte wie drei Phasen / 230 V werden verworfen.
- Punkte 2 und 4: Manuelles Stoppen und Abschalten bei unsicheren Messwerten
  umgehen die normale Beobachtungsfrist. Ein kleinerer Sollwert darf eine
  Fehlersperre nach einem höheren Befehl überholen. Wiederholt fehlgeschlagene
  Stopps behalten einen begrenzten Wiederholabstand.
- Punkt 3: Der Schieberegler in der Vorschau sendet keinen Ladebefehl.
  Fehlerantworten werden nicht als Regelzustand übernommen; die Bedienung zeigt
  laufende Befehle und Fehler an. Ein angeforderter Stopp wird nicht als bereits
  physisch beendete Ladung ausgegeben.
- Punkt 5: Auch der schnelle Messpfad beendet manuellen Betrieb beim Abstecken.
  Bedienänderungen während einer laufenden Cloud-Anfrage werden nachgeführt;
  eine überholte Einschaltfreigabe nach einem Strombefehl wird unterdrückt.
- Punkt 6: Unvollständige PV-Summen und Hausbilanzen mit unbekannter
  Batterieleistung bleiben unbekannt. Konfigurierte bzw. bereits gesehene
  Speicherquellen werden auf Vollständigkeit geprüft. Die Regelung prüft
  Qualität und Alter aller benötigten Quellen sowie das Alter des Engine-Stands.
  Veraltete Speicherwerte werden nicht als Entladenachweis gelernt.
- Punkt 7: Fehlende Anmeldung verhindert standardmäßig den Serverstart;
  beschädigte Kontendaten werden nicht stillschweigend übergangen. Die Prüfung
  läuft vor dem Start von Messung und Regelung. Bewusster offener Betrieb ist
  ausschließlich mit `allowUnauthenticatedAccess: true` möglich; die bestehende
  Konfiguration wurde nicht geändert. Erstkonto weiterhin: `npm run passwort`.
- Punkt 8: HTTP-Parserfehler und asynchrone Handlerfehler sind abgefangen;
  statische Verzeichnisse werden nicht als Dateien ausgeliefert. Backslash- und
  Steuerzeichen-Weiterleitungen nach dem Login werden abgelehnt.
- Punkt 9: Engine-Polls überlappen nicht mehr.
- PWA-Cache aktualisiert, damit die neue Bedienlogik geladen wird.

## Für Claude offen

1. ~~Historie: nur gültige Messintervalle integrieren, Abdeckung und Lücken
   ausweisen; Liveanzeige und Ladeprotokoll auf dieselbe geprüfte Leistung
   stellen. Unbekannte Wallboxleistung nicht als gemessene Null ausweisen.~~
   **Erledigt** (`4b47a33`): `bilanzwertW` lässt nur aktuell gemeldete Werte in
   die Bilanz, jeder Tag weist `coveredSeconds`/`gapSeconds` aus (in `dayView`
   und `collectorHealth`), und Anzeige, Tagesbilanz und Ladeprotokoll bekommen
   dieselbe geprüfte Ladeleistung samt gemeinsamer Schwelle `LADEN_AB_W`.
   Unbekannte Wallboxleistung erscheint als Strich.
2. ~~Persistenzdateien unabhängig laden und bei Beschädigung erhalten;
   dauerhaften Sitzungswiderruf bei Schreibfehlern absichern.~~
   **Erledigt** (`6d5df8d`): jede Datei wird einzeln gelesen,
   `bewahreBeschaedigt()` legt Unlesbares beiseite statt es zu überschreiben,
   und ein Abmelden wird notfalls durch Löschen der Sitzungsdatei bzw. Sperren
   aller Sitzungen erzwungen. **Offen bleibt** eine echte
   Backup-/Wiederherstellungsfunktion — die gibt es bisher gar nicht, und wo
   sie hinschreibt, ist eine Entscheidung für den Betreiber.
3. Tarife historisieren, Tagesgrenzen aufteilen und Quellen-/Senkenaufteilung
   bei Netzladung der Speicher korrigieren.
4. Deploy: Vorbereitung vor Dienststopp, Rollback, geeigneter Healthcheck;
   Docker-Kontenspeicher vom schreibgeschützten Secret-Mount trennen.
5. UI: Detailansicht nicht vollständig pro Messwert ersetzen; Fokus und
   Wisch-/Schiebebewegungen erhalten. Tagesabfragen gegen vertauschte Antworten
   absichern; Ladehistorie nachladen; Offlinewerte sichtbar altern lassen.
6. Gestaltung und Zugänglichkeit: deutlicher Stoppknopf, schneller Zugang zum
   Laden, eindeutige Haus-/Autobeschriftung, Dialogfokus, bedienbare Legenden.
7. Proxy-Vertrauen, Rollen für Lade-/Tarifbefehle, Modbus-Abbruch/Deadline und
   Antwortvalidierung gesondert prüfen. Weitere veraltete Dokumentation anpassen.

## Prüfung und Grenzen

Automatisierte Regressionen verwenden simulierte Wallboxen, Quellen,
Frontend-Ereignisse und temporäre Testdateien. Sie prüfen tatsächliche
Befehlsfolgen inklusive Cloud-Verzögerung/Fehlern, dreiphasige Umrechnung,
Messwertausfall, Zugriffsschutz und Fehlerantworten. Bestanden: alle 361 Tests
(`npm test`), Typprüfung (`npm run typecheck`), JavaScript-Syntaxprüfung der
geänderten Browserdateien und `git diff --check`.

Ein realer Ladezyklus sowie ein Deployment wurden nicht durchgeführt. Verhalten
bei vollständigem Internet-/Serverausfall hängt weiterhin von der Wallbox und
ihrem zuletzt angenommenen Befehl ab; Cloud-Steuerung ersetzt keinen lokalen
Hardware-Failsafe.
