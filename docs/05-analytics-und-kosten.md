# Analytics, Kosten & Persistenz (Phase 2)

Stand: 2026-08-18. Diese Phase führt eine Energie-Accounting- und
Persistenzschicht ein, damit „HEUTE", Autarkie, Eigenverbrauch, Kosten und die
Historie aus **echten akkumulierten Daten** entstehen — keine Mock-Werte
(Anforderung 79).

## Datenfluss

```text
Connectoren → Engine (2 s) → resolveSnapshot (Source of Truth)
                                   │
                    ┌──────────────┴───────────────┐
                    ▼                               ▼
              SSE /api/events              EnergyAccumulator
              (Live-Dashboard)            integriert W → Wh
                                          │
                          ┌───────────────┼────────────────┐
                          ▼               ▼                ▼
                     Tagesbilanz     Tageskurve       Historie (data/)
                    /api/today    /api/today/series   /api/history
```

## Energie-Accounting (rein, getestet: `packages/core/src/accounting.ts`)

| Größe | Definition |
| --- | --- |
| Autarkie | 1 − Netzbezug / Gesamtverbrauch |
| Eigenverbrauch | 1 − Netzeinspeisung / Erzeugung |
| Verbrauch aus Netz | = Netzbezug |
| Verbrauch aus Batterie | = Summe Entladung |
| Verbrauch aus PV (direkt) | = Verbrauch − Netz − Batterie (≥ 0) |
| Ersparnis | (Verbrauch − Netzbezug) × Arbeitspreis |
| Einspeiseerlös | Einspeisung × Einspeisevergütung |
| Gesamt-SOC | kapazitätsgewichtet: Σ(Kap×SOC) / ΣKap |

Alle Werte sind ein **Accounting-Modell**, keine physikalische Aussage über
einzelne Elektronen (wie in der Spezifikation gefordert).

## Persistenz (`apps/server/src/history.ts`)

- `data/history.json` — abgeschlossene Tagesdatensätze (Aggregation zu Monat/
  Jahr/Gesamt on-the-fly).
- `data/today.json` — laufender Tagesstand + Tageskurve (übersteht Neustart).
- `data/tariff.json` — Stromtarife.
- **Migrationssicher (Anforderung 89):** Bestehende Historie wird nur ergänzt,
  nie gelöscht. Kein Schema-Drop.
- Integration ist gegen Zeitsprünge abgesichert (dt gedeckelt auf 15 s), damit
  Pausen keine Energie erfinden.

## Endpunkte

| Endpunkt | Zweck |
| --- | --- |
| `GET /api/today` | Tagesbilanz + abgeleitete Kennzahlen + Kosten |
| `GET /api/today/series` | Tageskurve (1-Minuten-Punkte) |
| `GET /api/history?range=day\|month\|year\|total` | Aggregate |
| `GET/PUT /api/tariff` | Tarife lesen/ändern |

## Tarife (Anforderung 29)

Konfiguriert in `config.json → tariff` bzw. zur Laufzeit über `PUT /api/tariff`.
Standard: Bezug 0,28 €/kWh, Einspeisung 0,08 €/kWh.
