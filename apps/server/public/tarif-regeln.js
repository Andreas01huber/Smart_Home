/**
 * Prüfregeln für Tarife — eine Datei für Browser und Server.
 *
 * Vorher prüfte die Oberfläche selbst und der Server gar nicht: Negative Preise
 * lehnte das Formular ab, die Schnittstelle nahm sie an. Jetzt gilt an beiden
 * Stellen genau dieselbe Regel, weil es dieselbe Funktion ist.
 *
 * Negative Tarife werden bewusst nicht unterstützt. Einen dynamischen Tarif mit
 * negativen Preisen bildet dieses Modell ohnehin nicht ab — dafür bräuchte es
 * Preise je Stunde, nicht einen Arbeitspreis.
 */

export const TARIF_GRENZEN = Object.freeze({
  importPricePerKWh: { min: 0, max: 5 },
  exportPricePerKWh: { min: 0, max: 5 },
  baseFeePerMonth: { min: 0, max: 1000 },
});

const ERLAUBT = new Set(['importPricePerKWh', 'exportPricePerKWh', 'baseFeePerMonth', 'gueltigAb']);

const NAMEN = {
  importPricePerKWh: 'Arbeitspreis',
  exportPricePerKWh: 'Einspeisevergütung',
  baseFeePerMonth: 'Grundgebühr',
};

/** Ein Kalendertag im Format JJJJ-MM-TT, der auch wirklich existiert. */
export function istTagesdatum(wert) {
  if (typeof wert !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(wert)) return false;
  const [j, m, t] = wert.split('-').map(Number);
  const d = new Date(Date.UTC(j, m - 1, t));
  return d.getUTCFullYear() === j && d.getUTCMonth() === m - 1 && d.getUTCDate() === t;
}

/**
 * Prüft eine Tarifeingabe.
 *
 * @returns `{ ok: true, tarif }` oder `{ ok: false, fehler }` mit einem Satz,
 *   der sich so in der Oberfläche anzeigen lässt.
 */
export function pruefeTarif(roh) {
  if (typeof roh !== 'object' || roh === null || Array.isArray(roh)) {
    return { ok: false, fehler: 'Ungültige Tarifangabe.' };
  }
  for (const feld of Object.keys(roh)) {
    if (!ERLAUBT.has(feld)) return { ok: false, fehler: `Unbekanntes Feld „${feld}“.` };
  }
  const tarif = {};
  for (const [feld, grenze] of Object.entries(TARIF_GRENZEN)) {
    const wert = roh[feld];
    if (wert === undefined || wert === null || wert === '') {
      if (feld === 'baseFeePerMonth') continue;
      return { ok: false, fehler: `${NAMEN[feld]} fehlt.` };
    }
    if (typeof wert !== 'number' || !Number.isFinite(wert)) {
      return { ok: false, fehler: `${NAMEN[feld]} muss eine Zahl sein.` };
    }
    if (wert < grenze.min || wert > grenze.max) {
      return {
        ok: false,
        fehler: `${NAMEN[feld]} muss zwischen ${grenze.min} und ${grenze.max} liegen.`,
      };
    }
    tarif[feld] = wert;
  }
  if (roh.gueltigAb !== undefined && roh.gueltigAb !== null) {
    if (!istTagesdatum(roh.gueltigAb)) {
      return { ok: false, fehler: '„Gültig ab“ muss ein Datum sein (JJJJ-MM-TT).' };
    }
    tarif.gueltigAb = roh.gueltigAb;
  }
  return { ok: true, tarif };
}
