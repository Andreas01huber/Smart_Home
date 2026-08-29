# Push → Test → Container läuft

Ziel: Du änderst etwas am Code, machst `git push`, und wenige Minuten später
läuft auf dem Server zu Hause der neue Stand im Docker-Container. Ohne ZIP, ohne
Kopieren, ohne Handgriffe am Server.

Der Ablauf steht in [.github/workflows/deploy.yml](../.github/workflows/deploy.yml):

1. **GitHub prüft** auf einem geliehenen Linux-Rechner Typen und alle Tests.
2. **Nur wenn das grün ist**, holt der Server zu Hause den neuen Stand und
   startet den Container neu.
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
git init -b main
git add -A
git commit -m "SmartHome"
git remote add origin https://github.com/<dein-account>/Smart_Home.git
git push -u origin main
```

Vorher lohnt ein Blick auf `git status`: `secrets.json`, `data/` und
`node_modules/` dürfen dort **nicht** auftauchen — die
[.gitignore](../.gitignore) hält sie draußen.

### 2. Docker Desktop auf dem Server

Muss installiert **und gestartet** sein. Ein Punkt, über den fast jeder stolpert:
Docker Desktop startet unter Windows normalerweise erst, wenn sich ein Benutzer
anmeldet. Auf einem Server, der nur hochfährt, läuft dann nichts.

Zwei Wege:

- In Docker Desktop unter **Settings → General** die Option
  **„Start Docker Desktop when you log in"** aktivieren und den Server so
  einrichten, dass er sich nach dem Hochfahren automatisch anmeldet.
- Oder auf Docker Desktop verzichten und die App über
  [Server-PC einrichten.cmd](../Server-PC%20einrichten.cmd) direkt mit Node
  betreiben. Dann entfällt dieser Workflow-Teil.

### 3. Runner auf dem Server installieren

Auf GitHub im Repository: **Settings → Actions → Runners → New self-hosted
runner → Windows**. GitHub zeigt dort einen fertigen Befehlsblock mit einem
Token — den in einer PowerShell auf dem Server ausführen.

Bei der Frage nach Labels zusätzlich `windows` vergeben, falls es nicht ohnehin
gesetzt ist; der Workflow sucht nach `self-hosted` **und** `windows`.

Danach den Runner als Dienst einrichten, damit er einen Neustart übersteht —
und zwar **unter dem Benutzer, unter dem auch Docker Desktop läuft**:

```bash
./svc.cmd install DEIN-PC\dein-benutzername
```

```bash
./svc.cmd start
```

Der Benutzername ist hier nicht optional, auch wenn `./svc.cmd install` ohne
Argument funktioniert. Ohne ihn läuft der Dienst als `NT AUTHORITY\NETWORK
SERVICE`, und dieses Konto kommt an die Docker-Engine nicht heran: Docker Desktop
gibt seine Named Pipe nur der lokalen Gruppe `docker-users` frei, in der ein
Dienstkonto standardmäßig nicht ist. Der Deploy scheitert dann mit
„Docker antwortet nicht", obwohl Docker sichtbar läuft.

Ist der Dienst schon ohne Benutzer eingerichtet, hilft entweder ein
`./svc.cmd uninstall` und eine Neuinstallation mit Benutzernamen — oder das
Konto nachträglich in die Gruppe aufnehmen (Eingabeaufforderung als
Administrator):

```bash
net localgroup docker-users "NETWORK SERVICE" /add
```

### 4. Zugangsdaten auf dem Server ablegen

`secrets.json` ist absichtlich nicht im Repository. Einmalig von Hand nach
`C:\SmartHome\secrets.json` kopieren.

Fehlt die Datei, legt der Workflow einen Platzhalter an und meldet eine Warnung:
Alles außer der Wallbox läuft dann normal weiter. (Der Platzhalter ist kein
Schönheitsfehler — ohne ihn würde Docker beim Einhängen einen *Ordner* dieses
Namens anlegen, und der Container startet gar nicht mehr.)

### 5. Historie übernehmen

Auch `data/` bleibt außerhalb des Repositories. Wenn die bisherige Historie
mitkommen soll, den Ordner einmalig nach `C:\SmartHome\data` kopieren. Danach
fasst ihn kein Deploy mehr an.

---

## Der Alltag danach

```bash
git push
```

Mehr nicht. Den Fortschritt zeigt im Repository der Reiter **Actions**.

Ein Deploy ohne Code-Änderung — etwa nach einer Änderung an `config.json` auf
dem Server — geht über **Actions → Test und Deploy → Run workflow**.

---

## Was der Deploy anfasst und was nicht

| | |
| --- | --- |
| **Wird überschrieben** | Quellcode, `Dockerfile`, `docker-compose.yml`, `config.json`, Anleitungen |
| **Bleibt unangetastet** | `C:\SmartHome\data` (Historie), `C:\SmartHome\secrets.json`, eine lokale `.env` |
| **Kommt gar nicht an** | `.git`, `.github`, `node_modules` |

Kopiert wird in zwei Durchgängen. Die Dateien im Projektstamm kommen ohne
Unterordner und ohne Löschen (`/LEV:1`) — dort liegen `data\` und
`secrets.json`. Die Ordner `apps`, `packages`, `tools`, `deploy` und `docs`
dagegen als **Spiegel** (`/MIR`): Was du im Repository löschst oder umbenennst,
verschwindet damit auch auf dem Server. Ohne Spiegel bliebe die alte Datei dort
liegen und landete weiter im Image.

Dass beim Spiegeln gelöscht werden darf, ist ungefährlich — nicht weil die
Ausschlussschalter stimmen, sondern weil `data\` und `secrets.json` im Stamm
liegen und damit außerhalb der gespiegelten Bäume. Das lässt sich nicht
versehentlich kaputtkonfigurieren.

---

## Wenn der Deploy rot wird

| Meldung | Ursache |
| --- | --- |
| `Docker antwortet nicht` | Docker Desktop läuft auf dem Server nicht — siehe Punkt 2. |
| Job bleibt auf „Waiting for a runner" | Der Runner-Dienst läuft nicht: auf dem Server `./svc.cmd status`. |
| `Der Server antwortet nach 90 Sekunden nicht` | Der Workflow hängt `docker compose ps` und die letzten 60 Log-Zeilen an — dort steht der eigentliche Fehler. |
| Tests rot, Deploy übersprungen | So gewollt. Erst reparieren, dann geht es von selbst weiter. |

Auf dem Server direkt nachsehen:

```bash
docker compose -f C:\SmartHome\docker-compose.yml logs -f
```

---

## Kosten

Der Testlauf nutzt GitHub-eigene Linux-Rechner; private Repositories haben dafür
ein monatliches Freikontingent, das für dieses Projekt reichlich bemessen ist.
Der Deploy-Teil läuft auf deiner eigenen Hardware und kostet nichts.
