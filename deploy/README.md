# Dauerbetrieb & Fernzugriff (kostenlos)

Ziel: Die App läuft **24/7 im Heimnetz** (nicht mehr am Laptop) und ist von
unterwegs **sicher über VPN** erreichbar — ohne Hosting, ohne Abo, ohne die
Anlage offen ins Internet zu stellen.

> Warum ein Gerät zu Hause nötig ist: Die App liest Fronius und Victron **lokal**
> im Heimnetz aus. Ein reiner Cloud-Betrieb ohne Gerät zu Hause ist deshalb nicht
> möglich. Der Laptop darf aber aus sein.

---

## 1. Welches Dauergerät?

| Option | Kosten | Strom | Aufwand | Für dich |
| --- | --- | --- | --- | --- |
| **Gebrauchter Mini-PC** (Intel NUC, HP/Fujitsu Thin Client) mit SSD, Windows | ~30–70 € gebraucht | ~6–15 W | **gering** | Gleiche Bedienung wie jetzt (Windows), nur immer an. **Empfohlen, weil am einfachsten.** |
| **Raspberry Pi 4/5** (2 GB) + Netzteil + gute SD/SSD + Gehäuse | ~70–100 € neu | ~3–5 W | mittel (einmalig Linux einrichten) | Am sparsamsten, braucht einmalige Linux-Einrichtung. |
| Vorhandene **NAS** (Synology/QNAP) | 0 € (falls vorhanden) | — | mittel (Docker) | Nur sinnvoll, wenn du schon eine hast. |

**Empfehlung für dich:** ein **gebrauchter Mini-PC mit SSD und Windows**. Dann
kopierst du einfach den Projektordner darauf und richtest den Autostart ein
(unten) — kein Linux nötig. Strom kostet ~10–20 €/Jahr.

Wichtig bei einem Raspberry Pi: eine **hochwertige SD-Karte (A2/High-Endurance)**
oder besser eine kleine **USB-SSD** verwenden — die App schreibt regelmäßig
Daten, billige SD-Karten verschleißen sonst.

---

## 2. Autostart (App läuft ohne Anmeldung)

### Windows (Mini-PC / PC)
1. Projektordner `AppSmartHome` auf das Dauergerät kopieren.
2. Einmal `SmartHome starten.cmd` ausführen → beim ersten Mal `npm install`.
3. `deploy/Autostart einrichten (Windows).cmd` **einmal** ausführen (Admin-Nachfrage mit Ja).
   → Der Server startet ab jetzt automatisch beim Hochfahren und nach Absturz.

### Raspberry Pi / Linux
Siehe Kopf der Datei `deploy/energie.service` (systemd-Dienst mit Auto-Neustart).

---

## 3. Feste IP im Router (empfohlen)

Damit die App-Adresse stabil bleibt: in der **FritzBox** unter
**Heimnetz → Netzwerk** das Dauergerät auswählen und
**„Diesem Gerät immer die gleiche IPv4-Adresse zuweisen"** aktivieren.

---

## 4. Fernzugriff über FritzBox-VPN (WireGuard, gratis)

Voraussetzung: FritzBox mit **FRITZ!OS 7.50 oder neuer** (dann ist WireGuard eingebaut).
FRITZ!OS-Version steht in der FritzBox-Oberfläche unten.

1. Am PC im Browser `http://fritz.box` öffnen, anmelden.
2. **Internet → Freigaben → Reiter „VPN (WireGuard)"** → **„Verbindung hinzufügen"**.
3. Verbindung für ein **Gerät** (dein Handy) anlegen → die FritzBox zeigt einen **QR-Code**.
4. Auf dem Handy die kostenlose App **„WireGuard"** installieren → „+" → **QR-Code scannen**.
5. **MyFRITZ! aktivieren** (kostenloses AVM-Konto), damit die Heimadresse von unterwegs
   immer gefunden wird: FritzBox → **Internet → MyFRITZ!-Konto**.

**Nutzung unterwegs:** WireGuard am Handy einschalten → das Handy ist jetzt „im
Heimnetz" → im Browser die App öffnen: `http://<IP-des-Dauergeräts>:4173`.
Für den Vater das WireGuard-Profil einmal auf sein Handy bringen (eigenen
QR-Code/Verbindung in der FritzBox anlegen) und „Zum Startbildschirm hinzufügen".

### ⚠️ Wenn das VPN nicht verbindet: DS-Lite / CGNAT
Manche Internet-Anschlüsse (oft Kabel/Glasfaser) haben **keine eigene öffentliche
IPv4-Adresse** (DS-Lite/CGNAT). Dann ist die FritzBox von außen über IPv4 nicht
erreichbar und das VPN klappt evtl. nur über IPv6 oder gar nicht.
Test: FritzBox → **Internet → Online-Monitor / Verbindung** — steht dort eine
DS-Lite-/CGNAT-Meldung, ist das der Grund.

**Kostenlose Lösung, die das umgeht: Tailscale.** Es funktioniert auch hinter
CGNAT. Klein-App auf dem Dauergerät **und** auf dem Handy installieren, mit
demselben (kostenlosen) Konto anmelden — danach das Dauergerät von überall
erreichbar unter seiner Tailscale-Adresse. Kein Router-Eingriff nötig.

---

## 5. Sicherheit

- Es wird **nichts** offen ins Internet gestellt. Zugriff nur über den privaten
  VPN-Tunnel (nur deine eigenen Geräte).
- Die App hat noch **kein Passwort-Login** — deshalb bewusst der VPN-Weg statt
  einer öffentlichen Adresse. Ein Login kann später ergänzt werden, falls du die
  App doch öffentlich erreichbar machen willst.
