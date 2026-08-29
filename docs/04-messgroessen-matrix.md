# Messgrößen-Matrix & Source of Truth (4L / STEP 3)

Für jede zentrale Messgröße ist genau **eine** Source of Truth definiert.
Fronius- und Victron-Werte werden **niemals blind addiert**. Stand: 2026-08-18,
empirisch verifiziert (siehe `docs/02-anlagen-inventar.md`).

## Matrix

```text
PV Anlage 1            → Fronius Symo   (fronius-local)     eigener Wert
PV Anlage 2            → Fronius GEN24  (fronius-gen24)     eigener Wert
PV Gesamt             → PV1 + PV2       (Summe distinkter Wechselrichter)

12-kWh-Batterie       → Fronius GEN24  (BYD)               eigener Wert
50-kWh-Batterie       → Victron GX                          eigener Wert

Hausverbrauch         → berechnet (Energy Accounting)
Netzbezug             → Fronius Smart Meter TS 65A-3 (via GEN24)
Netzeinspeisung       → Fronius Smart Meter TS 65A-3 (via GEN24)
```

## Warum nicht addieren

Ein gleichzeitiger Schnappschuss zeigte:

- Fronius-Zähler **−1518 W** ≈ Victron-Netz **−1501 W** → **derselbe Netzpunkt**.
- Symo-PV **601 W** (Symo-API) = Victron PV_on_grid **601 W** → **derselbe Wechselrichter**.

Deshalb: Netz nur aus dem Fronius Smart Meter, Symo-PV nur aus der Symo-API,
Victron nur für den 50-kWh-Speicher (und als stille Gegenprobe).

## Dokumentationsschema je Messwert

Jeder aufgelöste Messwert trägt intern (siehe `PowerMetric`/`Provenance` in
`packages/core/src/model.ts`):

```text
metric              z. B. solarProductionW
source              z. B. sum / fronius-gen24 / victron-modbus / derived
device              Connector- bzw. Geräte-ID
raw value           Herstellerwert vor Normalisierung (Reconciliation, 4O/56)
normalized value    gerichtete, nicht-negative Größe
timestamp           measuredAt der Quelle
age                 ageMs (abgeleitet)
quality             live | stale | offline | unknown
```
