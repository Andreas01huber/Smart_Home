# Push → Test → Server läuft neu

Ziel: Du änderst etwas am Code, machst `git push`, und wenige Minuten später
läuft auf dem Server zu Hause der neue Stand. Ohne ZIP, ohne Kopieren, ohne
Handgriffe am Server.

Der Server läuft dabei **direkt unter Windows mit Node**, nicht in Docker — die
Maschine ist dafür zu alt. Gestartet wird er über die geplante Aufgabe
`SmartHome`, die [run-server.cmd](run-server.cmd) ausführt.

Der Ablauf steht in [.github/workflows/deploy.yml](../.github/workflows/deploy.yml):

1. **GitHub prüft** auf einem geliehenen Linux-Rechner Typen und alle Tests.
2. **Nur wenn das grün ist**, hält der Server zu Hause den laufenden Dienst an,
   holt den neuen Stand und startet ihn wieder.
3. **Der Workflow prüft nach**, ob der Server wirklich antwortet — und schlägt
   fehl, wenn nicht. „Gestartet" ist nicht dasselbe wie „läuft".

Schritt 2 kann kein Rechenzentrum übernehmen: Die App liest Fronius und Victron
**lokal im Heimnetz**. Deshalb läuft dieser Teil auf deinem eigenen Server, über
einen sogenannten *self-hosted Runner* — ein kleines Programm, das dort auf
Aufträge von GitHub wartet.

---

## Einmalige Einrichtung

### 1. Repository verbinden

Im Projektordner auf deinem Arbeits-PC:

```bash
git remote add origin https://github.com/<dein-account>/Smart_Home.git
```

```bash
git push -u origin main
```

Vorher lohnt ein Blick auf `git status`: `secrets.json`, `data/` und
`node_modules/` dürfen dort **nicht** auftauchen — die
[.gitignore](../.gitignore) hält sie draußen.

### 2. Node und Autostart-Aufgabe auf dem Server

Auf dem Server einmalig
[Server-PC einrichten.cmd](../Server-PC%20einrichten.cmd) ausführen. Das
installiert die Abhängigkeiten, öffnet die Firewall und legt die geplante
Aufgabe `SmartHome` an, die den Server bei jedem Hochfahren startet.

Der Workflow legt diese Aufgabe **nicht** selbst an: Dafür bräuchte er
Administratorrechte, die der Runner-Dienst nicht hat. Fehlt sie, bricht der
Deploy mit einer entsprechenden Meldung ab.

Node muss in Version **22 oder neuer** installiert sein — der Workflow prüft das
und sagt es deutlich, wenn nicht.

### 3. Runner auf dem Server installieren

Auf GitHub im Repository: **Settings → Actions → Runners → New self-hosted
runner → Windows**. GitHub zeigt dort einen fertigen Befehlsblock mit einem
Token — den in einer PowerShell auf dem Server ausführen.

Bei der Frage nach Labels zusätzlich `windows` vergeben, falls es nicht ohnehin
gesetzt ist; der Workflow sucht nach `self-hosted` **und** `windows`.

Danach den Runner als Dienst einrichten, damit er einen Neustart übersteht:

```bash
./svc.cmd install
```

```bash
./svc.cmd start
```

Ein Hinweis zu den Rechten: Der Dienst muss die geplante Aufgabe `SmartHome`
starten und anhalten dürfen. Als `NT AUTHORITY\NETWORK SERVICE` — die
Voreinstellung — geht das für eine Aufgabe, die unter `SYSTEM` läuft, nicht
zuverlässig. Scheitert der Schritt „Server starten" an fehlenden Rechten, den
Dienst mit einem Administratorkonto einrichten:

```bash
./svc.cmd uninstall
```

```bash
./svc.cmd install DEIN-PC\dein-benutzername
```

### 4. Zugangsdaten auf dem Server ablegen

`secrets.json` ist absichtlich nicht im Repository. Einmalig von Hand nach
`C:\SmartHome\secrets.json` kopieren.

Fehlt die Datei, meldet der Workflow eine Warnung und läuft weiter: Alles außer
der Wallbox funktioniert auch ohne sie.

### 5. Historie übernehmen

Auch `data/` bleibt außerhalb des Repositories. Wenn die bisherige Historie
mitkommen soll, den Ordner einmalig nach `C:\SmartHome\data` kopieren. Danach
fasst ihn kein Deploy mehr an.

---

## Der Alltag danach

```bash
git push
```

Mehr nicht. Den Fortschritt zeigt im Repository der Reiter **Actions**. Am Ende
listet der Workflow die Adressen auf, unter denen das Dashboard erreichbar ist.

Ein Deploy ohne Code-Änderung — etwa nach einer Änderung an `config.json` auf
dem Server — geht über **Actions → Test und Deploy → Run workflow**.

---

## Was der Deploy anfasst und was nicht

