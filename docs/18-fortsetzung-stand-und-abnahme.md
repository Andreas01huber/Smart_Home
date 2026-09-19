# Fortsetzung nach Claude Code – Stand 19.09.2026

Arbeitsstand auf `review-umsetzung`, aufbauend auf `235eebf` und den bereits vorhandenen uncommitteten Änderungen. Kein Push, kein Deployment und keine echten Gerätebefehle. Dieses Dokument ist eine Ergänzung zu Auftrag 17, keine vollständige Abnahme aller dort beschriebenen Anforderungen.

## Abgeschlossener Fortsetzungsabschnitt

- Tagesansicht und Kosten zeigen Messabdeckung, Datenlücken und Tarifgrundlage; Tagesgrenzen und Uhrzeiten verwenden die Anlagenzeitzone. Beim Datumswechsel verschwinden die Zahlen des vorherigen Tages sofort, bis die passende Antwort vorliegt. Überholte Erfolge und Fehler überschreiben keine neuere Anfrage.
- Fehlende Netzwerte erscheinen nicht mehr als gemessene Null. Speicher-Teilwerte werden als unvollständig bezeichnet. Hausverbrauch wird ausdrücklich als Gesamtverbrauch inklusive Auto beschriftet.
- Tarifeingaben bleiben bei Fehlern erhalten. Laden und Speichern berücksichtigen Berechtigung, Validierung, ausstehende Anfragen und Tarifhistorie. Ein zukünftiger Tarif wird nicht als heutiger Preis zurückgegeben oder für frühere Tage verwendet.
- Die neuen Frontendmodule sind im Service-Worker-Cache enthalten.
- Laden ist über einen Statuszugang oben und über die mobile Navigation erreichbar. Pausieren/Fortsetzen hat eine sichtbare Schaltfläche. Dialoge sperren den Hintergrund für Tastaturbedienung, halten den Fokus im Dialog und geben ihn beim Schließen zurück.
- Der Ladedialog gleicht seinen DOM mit der neuen Darstellung ab, statt alle Bedienelemente bei jedem Messwert zu ersetzen. Fokus und Regler bleiben bei Live-Updates erhalten; alte Ereignishandler werden entfernt, damit eine Eingabe nur einen Befehl auslöst.
- Ein belegter Serverport startet keine Hintergrundabfragen und keine Laderegelung. Der isolierte Fixture-Server ermöglicht UI-Prüfungen mit simulierten Daten und absichtlich langsamen/fehlerhaften Antworten.

## Geprüft

- Gesamte Testsuite, TypeScript-Build, JavaScript-Syntax und `git diff --check`.
- Neue Regressionstests: überholte Fehlerantwort, ungültige JSON-Form, aktueller und zukünftiger Tarif über HTTP, ungültiger Tarif unverändert, leere Tagesantwort mit Zeitzone, statische Frontendmodule, belegter Port ohne Connectorabfrage, Regler ohne doppelte Befehle nach erneutem Binden.
- Browser mit isoliertem Fixture auf 127.0.0.1:4320, insbesondere 390 Pixel Breite: Tariffehler erhält Entwurf, zukünftiger Tarif verändert heutigen Preis nicht, schneller Datumswechsel bei verzögerter Antwort, Ladezugang, Vorschau des manuellen Reglers, Tab/Shift+Tab, Escape und Fokus-Rückgabe. Fokus und 12-A-Vorschau blieben über mehrere Messwertupdates erhalten; die Vorschau wurde abgebrochen.
- Die Browserprüfung ist kein Test an einer realen Wallbox; Geräteverhalten und produktive Netzwerkbedingungen sind damit nicht bestätigt.

## Weiterhin offen aus Auftrag 17

1. **Letzten Lademodus dauerhaft speichern:** Die bestehende Regelung und der UI-Text setzen manuelles Laden weiterhin beim Abstecken/Neustart zurück. Den vom Benutzer gewünschten letzten Modus serverseitig persistieren, Neustart/Abstecken/mehrere Browser testen und Beschreibung anpassen. Das wurde in diesem Abschnitt nicht umgestellt.
2. **Frische und Befehlszustand beim Laden:** Messwert, gewünschter Zustand und bestätigter Zustand weiterhin getrennt prüfen; sekündliche Anzeige darf keinen sekündlich neuen Gerätewert vortäuschen. Verhalten von Pause während eines laufenden Befehls gezielt klären und testen.
3. **EV-Statistik und Protokoll:** Die EV-Ladeabfragen verwenden noch nicht überall den geschützten API-Client. Zeitraumwechsel, Fehlerzustände, Erhalt letzter bestätigter Werte, Live-Aktualisierung laufender Sessions und Zeitzonengrenzen für EV-Auswertungen weiter bearbeiten.
4. **Vollständige fachliche Abnahme:** Sämtliche Szenarien aus Auftrag 17 einzeln den vorhandenen Tests zuordnen; dieser Abschnitt bestätigt nicht pauschal jede Bilanz-, Qualitäts- und Ausfallanforderung.
5. **Betrieb und Zugriffsschutz:** Die verbleibenden Punkte zu Modbus-Zeitlimits, Proxy-Vertrauen, Deployment/Rollback und Healthchecks aus Auftrag 17 gesondert umsetzen und isoliert testen.

Weiterarbeit: zunächst den aktuellen Diff lesen und erhalten, dann die offenen Punkte in dieser Reihenfolge angehen. Keine produktiven Daten, Zugangsdaten oder Geräte verwenden; weiterhin kein Push oder Deployment.

## Nachtrag: ausdrückliche Ladestrombestätigung

Der Regler sendet auch im bereits aktiven Handbetrieb weder beim Ziehen noch beim Loslassen einen Befehl. Dafür gibt es „Ladestrom bestätigen“; beim Wechsel aus intelligentem Laden bestätigt die Rückfrage zugleich den ausgewählten Reglerwert. Die Vorschau zeigt berechnete kW, die Beschreibung den bestätigten Sollwert. Fehler bleiben sichtbar; während einer Anfrage sind weitere Bestätigungen gesperrt.

Im Leapmotor-Dialog stehen zusätzlich die unveränderte Wallbox-Leistung, der gemessene Strom aus Phase A, die vom Gerät gemeldete Stromgrenze und Alter/Qualität der Tuya-Rückmeldung. Die für die Bilanz geprüfte Leistung bleibt separat erhalten. Ein erfolgreicher Steueraufruf ersetzt keine Messwerte durch Sollwerte. Die Aktualisierung folgt dem bestehenden Live-Datenstrom; eine verzögerte Tuya-Meldung lässt sich dadurch nicht beschleunigen.

Abnahme dieses Nachtrags: 424 Tests bestanden, Typprüfung und Syntaxprüfung bestanden. Browserprüfung am isolierten Fixture: 6 A bestätigt, auf 16 A verschoben, Gerätebefehlsprotokoll blieb bei 6 A; erst nach Bestätigung wurde auf 16 A gestellt. Messwerte zeigten zunächst weiterhin 6 A / 1,4 kW und nach der nächsten Rückmeldung 16 A / 3,7 kW. Mobile Darstellung mit 390 Pixeln geprüft. Keine reale Wallbox angesteuert, kein Deployment.
