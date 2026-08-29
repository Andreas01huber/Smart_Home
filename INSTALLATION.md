# SmartHome auf einem zweiten PC einrichten

Diese Anleitung macht aus einem beliebigen Windows-PC im Heimnetz den Server,
auf dem SmartHome **durchgehend** läuft — auch wenn der bisherige Laptop aus ist.

---

## Vorher kurz prüfen

| | |
| --- | --- |
| **Betriebssystem** | Windows 10 oder 11 |
| **Netzwerk** | Derselbe Router wie Fronius, Victron und Handy. LAN-Kabel ist stabiler als WLAN. |
| **Node.js** | Version 22 oder neuer — falls nicht vorhanden, meldet sich der Assistent und öffnet die Download-Seite |
| **Internet** | Nur einmalig für die Installation der Abhängigkeiten nötig, danach nicht mehr |

Der PC muss **eingeschaltet bleiben**. Ein Laptop mit zugeklapptem Deckel geht
sonst schlafen und der Server ist weg — siehe [Damit der PC nicht einschläft](#damit-der-pc-nicht-einschläft).

---

## Einrichtung in drei Schritten

### 1. Entpacken

ZIP auf den neuen PC kopieren und entpacken, zum Beispiel nach
`C:\SmartHome` oder in `Dokumente`.

Wichtig: **wirklich entpacken**, nicht nur im ZIP-Fenster öffnen. Windows zeigt
den Inhalt eines ZIPs wie einen normalen Ordner an — gestartet werden kann die
App von dort aber nicht. Rechtsklick auf die Datei → *Alle extrahieren*.

Ein Pfad ohne Leerzeichen und ohne OneDrive-Synchronisierung ist am
unproblematischsten.

### 2. `Server-PC einrichten.cmd` doppelklicken

Der Assistent erledigt alles Weitere:

1. prüft Node.js
2. installiert die Abhängigkeiten (`npm install`, dauert ein bis zwei Minuten)
3. öffnet die Windows-Firewall für Port 4173 im **privaten** Netz
4. richtet den Autostart ein und startet den Server sofort

Windows fragt dabei zweimal nach — einmal beim Skript selbst, einmal wegen der
Administratorrechte. Beides mit **Ja** bestätigen.

Am Ende zeigt das Fenster die Adressen, unter denen die App erreichbar ist.

### 3. Vom Handy öffnen

Im Browser des Handys die angezeigte Adresse eingeben, also zum Beispiel:

```
http://192.168.178.50:4173
```

Dann im Browsermenü **„Zum Startbildschirm hinzufügen"** wählen. Danach liegt
SmartHome wie eine normale App auf dem Handy — mit eigenem Icon und im Vollbild.

---

## Damit die Adresse stabil bleibt

Der Router vergibt IP-Adressen normalerweise dynamisch; nach einem Neustart
könnte der Server-PC eine andere bekommen und die Handy-Verknüpfung zeigt ins
Leere.

**FritzBox:** `http://fritz.box` öffnen → **Heimnetz → Netzwerk** → den Server-PC
anklicken → **„Diesem Netzwerkgerät immer die gleiche IPv4-Adresse zuweisen"**.

Andere Router nennen das „DHCP-Reservierung" oder „statische Zuweisung".

---

## Damit der PC nicht einschläft

Der häufigste Grund, warum ein Server-Laptop nachts nicht erreichbar ist.

1. **Einstellungen → System → Netzbetrieb und Energiesparen**
   - *Bildschirm ausschalten nach*: beliebig
   - *Ruhezustand nach*: **Nie** (sowohl im Akku- als auch im Netzbetrieb)
2. Bei einem Laptop zusätzlich: **Systemsteuerung → Energieoptionen →
   Auswählen, was beim Zuklappen des Deckels geschehen soll** → **Nichts tun**.
   Sonst schläft der PC, sobald der Deckel zugeht.
3. Netzteil angesteckt lassen.

Der eingerichtete Autostart läuft bewusst auch im Akkubetrieb weiter — Windows
würde eine Aufgabe sonst beim Wechsel auf Akku beenden.

---

## Was im ZIP steckt

| Ordner / Datei | Inhalt |
| --- | --- |
| `apps`, `packages`, `tools` | der Programmcode |
| `config.json` | IP-Adressen von Fronius und Victron, Port, Tarife |
| `secrets.json` | Zugangsdaten der Wallbox-Cloud |
| `data` | die bisherige Historie — Tageswerte und Ladevorgänge ziehen mit um |
| `deploy` | Autostart, Firewall, Anleitung für Dauerbetrieb und VPN |
| `docs` | Dokumentation der Anlage und der Entwicklungsschritte |

**`secrets.json` enthält echte Zugangsdaten** zur Tuya-Cloud der Wallbox. Das
ZIP also nicht weitergeben und nicht in einen geteilten Cloud-Ordner legen.

`node_modules` ist **nicht** enthalten. Dieser Ordner enthält Verknüpfungen mit
festen Pfaden auf den ursprünglichen PC und wäre auf einem anderen Rechner
kaputt — `npm install` legt ihn im zweiten Schritt sauber neu an.

---

## Wenn sich im Heimnetz etwas ändert

`config.json` im Projektordner enthält die Adressen der Anlage:

```json
"fronius":     { "host": "192.168.178.121" }
"froniusGen24":{ "host": "192.168.178.39" }
"victron":     { "host": "192.168.178.73" }
```

Bekommen Wechselrichter oder Victron GX eine andere IP, hier anpassen und den
Server neu starten. Welche Geräte gerade im Netz erreichbar sind, zeigt:

```bash
npm run discover
```

Ob der komplette Datenpfad stimmt, prüft:

```bash
npm run preflight
```

---

## Der alte Laptop

Nach dem Umzug kann SmartHome dort einfach nicht mehr gestartet werden — es
muss nichts deinstalliert werden.

Beide Rechner gleichzeitig laufen zu lassen, funktioniert zwar (beide lesen die
Anlage nur aus), ist aber nicht sinnvoll: Jeder schreibt seine **eigene**
Historie mit, und je nachdem, welche Adresse gerade aufgerufen wird, sind die
Tageswerte unterschiedlich. Besser den Autostart auf dem alten Laptop entfernen:

```bash
schtasks /Delete /TN SmartHome /F
```

---

## Wenn etwas nicht läuft

| Symptom | Ursache und Abhilfe |
| --- | --- |
| Handy erreicht die Adresse nicht | Meistens steht das WLAN auf **Öffentlich** — dann greift die Firewall-Regel nicht. Einstellungen → Netzwerk und Internet → auf die Verbindung klicken → **Privat**. Danach `Server-PC einrichten.cmd` noch einmal ausführen. Zweite Möglichkeit: Das Handy hängt im Gast-WLAN, das ist vom Heimnetz getrennt. |
| Nach Neustart läuft nichts | Autostart prüfen: `schtasks /Query /TN SmartHome`. Nicht vorhanden → `Server-PC einrichten.cmd` erneut ausführen. |
| „Nicht verbunden" bei einem Gerät | IP in `config.json` prüfen, `npm run discover` ausführen. |
| Wallbox zeigt „nicht erreichbar" | `secrets.json` fehlt oder der Server-PC hat kein Internet. Die Wallbox wird über die Tuya-Cloud gelesen. |
| Seite lädt alt / veraltet aus | Im Browser einmal hart neu laden (`Strg+F5`). Die App speichert sich für den Offline-Fall zwischen. |
| Port 4173 belegt | In `config.json` `"port"` ändern und die Firewall-Regel entsprechend anpassen. |

Läuft der Server, meldet er beim Start im Fenster alle Adressen, unter denen er
erreichbar ist. Das ist der schnellste Weg zu prüfen, ob er wirklich lebt.

---

## Ohne Autostart starten

Zum Ausprobieren, ohne etwas dauerhaft einzurichten: Doppelklick auf
**`SmartHome starten.cmd`**. Der Server läuft dann nur, solange das Fenster
offen ist, und der Browser öffnet sich von selbst.

---

## Alternative: Docker

Läuft auf dem Zielgerät Docker (Linux-Server, NAS, Raspberry Pi, Docker Desktop),
geht es auch ohne Node-Installation und ohne Autostart-Aufgabe. Im Projektordner:

```bash
docker compose up -d
```

Das war alles. Der Container startet ab jetzt bei jedem Boot mit, bringt Node
selbst mit und ist unter `http://<IP>:4173` erreichbar.

| Befehl | Wirkung |
| --- | --- |
| `docker compose logs -f` | mitlesen, was der Server meldet |
| `docker compose restart` | neu starten, etwa nach einer Änderung an `config.json` |
| `docker compose up -d --build` | nach Code-Änderungen neu bauen |
| `docker compose down` | anhalten |

`config.json`, `secrets.json` und `data/` bleiben dabei **außerhalb** des Images
und werden vom Host eingehängt: Zugangsdaten landen nicht im Image, Adressen und
Tarife lassen sich ohne Neubau ändern, und die Historie überlebt jedes Update.

Ein Punkt ist wichtiger, als er aussieht: Die Zeitzone steht im Container fest auf
`Europe/Berlin`. Der Tageswechsel der Historie liegt auf der Orts-Mitternacht —
ohne diese Angabe würde der Container in UTC rechnen und der Tag im Sommer zwei
Stunden zu früh umspringen.

Auf einem Windows-PC ist der Weg über `Server-PC einrichten.cmd` einfacher; Docker
lohnt sich vor allem auf einem NAS, einem Raspberry Pi oder einem Linux-Server.

---

## Anmeldung einrichten

**Pflicht, sobald die App über einen Tunnel erreichbar ist.** Im Heimnetz schützt
der Router; eine öffentliche Adresse hat diesen Schutz nicht, und die App kennt
schreibende Aufrufe — Tarife ändern, Geräte neu verbinden.

Auf dem Server im Projektordner:

```bash
npm run passwort
```

Das fragt Benutzername und Passwort ab und schreibt beides nach `secrets.json` —
das Passwort **nur als scrypt-Hash**, nie im Klartext. Danach den Server einmal
neu starten; die Anmeldung wird beim Start gelesen.

Ohne eingerichtete Anmeldung läuft alles weiter wie bisher, der Server weist
beim Start aber deutlich darauf hin.

### Was das für den Alltag bedeutet

Die Anmeldung bleibt **ein Jahr** gespeichert und verlängert sich bei jedem
Besuch — wer die App regelmäßig benutzt, meldet sich praktisch nie wieder an.
Der Browser bietet außerdem an, die Zugangsdaten im Passwortspeicher zu sichern;
das Formular ist dafür passend ausgezeichnet.

Abmelden geht über **Einstellungen → Konto → Abmelden**. Nötig ist das nur auf
einem fremden Gerät.

Ein geändertes Passwort meldet **alle** Geräte ab — das ist der Weg, ein Gerät
loszuwerden, das man verloren hat.

### Was der Schutz leistet

| | |
| --- | --- |
| Passwort | Als scrypt-Hash gespeichert. Wer `secrets.json` liest, kann sich damit nicht anmelden. |
| Sitzung | Signierter Keks, `HttpOnly` — für Skripte im Browser unsichtbar. Übersteht einen Neustart des Servers, ohne dass jemand sich neu anmelden muss. |
| Verschlüsselung | Das `Secure`-Kennzeichen wird nur bei HTTPS gesetzt. Im Heimnetz läuft die App über `http://…:4173`, dort würde ein Secure-Keks nie ankommen. |
| Durchprobieren | Ab dem fünften Fehlversuch je Herkunft gesperrt, die Sperre verdoppelt sich bis auf eine Viertelstunde. |
| Suchmaschinen | Die Anmeldeseite ist auf `noindex` gesetzt. |

### Grenzen — bitte lesen

Eine `trycloudflare.com`-Adresse ist ein **Schnelltunnel**: öffentlich
erreichbar für jeden, der die Adresse kennt, und die Adresse **ändert sich bei
jedem Neustart** des Tunnels. Für den Dauerbetrieb ist das nichts.

Wer den Tunnel behalten will, richtet bei Cloudflare einen **benannten Tunnel**
mit fester Adresse ein. Noch besser: **Cloudflare Access** davorschalten — dann
kommt niemand ohne Anmeldung überhaupt bis zum Server durch, und die Anmeldung
hier ist die zweite Schicht statt der einzigen.

Unabhängig davon terminiert Cloudflare die Verschlüsselung, sieht den Verkehr
also im Klartext. Wenn das stört, ist der VPN-Weg unten der richtige.

---

## Von unterwegs zugreifen

Nicht über eine Portfreigabe — die Anlage gehört nicht offen ins Internet. Der
sichere und kostenlose Weg steht in [deploy/README.md](deploy/README.md):
WireGuard-VPN in der FritzBox oder, bei DS-Lite-Anschlüssen, Tailscale.
