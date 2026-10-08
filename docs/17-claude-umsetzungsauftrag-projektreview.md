# Umsetzungsauftrag für Claude Code: SmartHome verlässlich und übersichtlich machen

Du arbeitest am bestehenden Projekt AppSmartHome. Setze die folgenden Änderungen in nachvollziehbaren Etappen um. Dies ist ein konkreter Entwicklungsauftrag, kein Auftrag für einen weiteren allgemeinen Verbesserungsplan.

## Ausgangslage und Arbeitsregeln

Review vom 19.09.2026, geprüfter Stand `de79376`. Lies zuerst CLAUDE.md, aktuelle Änderungen und docs/16-kritische-korrekturen-und-uebergabe.md. Zwischenzeitliche Änderungen zuerst abgleichen; bereits korrekt gelöste Punkte erhalten. Zum Review-Zeitpunkt bestehen 374 Tests und die Typprüfung. Das beweist nicht die Vollständigkeit der fachlichen Anforderungen.

Die Oberfläche wurde mit isolierten synthetischen Daten auf Desktop und bei 390 Pixeln Breite in Hell/Dunkel betrachtet. Keine reale Anlage, keine Hardwarebefehle und kein Deployment wurden getestet. Testdaten-Artefakte sind keine Produktionsfehler.

Arbeite im vorhandenen TypeScript-/JavaScript-Aufbau. Kein Frameworkwechsel, keine neue Cloudplattform, keine unnötige Datenbankmigration. Die Hausillustration, vorhandenen Gerätebilder und beide Energieflussansichten bleiben erhalten. Bestehende Schutzmechanismen und die Phasenspannungskorrektur nicht zurückbauen.

Keine echten Gerätebefehle, kein Deployment, kein Push auf main: Der bestehende Workflow deployt bei einem Push automatisch. Keine Änderung produktiver Zugangsdaten, Datenbestände, Anschlussgrenzen oder Speicherreserven. Entwicklungs- und Integrationstests mit isolierten Datenverzeichnissen und simulierten Connectors ausführen. Dateimigrationen versionieren, auf Kopien testen und rückwärtskompatibel planen.

Bearbeitungsreihenfolge: 1 Datenwahrheit, 2 Ladebedienung, 3 Oberfläche, 4 Betrieb und Zugriffsschutz. Innerhalb jeder Etappe Implementierung und passende Tests abschließen. Am Ende dokumentieren, was tatsächlich fertig ist und was technisch offen bleibt.

## 1. Eine verlässliche Datenbasis für Anzeige und Berechnung

### 1.1 Unbekannt, geschätzt und gemessen unterscheiden

Betroffene Stellen: apps/server/src/hausverbrauch.ts, index.ts (hausUndAuto, geprueftAutoW, evAusZaehler, serializeState), history.ts, ev-log.ts und die Datenmodelle unter packages/core/src.

Reproduzierbarer Restfehler: `new Hausverbrauch().teile(1200, null, 0)` liefert derzeit `autoW: 0` und `frisch: true`. Anschließend kann geprueftAutoW diese Null an Bilanz und Ladeprotokoll geben. Die bereits vereinheitlichte Ladeleistung ist deshalb noch nicht durchgehend korrekt.

Sollverhalten:
- Unbekannte Autoleistung bleibt unbekannt. Ein Hauszähler allein beweist nicht, welchen Anteil das Auto verursacht.
- Bei Haus gesamt = 1200 W und Auto unbekannt bleibt Haus gesamt bekannt; Haus ohne Auto und Auto bleiben unbekannt, sofern keine ausdrücklich gekennzeichnete Schätzung vorliegt.
- Tatsächlich gemessene 0 W bleiben von unbekannt unterscheidbar.
- Eine aus gemerkter Hausgrundlast geschätzte Aufteilung erhält Kennzeichnung, Zeitstempel und begrenzte Gültigkeit. Sie darf nicht als frisch gemessene Energie bilanziert werden.
- Die Aufteilung einmal pro Messzyklus berechnen. serializeState und zusätzliche Browser/SSE-Verbindungen dürfen den Zustand des Hausverbrauch-Schätzers nicht verändern.
- Liveansicht, Tagesbilanz, Ladeprotokoll und Regelung beziehen sich auf denselben nachvollziehbaren Messwert mit Qualität; unterschiedliche fachliche Nutzung ausdrücklich begründen.
- Prüfe Werte auf Endlichkeit und Plausibilität, bevor sie integriert oder zur Steuerung verwendet werden.

