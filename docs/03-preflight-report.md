# Energy System Preflight Report

Erzeugt: 2026-08-18 · Befehl: `npm run preflight`
Erfüllt Phase 2, STEP 8–16. Der Preflight nutzt die **echten Connectoren** der
App (nicht rohes HTTP), prüft also den tatsächlichen Datenpfad des Dashboards.

```text
ENERGY SYSTEM PREFLIGHT

Fronius Inverter 1      ✅  Symo 5.0-3-M            @ 192.168.178.121
Fronius Inverter 2      ✅  „Huber Ingrid Gen24"   @ 192.168.178.39
Fronius Smart Meter     ✅  Smart Meter TS 65A-3
Fronius Battery         ✅  BYD Premium HV, 11,1 kWh, SOC 100 %
Victron System          ✅  GX, Serial c0619abd1723 @ 192.168.178.73
Victron 50 kWh Battery  ✅  SOC 100 %, 50,0 kWh
House Consumption       ✅  berechnet (Energy Accounting)
Grid Import             ✅  Smart Meter
Grid Export             ✅  Smart Meter

PV aggregation          ✅  PV1 + PV2, keine Doppelzählung
No duplicate counting    ✅  Victron nicht als PV-/Netzquelle
Energy balance          ✅  Residual ~0 W

Data age:
Fronius: < 2 s
Victron: < 2 s

Result:
READY FOR DASHBOARD
```

## 2. Gefundene reale Geräte

| Rolle | Gerät (real verifiziert) | Adresse | Schnittstelle |
| --- | --- | --- | --- |
| Wechselrichter 1 | Fronius **Symo 5.0-3-M** (Non-Hybrid) | 192.168.178.121 | Solar API V1 |
| Wechselrichter 2 | Fronius **GEN24** („Huber Ingrid Gen24") | 192.168.178.39 | Solar API V1 |
| Smart Meter | Fronius **Smart Meter TS 65A-3** | via GEN24 | Solar API |
| Speicher 1 | **BYD Battery-Box Premium HV**, 11.059 Wh | via GEN24 | Solar API |
| GX-System | Victron **Venus OS GX** | 192.168.178.73 | Modbus TCP |
| Speicher 2 | Victron-Batteriesystem, ~50 kWh | via GX | Modbus TCP |

Abweichung zum Video: Der zweite Wechselrichter wurde als „Symo GEN24 10.0 Plus"
vermutet; die Anlage meldet real den Namen „Huber Ingrid Gen24" (ein GEN24).
Modell-Details der GEN24-Leistungsklasse sind über die Solar API nicht eindeutig
ausgewiesen — die Funktion (Hybrid mit Meter + BYD-Speicher) ist verifiziert.

## 3. Offener Punkt

- **Historical Storage** war bis Phase 2 nicht vorhanden (die App war live-only).
  Diese Phase führt eine Persistenz-/Aggregationsschicht ein (siehe
  `docs/05-analytics-und-kosten.md`), damit Tag/Monat/Jahr/Gesamt, Kosten und
  Autarkie aus echten akkumulierten Daten berechnet werden.