| | |
| --- | --- |
| **Wird überschrieben** | Quellcode, `config.json`, Startskripte, Anleitungen |
| **Bleibt unangetastet** | `C:\SmartHome\data` (Historie), `secrets.json`, `logs\`, `node_modules\`, eine lokale `.env` |
| **Kommt gar nicht an** | `.git`, `.github` |

Kopiert wird in zwei Durchgängen. Die Dateien im Projektstamm kommen ohne
Unterordner und ohne Löschen (`/LEV:1`) — dort liegen `data\`, `secrets.json`,
`logs\` und `node_modules\`. Die Ordner `apps`, `packages`, `tools`, `deploy`
und `docs` dagegen als **Spiegel** (`/MIR`): Was du im Repository löschst oder
umbenennst, verschwindet damit auch auf dem Server. Ohne Spiegel bliebe die alte
Datei dort liegen und würde weiter ausgeliefert.

Dass beim Spiegeln gelöscht werden darf, ist ungefährlich — nicht weil die
Ausschlussschalter stimmen, sondern weil alles Schützenswerte im Stamm liegt und
damit außerhalb der gespiegelten Bäume. Das lässt sich nicht versehentlich
kaputtkonfigurieren.

`npm ci` läuft nur, wenn `package-lock.json` sich geändert hat oder
`node_modules` fehlt — gemerkt an einer Prüfsumme. Sonst wäre jeder Deploy
unnötig langsam und würde ohne Internet scheitern, obwohl sich nichts geändert
hat.

---

## Ein Nebeneffekt, den du kennen solltest

Der Deploy beendet den laufenden Server hart. Windows kennt kein sauberes
Abbruchsignal für einen Hintergrundprozess, deshalb geht das nicht anders.

Verloren gehen dabei die Energiewerte **seit dem letzten automatischen
Sichern** — die Historie schreibt sich alle zwei Minuten selbst weg, mehr als
zwei Minuten sind es also nie. Für die Tagesbilanz ist das nicht spürbar; wer
ganz sicher gehen will, deployt nicht mitten in der Mittagsspitze.

---

## Wenn auf dem Server nichts ankommt

Der häufigste Fall, und der unauffälligste: Der Push ist durch, GitHub meldet
nichts Auffälliges, aber im Ordner `C:\SmartHome` liegt weiter der alte Stand.

Auf dem Server nachsehen — **Server pruefen.cmd** doppelklicken. Das Skript
liest nur und sagt am Ende, woran es liegt.

Die drei Ursachen, in der Reihenfolge ihrer Häufigkeit:

**1. Der Runner darf den Server nicht anhalten.** Der Server läuft als geplante
Aufgabe unter `SYSTEM`, damit er schon vor dem Anmelden startet. Der
Runner-Dienst läuft in der Voreinstellung unter `NETWORK SERVICE` und darf einen
SYSTEM-Prozess weder beenden noch dessen Aufgabe steuern. Der Deploy scheitert
dann im Schritt **Server anhalten** — also *bevor* er kopiert. Deshalb ändert
sich auf dem Server nichts, obwohl der Push angekommen ist.

Behebung: **Runner reparieren.cmd** als Administrator ausführen. Es stellt den
Dienst auf das lokale Systemkonto um und startet ihn neu.

**2. Der Runner-Dienst läuft gar nicht.** Dann bleibt der Job auf GitHub bei
„Waiting for a runner" stehen und tut nie etwas — ohne Fehlermeldung, denn
gescheitert ist er nicht, er wartet nur. Sichtbar in `Server pruefen.cmd` oder
auf GitHub unter **Settings → Actions → Runners**: Steht dort *Offline*, ist es
das.

**3. Der Testlauf war rot.** Dann wird bewusst nicht ausgeliefert
(`needs: test`). Auf GitHub unter **Actions** steht, welcher Test gescheitert
ist.

Welcher Stand tatsächlich auf dem Server liegt, steht in `C:\SmartHome\VERSION.txt`
— die schreibt der Workflow bei jedem erfolgreichen Deploy:

```bash
type C:\SmartHome\VERSION.txt
```

Fehlt die Datei, ist seit ihrer Einführung kein Deploy mehr durchgelaufen.

---

## Wenn der Deploy rot wird

| Meldung | Ursache |
| --- | --- |
| Job bleibt auf „Waiting for a runner" | Der Runner-Dienst läuft nicht: auf dem Server `./svc.cmd status`. |
| `Der Runner darf den laufenden Server nicht beenden` | Rechteproblem, siehe oben — `Runner reparieren.cmd` als Administrator. |
| `Node.js ist auf dem Server nicht installiert` | Node 22+ fehlt — `Server-PC einrichten.cmd` ausführen. |
| `Die Aufgabe "SmartHome" fehlt` | Einmalig `Server-PC einrichten.cmd` auf dem Server ausführen. |
| `Port 4173 ist nach 20 Sekunden noch belegt` | Ein hängender Node-Prozess. Im Task-Manager beenden, dann Deploy wiederholen. |
| `npm ci ist fehlgeschlagen` | Der Server hat gerade kein Internet. |
| `Der Server antwortet nach 90 Sekunden nicht` | Der Workflow hängt die letzten 60 Zeilen aus `logs\server.log` an — dort steht der eigentliche Fehler. |
| Tests rot, Deploy übersprungen | So gewollt. Erst reparieren, dann geht es von selbst weiter. |

Auf dem Server direkt nachsehen:

```bash
Get-Content C:\SmartHome\logs\server.log -Tail 50 -Wait
```

---

## Kosten

Der Testlauf nutzt GitHub-eigene Linux-Rechner; private Repositories haben dafür
ein monatliches Freikontingent, das für dieses Projekt reichlich bemessen ist.
Der Deploy-Teil läuft auf deiner eigenen Hardware und kostet nichts.