Abnahme: null, 0, plausibler Messwert, widersprüchliche Werte, veraltete Grundlast, fehlender Hauszähler sowie mehrere gleichzeitige SSE-Clients testen. Mehr Browser dürfen weder Schätzung noch Energiesummen verändern.

### 1.2 Speicher-Gesamtwerte nicht als vollständig ausgeben

aggregateStorage und serializeState berücksichtigen derzeit nur liefernde Speicher und behandeln fehlende Leistungsanteile teilweise als Null. Dadurch kann eine Teilmenge wie ein vollständiger Gesamtspeicher aussehen.

Erwartete Geräte, verfügbare Geräte, installierte Kapazität und aktuell bekannte Energie getrennt führen. Bei Ausfall eines Speichers beispielsweise „1 von 2 Speichern verfügbar“ anzeigen; keinen vollständigen Gesamt-SOC oder vollständige Gesamtleistung behaupten. Einzelwerte des erreichbaren Speichers weiterhin zeigen. Dieselbe Vollständigkeitsregel für PV-Summen anwenden. Fehlende Daten nicht mit Null auffüllen.

### 1.3 Historie, Kurven und Messabdeckung fertigstellen

Betroffene Stellen: history.ts, quality.ts, app.js (renderDaySummary, renderCosts, renderChart).

Die neuen Qualitätsfilter und coverage-Felder sind vorhanden und sollen erhalten bleiben. Aktuell nimmt maybeAppendSeries aber rohe Werte in die Kurven auf; die Oberfläche verwendet coverage noch nicht.

- Dieselben Qualitätsregeln für Summen und Kurven verwenden. Ungültige Kurvenpunkte werden Lücken, nicht fortgezeichnete Messungen.
- „Erfasst: 85 % · Datenlücke: 1 h“ bei Tageswerten und Kosten sichtbar machen. Altbestände ohne Abdeckungsdaten als „Abdeckung unbekannt“ markieren.
- Den Nenner der Abdeckung klar definieren: heute vom lokalen Tagesbeginn bis jetzt, abgeschlossene Tage über deren tatsächliche Dauer. Zeiten vor Beginn der Aufzeichnung nicht als gemessen behandeln; gegebenenfalls separat „Aufzeichnung seit …“ zeigen.
- Neustartlücken durch einen persistierten letzten Erfassungszeitpunkt berücksichtigen. Der erste Poll nach Neustart darf die ausgefallene Zeit nicht unsichtbar machen.
- Intervalle mit fehlenden Quellen nicht rückwirkend mit dem nächsten gültigen Momentanwert auffüllen. Ein langes Intervall darf nicht einfach für die ersten 15 oder 60 Sekunden als sicher gemessen gelten.
- Wenn Quellen verschieden vollständig sind, Kosten und Quoten nicht als gleich zuverlässig ausgeben. Bei nicht vergleichbaren Abdeckungen Quote unterdrücken oder eindeutig als unvollständig kennzeichnen.
- Fachliche Schwellen und Integrationsregeln zwischen Tagesbilanz und EV-Protokoll angleichen; aktuell unterscheiden sich die maximalen Integrationsschritte.

Abnahme: eingefrorene Quelle, vollständiger Ausfall, Wiederanlauf, Neustart am selben Tag und über Mitternacht; Summen und sichtbare Kurven müssen die gleichen Lücken erklären.

