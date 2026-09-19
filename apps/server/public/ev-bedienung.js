/** Eine Vorschau verändert nur die Anzeige, niemals die Wallbox. */
export function bindeLadestromUebernahme(schieber, istVorschau, uebernehmen, optionen) {
  schieber.addEventListener('change', () => {
    if (!istVorschau()) void uebernehmen(Number(schieber.value));
  }, optionen);
}

/** Reglerbewegungen bleiben Vorschau; nur eine ausdrückliche Bestätigung sendet. */
export function bindeLadestromBestaetigung(button, schieber, uebernehmen, optionen) {
  button.addEventListener('click', () => {
    const ampere = Number(schieber.value);
    if (!Number.isFinite(ampere) || !Number.isInteger(ampere)
      || ampere < Number(schieber.min) || ampere > Number(schieber.max)) return;
    void uebernehmen(ampere);
  }, optionen);
}

/** Nur erfolgreiche, vollständige Steuerantworten dürfen den UI-Zustand ersetzen. */
export async function sendeLadebefehl(pfad, koerper, transport = fetch) {
  const antwort = await transport(pfad, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(koerper),
  });
  if (!antwort.ok) throw new Error(`Befehl nicht übernommen (HTTP ${antwort.status}). Bitte erneut versuchen.`);
  const zustand = await antwort.json();
  if (!zustand || typeof zustand !== 'object'
    || !['intelligent', 'manuell'].includes(zustand.betriebsart)
    || typeof zustand.gestoppt !== 'boolean') {
    throw new Error('Ungültige Antwort. Der Ladezustand konnte nicht bestätigt werden.');
  }
  return zustand;
}
