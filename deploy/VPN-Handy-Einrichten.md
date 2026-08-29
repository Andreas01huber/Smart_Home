# Handy-Fernzugriff per VPN — deine Anleitung

Ziel: Vom Handy aus **von überall** (fremdes WLAN, Mobilfunk) sicher auf
**SmartHome** zugreifen — über einen verschlüsselten VPN-Tunnel ins Heimnetz.

## Deine Werte (bereits geprüft)

| | |
| --- | --- |
| FritzBox | FRITZ!Box 6490 Cable, FRITZ!OS 7.57 (WireGuard eingebaut) |
| FritzBox-Adresse | `http://192.168.178.1` bzw. `http://fritz.box` |
| Laptop-IP | `192.168.178.166` |
| **App-Adresse (im Tunnel)** | **`http://192.168.178.166:4173`** |
| Firewall Port 4173 | bereits freigegeben |

## Voraussetzung (wichtig)

Der VPN-Tunnel bringt dich nur **ins Heimnetz** — die App muss dort **laufen**.
Also: der Laptop (oder später ein kleines Dauergerät) muss **an** sein und
SmartHome gestartet haben. Laptop aus = kein Zugriff. Für echten „immer
erreichbar" später den Autostart einrichten
(`deploy/Autostart einrichten (Windows).cmd`) oder ein Dauergerät nutzen.

---

## Schritt 0 — DS-Lite? Bereits geprüft: NEIN ✅

Deine FritzBox hat aktuell eine **echte öffentliche IPv4-Adresse** (kein
DS-Lite/CGNAT — am 19.08.2026 direkt per UPnP an der Box bestätigt). Damit
funktioniert der direkte FritzBox-Weg → **weiter mit Weg A**.

> Nur falls dein Anbieter später auf DS-Lite umstellt und Weg A dann nicht mehr
> verbindet: auf **Weg B (Tailscale)** wechseln — das umgeht CGNAT zuverlässig.

---

## Weg A — FritzBox-WireGuard (wenn KEIN DS-Lite)

### A1. Laptop feste IP geben (damit die Adresse stabil bleibt)
FritzBox → **Heimnetz → Netzwerk** → Laptop auswählen →
**„Diesem Netzwerkgerät immer die gleiche IPv4-Adresse zuweisen"** aktivieren.

### A2. MyFRITZ! aktivieren (damit die Heimadresse von unterwegs gefunden wird)
FritzBox → **Internet → MyFRITZ!-Konto** → kostenloses AVM-Konto anlegen/anmelden.

### A3. WireGuard-Verbindung fürs Handy anlegen
FritzBox → **Internet → Freigaben → Reiter „VPN (WireGuard)"** →
**„Verbindung hinzufügen"** → **„Gerät (z. B. Smartphone)"** →
Namen vergeben (z. B. „Handy Andreas") → **fertigstellen**.
→ Die FritzBox zeigt einen **QR-Code**.

### A4. Handy einrichten
1. Auf dem Handy die kostenlose App **„WireGuard"** installieren (App Store / Play Store).
2. In WireGuard **„+" → QR-Code scannen** → den FritzBox-QR-Code abfotografieren.
3. Verbindung speichern.

### A5. Nutzung unterwegs
1. WireGuard am Handy **einschalten** (Schieberegler).
2. Im Browser **`http://192.168.178.166:4173`** öffnen → „Zum Startbildschirm hinzufügen".
3. Fertig. Zum Trennen WireGuard wieder ausschalten.

Für einen zweiten Nutzer (z. B. Vater): in der FritzBox eine **eigene**
WireGuard-Verbindung mit eigenem QR-Code anlegen (nicht denselben teilen).

---

## Weg B — Tailscale (wenn DS-Lite, oder einfach der bequemere Weg)

Funktioniert auch hinter CGNAT/DS-Lite, **ohne** Router-Eingriff.

1. **Am Laptop:** Tailscale von `https://tailscale.com/download` installieren,
   mit kostenlosem Konto anmelden (Google/Microsoft/E-Mail). Der Laptop bekommt
   eine feste Tailscale-Adresse (Form `100.x.y.z`), sichtbar in der Tailscale-App.
2. **Am Handy:** Tailscale-App installieren, mit **demselben** Konto anmelden.
3. **Nutzung:** Tailscale am Handy an → im Browser **`http://<Tailscale-IP-des-Laptops>:4173`**
   öffnen (die IP zeigt die Tailscale-App beim Laptop an) → „Zum Startbildschirm hinzufügen".

Vorteil: kein DS-Lite-Problem, keine FritzBox-Konfiguration, keine feste IP nötig.
Der Laptop muss (wie immer) an sein und die App laufen.

---

## Sicherheit

- Es wird **nichts** offen ins Internet gestellt. Zugriff nur über den privaten,
  verschlüsselten Tunnel — nur deine eigenen (angemeldeten) Geräte kommen rein.
- SmartHome hat noch **kein Passwort-Login** — deshalb bewusst der VPN-Weg statt
  einer öffentlichen Adresse.