## 2. Energieaufteilung, Zeiträume und Kosten korrigieren

### 2.1 Energieherkunft als Modell behandeln

Betroffen: packages/core/src/accounting.ts und ev-sessions.ts, apps/server/src/ev-log.ts.

Reproduzierbares Beispiel: PV = 0 Wh, Hausverbrauch = 1000 Wh, Netzbezug = 5000 Wh, Batterieladung = 4000 Wh. productionSinks ordnet heute trotzdem 4000 Wh der PV-Verwendung zu; consumptionSources gibt dem Haus 5000 Wh Netzstrom trotz nur 1000 Wh Verbrauch.

- Quellen und Senken pro gültigem Messintervall auf Basis einer dokumentierten Bilanz zuordnen, nicht erst aus aufsummierten Tagessummen vermeintlich exakt rekonstruieren.
- Netzladung von Speichern, gleichzeitiges Laden/Entladen verschiedener Speicher und Batterieeinspeisung berücksichtigen.
- Eine Zuordnung darf die gemessene Quelle bzw. Senke nicht überschreiten. Summe der Teile entspricht der zugeordneten Gesamtenergie; Rundungstoleranz definieren.
- Nicht bestimmbar bleibt „nicht zuordenbar“. Eine modellierte Verteilung als Modell kennzeichnen, nicht als separat gemessenen Stromweg.
- Keine historische PV-Herkunft aus bloßer Batterieentladung erfinden. Dafür wäre ein gesondertes Herkunftsmodell über die Zeit erforderlich.
- Alte Tagesdaten ohne ausreichende Intervalle erhalten, aber nicht nachträglich mit erfundener Genauigkeit umrechnen.

### 2.2 Tagesgrenzen und Ladeprotokoll

Betroffen: history.ts, ev-log.ts (stats, matchesRange, abwesend), app.js (dayBounds).

- Messintervalle an lokaler Mitternacht aufteilen. Der jetzige Tageswechsel erfolgt vor Integration und kann Zeit des alten Tages dem neuen zuordnen.
- In der Grafik den nächsten lokalen Tagesbeginn verwenden, nicht Start + 24 Stunden. Sommerzeit-Tage mit 23 bzw. 25 Stunden testen.
- Die Anlagenzeitzone als gemeinsame Grundlage verwenden; ein Browser in einer anderen Zeitzone darf Tageswerte nicht anders zuordnen.
- Eine Session bleibt ein Ladevorgang, aber ihre Energie und Ladezeit werden auf die tatsächlich betroffenen Tage/Monate verteilt. stats ordnet derzeit alles nach startedAt zu.
- Beispiel: Laden 23:30–00:30 mit konstant 6 kW ergibt je 3 kWh pro Tag und insgesamt eine Session mit 6 kWh.
- Eindeutig bestätigtes Abstecken von Offline/unklarem Anschluss trennen. Die aktuelle gemeinsame Zehn-Minuten-Abklingzeit kann zwei reale Steckvorgänge zusammenführen. Kurze bestätigte Trennungen müssen neue Sessions ermöglichen; reine Datenlücken dürfen keine künstlichen Steckereignisse erzeugen.
- Bei Alt-Sessions ohne genaue Zeitintervalle die Tagesaufteilung als unbekannt bzw. Näherung kennzeichnen, nicht aus dünnen Stufenprotokollen exakte Werte behaupten.

### 2.3 Tarife mit Gültigkeitszeitraum

history.ts berechnet historische Ansichten derzeit mit this.tariff, also dem heutigen Tarif. Tarifänderungen dürfen vergangene Kosten nicht stillschweigend verändern.

