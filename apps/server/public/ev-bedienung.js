/** Eine Vorschau verändert nur die Anzeige, niemals die Wallbox. */
export function bindeLadestromUebernahme(schieber, istVorschau, uebernehmen) {
  schieber.addEventListener('change', () => {
    if (!istVorschau()) void uebernehmen(Number(schieber.value));
  });
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