- Tarife mit „gültig ab“ speichern und zur jeweiligen Energieperiode anwenden.
- Ohne historisch bekannten Tarif die Schätzung offen kennzeichnen. Keine erfundene Tarifhistorie migrieren.
- UI und Backend gleich validieren: endliche Zahlen, erlaubte Felder, bewusst definierte Wertebereiche. Negative Werte nur, wenn das Produkt negative Tarife ausdrücklich unterstützt; derzeit lehnt das UI sie ab, das Backend nicht.
- Speichererfolg erst nach bestätigter Persistenz melden. setTariff/persist verschlucken aktuell Schreibfehler; app.js prüft beim Tarifspeichern resp.ok nicht.
- Bei Fehlern bisherige bestätigte Werte behalten, Eingaben nicht verlieren, verständliche Fehlermeldung zeigen.
- Grundgebühr entweder korrekt nach Zeitraum berücksichtigen und gesondert ausweisen oder ausdrücklich als nicht enthalten deklarieren.
- Kostenkarten immer mit Datum/Zeitraum und Tarifgrundlage beschriften. „Ersparnis“, „Einspeiseerlös“ und „Gesamter Vorteil“ konsistent unterscheiden.

## 3. Intelligentes und manuelles Laden als klare Bedienfunktion

Dieser Abschnitt ersetzt keine bereits korrekt umgesetzte Ladeverbesserung, sondern beschreibt den gewünschten Endzustand.

- Zuletzt ausdrücklich gewählten Modus und manuellen Strom serverseitig dauerhaft speichern. Kein automatischer Rücksprung auf Intelligent beim Abstecken oder Neustart. Noch vorhandene Rücksetzungen in beiden Regelpfaden entfernen und Tests anpassen.
- Ohne gespeicherte Auswahl eine erste bewusste Auswahl anbieten, nicht stillschweigend automatisch laden. Beschädigte Einstellungen dürfen keinen Start auslösen.
- Moduswahl auch ohne angeschlossenes Auto ermöglichen: „Beim nächsten Anstecken: Manuell · 10 A“. Erst bei verlässlich erkanntem Anschluss und gültigen Gerätebedingungen handeln.
- Pause als eigenen Zustand behandeln: browser- und neustartfest, bei eindeutigem Abstecken für diesen Steckvorgang zurücksetzen. Offline ist kein Abstecken. Modus und Strom bleiben erhalten.
- Wunsch, ausstehenden Befehl, Gerätebestätigung und gemessenen Stromfluss getrennt modellieren. HTTP 200 bedeutet nicht „Auto lädt“.
- Zustände verständlich benennen: kein Auto, Anschluss unbekannt, wartet auf Überschuss, Start wird übermittelt, freigegeben ohne Stromaufnahme, lädt intelligent/manuell, Pause angefordert, pausiert, gestört.
- „Akku voll“ nur bei eindeutiger Information; sonst „Fahrzeug nimmt derzeit keinen Strom an“.
- Datenalter/Wartezeiten im UI sekündlich aktualisieren; neue Backendzustände unmittelbar über SSE übertragen. Keine neuen Messungen vortäuschen. Tuya-Abfragefrequenz, Cache und mögliche Ereignisquellen prüfen, Grenzen dokumentieren. Nicht alle Geräte blind sekündlich pollen.
- Für Bedienaktionen sofort „Wird übernommen“ anzeigen. Ältere Antworten dürfen neuere Entscheidungen nicht überschreiben. Stopp muss auch während einer laufenden Änderung angenommen und priorisiert werden.
- Manuell: A-Wunsch, begrenzter wirksamer Sollwert, geschätzte kW und gemessene kW unterscheiden. Slider sofort lokal mitführen; nur abgeschlossene Änderung senden. Gerät-/Anschlussgrenzen korrekt anwenden, Haushaltsgrenze nicht pauschal dreiphasig anwenden.
- Manuell darf Netzstrom verwenden und braucht nicht zwingend PV-Messwerte; erforderliche Wallboxdaten, Gerätestörungen und Anschlussgrenzen bleiben verbindlich.
- Intelligent: verfügbare Leistung, Speicherreserve, Wartegrund und verbleibende Hysterese zeigen. Zügig bewerten, aber nicht sekündlich Schütze schalten oder identische Befehle wiederholen.
- „Netzbezug vermeiden“ als Regelziel beschreiben; nicht trotz Cloudlatenz absolut „kein Netzbezug“ garantieren. Modusfarbe ist kein Herkunftsnachweis.
- Wiederholte Bestätigungsdialoge für Manuell durch dauerhaften Hinweis „Bei Bedarf Netzstrom“ und eine eindeutige Moduswahl ersetzen.

## 4. Oberfläche: bestehende Gestaltung gezielt verbessern

### 4.1 Informationshierarchie und Navigation

Die Hausansicht ist ein prägendes, gelungenes Element und bleibt erhalten. Auf dem Handy verdrängen Illustration, sechs KPIs und viele Gerätekarten jedoch den Ladezugang.

- Mobile Navigation auf „Übersicht“, „Laden“, „Verlauf“, „Kosten“ ausrichten. Laden öffnet unmittelbar die Ladeansicht; kein Suchen in der letzten Gerätekarte.
- In der Übersicht vor der großen Illustration eine kompakte Fahrzeugzeile: Anschluss, Modus, Ist-Leistung bzw. Wartegrund, Zugang zu Ladeoptionen. Auch ein nicht angeschlossenes Fahrzeug bleibt verständlich auffindbar.
- Auf Desktop entsprechend einen sichtbaren Ladezugang im oberen Bereich vorsehen. Die Hausansicht und das klassische Diagramm bleiben umschaltbar.
- Gerätekarten auf Wert, Zustand und wichtigste Zusatzinformation reduzieren. Technische Quelle, Temperatur und Lebenszeitzähler in Details verschieben. Keine unnötige Wiederholung derselben Ladeleistung innerhalb einer Karte.
- Große Datenwerte klar priorisieren, sekundäre Beschriftung zurückhaltend, aber gut lesbar. Einheitliche Abstände und Typografie statt vieler einzelner Sonderstile.
- Ein festes Farbsystem beibehalten: PV, Haus, Auto, Netz, Speicher; Warnung/Fehler zusätzlich durch Text und Symbol unterscheiden. Manuell ist kein Fehler und soll nicht pauschal wie eine Warnung aussehen.
- Zahlendarstellung mit stabiler Breite und angemessener Rundung, keine ständig springenden Karten. Änderungen dezent hervorheben statt die ganze Fläche blinken zu lassen.

### 4.2 Eindeutige Begriffe

- „Haus gesamt inkl. Auto“ und „Haus ohne Auto“ konsequent unterscheiden. Dieselbe Bezeichnung muss in Hausgrafik, KPI, Karte und Verlauf dieselbe Größe meinen.
- Bei 0 W Netzfluss „Ausgeglichen“ statt „0 W Bezug“ verwenden; unbekannter Netzfluss bleibt unbekannt.
- „Max. Ladestrom“ nicht gleichzeitig für Gerätemaximum und aktuellen Sollwert verwenden: „Eingestellt“ und „Gerätegrenze“ trennen.
- „Verbinden“ an Geräten als „Datenverbindung prüfen“ oder „Erneut abfragen“ bezeichnen, damit es nicht wie ein Ladestart wirkt.
- Nicht verfügbarer Auto-SOC: „Vom Ladegerät nicht übermittelt“, keine scheinbar defekte Akkuanzeige und keine erfundene Prozentzahl.
- Einstellungstexte berichtigen: Tuya ist bei aktiver Regelung nicht „nur lesend“; Darstellung gilt pro Browser, Tarife und Lademodus gelten serverweit.
- Einheitlich „du“ oder neutrale Formulierungen verwenden; aktuelle Mischung mit „Ihr“ entfernen.

### 4.3 Bedienbarkeit und Barrierefreiheit

- Der Desktop-Stopp ist derzeit ein weitgehend ungestalteter kleiner Standardbutton; auf Touchgeräten wird er durch eine Wischbedienung ersetzt. Auf allen Geräten einen gut sichtbaren Button „Laden pausieren“/„Laden fortsetzen“ mit mindestens 44 × 44 CSS-Pixeln Trefferfläche anbieten. Wischen höchstens zusätzlich.
- Dialog beim Öffnen fokussieren, Tab-Fokus innerhalb halten, Hintergrund inert setzen, Escape und Fokus-Rückgabe an Auslöser sicherstellen.
- Chart-Legenden als echte Buttons mit sichtbarem und semantischem Aktivzustand. Tabs korrekt mit Auswahlzustand versehen. Diagramminhalte zusätzlich textlich zusammenfassen.
- Bestehende reduced-motion-Unterstützung erhalten und auf neue Animationen anwenden.
- Hell/Dunkel, 200 % Zoom und 360/390/768/1440 Pixel prüfen: kein horizontaler Überlauf, abgeschnittene Werte oder verdeckte Aktionen durch die untere Navigation.

## 5. Frontend-Zustand und Fehlerbehandlung stabilisieren

Betroffen vor allem app.js, index.html, styles.css und ev-bedienung.js.

- EV-Detailansicht bei Liveupdates nicht vollständig durch innerHTML ersetzen. Nur geänderte Werte und Zustände aktualisieren; Sliderbewegung, Fokus, Scrollposition, Eingaben und aufgeklappte Details erhalten.
- Zentrale JSON-Anfragefunktion mit Prüfung von HTTP-Status, Antwortformat und verständlicher Fehlerbehandlung verwenden. Bestehende Behandlung abgelaufener Sitzungen erhalten.
- loadDay und Zeitraumabfragen durch Request-Version/Abbruch gegen vertauschte Antworten schützen. Beispiel: erst Gestern langsam, dann Heute schnell; die verspätete Gestern-Antwort darf nicht unter „Heute“ erscheinen.
- Bei Ladefehlern keine leere Historie behaupten. Letzte bestätigte Daten mit Fehlerhinweis behalten, Wiederholen anbieten.
- Laufende Ladesession und Statistiken während geöffneter Ansicht tatsächlich nachführen, nicht nur beim Öffnen laden. Aktualisierung begrenzen und zusammenführen, keine pro SSE-Event mehrfach gestarteten Statistikabfragen.
- Heute-Ansicht beim Tageswechsel bewusst auf den neuen Tag wechseln; ein absichtlich ausgewähltes Archivdatum erhalten.
- Bei SSE-Ausfall Werte als „zuletzt bekannt“ kennzeichnen, Alter weiterlaufen lassen und aktive Flussanimationen stoppen. App-Verbindung und einzelne Geräteverbindung getrennt anzeigen.
- Nach Wiederverbindung vollständigen aktuellen Zustand laden. Auch ein offener, aber stummer Stream benötigt einen Frische-Wächter.
- app.js entlang der vorhandenen Verantwortungen schrittweise in Module teilen: Datenzugriff/Zustand, Energieansicht, Historie, EV, Einstellungen. Kein Großumbau ohne funktionalen Grund.

## 6. Gerätekommunikation und API robust machen

- modbus-client.ts: Transaktions-ID, Protokoll-ID, Unit-ID, Funktionscode, deklarierte Länge und Bytezahl gegen die Anfrage validieren; Eingangsgröße begrenzen.
- EOF/Socket-close mit unvollständiger Antwort muss die Promise beenden. Absolute Deadline vorsehen: socket.setTimeout allein ist nur Inaktivitätsüberwachung und kann durch kleine Datenstücke immer wieder hinausgeschoben werden.
- Fehler, Timeout und Abbruch müssen Socket und Timer aufräumen. Mit lokalem Fake-TCP-Server testen: fragmentierte gültige Frames, falsche IDs, Exception, vorzeitiges Ende, überlange Antwort und langsame Tropfantwort.
- ManagedConnector.probe gegen gleichzeitigen Poll/Reconnect absichern. Ein tatsächlich geworfener Fehler muss ebenfalls Diagnose/Backoff aktualisieren; nicht nur vom inneren Connector als offline zurückgegebene Daten.
- Engine-Polls dürfen nicht durch eine nie fertig werdende Quelle dauerhaft steckenbleiben. End-to-End-Deadlines und Abbruch sicherstellen; neue Polls nicht unkontrolliert aufstauen.
- Schreib-APIs strikt validieren: unbekannte Betriebsart nicht stillschweigend als intelligent behandeln; ungültiges an nicht als false und damit Fortsetzen auslegen. Fehlerhafte Requests ohne Zustandsänderung mit 400 beantworten.

## 7. Persistenz und Zugriffsschutz nachprüfen

Bereits verbessert: unabhängiges Laden von Dateien, Aufbewahrung beschädigter Dateien und Sitzungswiderruf bei Schreibfehlern. Diese Arbeit erhalten, folgende Restfälle gezielt ergänzen:

- Syntaktisch gültiges, aber fachlich ungültiges JSON validieren: Schema/Version, Datumswerte, endliche nichtnegative Energiesummen, Arrays und Gerätemetadaten. Keine pauschalen any-Casts als Validierung.
- Kann eine beschädigte Datei nicht gesichert/umbenannt werden, darf der nächste normale Persistenzlauf sie nicht doch überschreiben. Schreibsperre pro betroffenem Bestand plus sichtbare Diagnose und Wiederherstellungsweg.
- Relevante Schreibfehler nicht nur in console.warn verstecken: letzter erfolgreicher Speicherzeitpunkt, aktueller Fehler und Wiederholstatus für Admin sichtbar machen. Keine Erfolgsmeldung vor dauerhaftem Schreiben.
- Den Doppel-Fehlerfall beim Sitzungswiderruf testen: Speichern und Löschen schlagen fehl. Die derzeitige In-Memory-Sperre ist nach einem Neustart weg; daher keinen dauerhaften Widerruf behaupten. Eine nachvollziehbare fehlersichere Betriebs-/Wiederherstellungsstrategie implementieren und deren Grenzen dokumentieren.
- Forwarded-/Cloudflare-Header in auth.ts nur von explizit vertrauenswürdigen Proxy-Verbindungen übernehmen. Direkte LAN-Requests dürfen durch gefälschtes X-Forwarded-For keine neue Login-Throttle-Identität bekommen. HTTPS-Erkennung passend dazu behandeln.
- Rechte serverseitig ausdrücklich definieren: normale Familienbenutzer dürfen Dashboard und Ladebedienung nutzen; Tarif- und Kontenverwaltung bleiben Admin-Aufgaben. UI spiegelt dieselben Rechte wider. Keine nur im Frontend versteckten Berechtigungen.
- Bestehende Auth-Pflicht erhalten. Zustandsändernde Requests auf passende Methoden und Herkunftsschutz prüfen. Geheimnisse nicht in Fehlerantworten oder Diagnosen ausgeben.

## 8. Deployment, Healthcheck und PWA

Betroffen: .github/workflows/deploy.yml, Dockerfile, docker-compose.yml, deploy-Dokumentation, sw.js.

- Der Workflow stoppt derzeit den Dienst vor Kopieren und Installation. Einen neuen Release zuerst separat vorbereiten, Abhängigkeiten und Startvoraussetzungen prüfen; erst danach kontrolliert umschalten.
- Bei Fehlern automatisch auf den letzten funktionsfähigen Release zurückgehen. Teste auch Abbruch während des Deployments: cancel-in-progress darf den Server nicht nach dem Stoppen dauerhaft liegenlassen.
- Produktive config.json, secrets.json, data und Logs erhalten. Aktuell kopiert der Root-robocopy config.json mit; lokale Anlagenkonfiguration nicht unbemerkt durch Repo-Werte ersetzen.
- Einen minimalen Health-Endpunkt bereitstellen, der keine privaten Messwerte liefert und mit aktivierter Anmeldung für lokale Healthchecks funktioniert. Prozessgesundheit von einzelnen ausgefallenen Geräten trennen. Der aktuelle geschützte /api/snapshot ist ohne Session kein geeigneter Healthcheck.
- Geordneten Shutdown samt Persistenz ermöglichen; zwangsweises Beenden nur als dokumentierte letzte Stufe und nur für den identifizierten App-Prozess.
- Docker: schreibgeschützte Cloud-Secrets und schreibbare Konten-/Sitzungsdaten sauber trennen; Migration für bestehendes auth in secrets.json anbieten. Nicht einfach alle Secrets schreibbar machen.
- PWA-Updates versionskonsistent testen: keine Mischung inkompatibler JS-Module, keine gecachten API-/Kontendaten, keine gespeicherten Login-Redirects als App-Shell. Einen verständlichen Aktualisierungshinweis vorsehen, ohne laufende Sliderbedienung unaufgefordert neu zu laden.
- deploy/README.md und weitere Betriebsanleitungen aktualisieren: Aussagen „kein Passwort-Login“ bzw. „ohne secrets läuft alles außer Wallbox“ passen nicht mehr zur Auth-Pflicht.

## 9. Abnahme und Ergebnis

Ergänze Regressionstests an den betroffenen fachlichen Stellen, nicht nur Tests, die den neuen Code nacherzählen. Bestehende Tests ändern, wenn eine oben ausdrücklich gewollte Produktentscheidung ihr altes Soll ersetzt; Sicherheitsregressionen erhalten.

Mindestens nachweisen:
1. null bleibt unbekannt; tatsächliche Null bleibt gültig; Schätzung ist gekennzeichnet.
2. Netzladung erzeugt keinen erfundenen PV-Anteil; Quellen/Senken bleiben bilanziell konsistent.
3. Messausfall und Neustart erzeugen nachvollziehbare Lücken in Summe, Kurve und Abdeckung.
4. Mitternacht, Sommerzeit, Browser in anderer Zeitzone und Sessions über Monatsgrenzen stimmen.
5. Tarifwechsel verändert frühere Kosten nicht; Schreibfehler erscheint nicht als Erfolg.
6. Gespeicherter Lademodus und Strom bleiben erhalten; Pause, Offline und Abstecken unterscheiden sich.
7. Stopp überholt laufende Befehle; UI verwechselt Wunsch nicht mit gemessenem Laden.
8. Gleichzeitige Liveupdates zerstören weder Eingaben noch Fokus; verspätete Antworten überschreiben nichts Neueres.
9. Unvollständige/fehlerhafte TCP-Antworten lassen keinen Poll hängen.
10. Beschädigte Daten bleiben erhalten; Rechte und Proxy-Vertrauen sind serverseitig geprüft.
11. Healthcheck funktioniert bei aktivierter Anmeldung; fehlerhafte Release-Vorbereitung lässt den alten Server weiterlaufen.

Zusätzlich echte Browser-Prüfung mit isoliertem Fixture-Server für sonnig/ladend, nachts, wartet auf Überschuss, manuell, pausiert, ein Speicher offline, Daten veraltet, leere Historie, HTTP-Fehler und langsame Antworten. Keine echten Anlagensteuerungen im Test. UI auf Mobil/Desktop und in Hell/Dunkel fotografisch prüfen; reine Typechecks reichen dafür nicht.

Führe npm run typecheck und npm test aus. Dokumentiere Ergebnisse und nicht mögliche Prüfungen ehrlich. Aktualisiere die Übergabedokumentation und beschreibe nötige Migrationen/Config-Ergänzungen. Abschließend knapp nennen: umgesetzt, getestet, verbleibende Grenzen; keinen Produktionsbetrieb behaupten, der nicht geprüft wurde.
