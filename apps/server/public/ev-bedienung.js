/**
 * Ladebedienung — reine Logik ohne DOM, damit sie prüfbar bleibt.
 *
 * Vier Dinge werden hier auseinandergehalten, die die Oberfläche früher
 * vermischte:
 *
 *   Wunsch       was der Mensch gewählt hat (Betriebsart, Ampere, Pause)
 *   Befehl       was an die Wallbox übermittelt wurde und ob sie es bestätigt
 *   Gerät        was die Wallbox selbst meldet (Schalter, Stromgrenze)
 *   Messung      ob tatsächlich Strom fliesst
 *
 * Ein HTTP 200 auf "Laden starten" heisst deshalb nicht "Auto lädt".
 */

/** Ab dieser gemessenen Leistung lädt das Auto wirklich. */
const LAEDT_AB_W = 100;

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
  let antwort;
  try {
    antwort = await transport(pfad, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(koerper),
    });
  } catch {
    throw new Error('Keine Verbindung zum Server — nichts wurde geändert.');
  }
  let zustand = null;
  try {
    zustand = await antwort.json();
  } catch {
    zustand = null;
  }
  if (!antwort.ok) {
    throw new Error(zustand && typeof zustand.error === 'string'
      ? zustand.error
      : `Befehl nicht übernommen (HTTP ${antwort.status}). Bitte erneut versuchen.`);
  }
  if (!zustand || typeof zustand !== 'object'
    || !(zustand.betriebsart === null || ['intelligent', 'manuell'].includes(zustand.betriebsart))
    || typeof zustand.gestoppt !== 'boolean') {
    throw new Error('Ungültige Antwort. Der Ladezustand konnte nicht bestätigt werden.');
  }
  return zustand;
}

/**
 * Reihenfolge der Bedienbefehle.
 *
 * Jeder Befehl bekommt eine Nummer. Nur die Antwort auf den NEUESTEN darf die
 * Anzeige ersetzen — eine verspätete Antwort auf "manuell 10 A" überschreibt
 * nicht den inzwischen gedrückten Stopp. Ein Stopp darf jederzeit abgeschickt
 * werden, auch während ein anderer Befehl noch unterwegs ist.
 */
export function befehlsfolge() {
  let zaehler = 0;
  let offen = 0;
  return {
    /** Beginnt einen Befehl; gibt seine Nummer zurück. */
    beginne() {
      offen += 1;
      zaehler += 1;
      return zaehler;
    },
    /** Beendet einen Befehl; `true`, wenn seine Antwort angezeigt werden darf. */
    beende(nummer) {
      offen = Math.max(0, offen - 1);
      return nummer === zaehler;
    },
    get laeuft() {
      return offen > 0;
    },
  };
}

/**
 * Der Ladezustand in Worten — die Kopfzeile der Ladeansicht.
 *
 * @param r   Regelzustand aus dem Server (`ev.regelung`).
 * @param ev  Wallbox aus dem Live-Zustand (für Anschluss und Messung).
 * @returns `{ titel, text, ton }`; `ton` ist `ok`, `neutral`, `warn` oder `fehler`.
 *   Manuelles Laden ist ausdrücklich kein Warnzustand.
 */
export function ladezustand(r, ev) {
  if (!r) return { titel: 'Ladesteuerung nicht verfügbar', text: '', ton: 'neutral' };
  if (r.modus === 'aus') {
    return { titel: 'Regelung ausgeschaltet', text: 'Die Wallbox lädt mit ihrer eigenen Einstellung.', ton: 'neutral' };
  }
  const geraet = r.geraet ?? null;
  const befehl = r.befehl ?? null;
  const leistung = Number.isFinite(ev?.powerW) ? ev.powerW : (Number.isFinite(geraet?.leistungW) ? geraet.leistungW : null);
  const laedt = leistung !== null && leistung > LAEDT_AB_W;
  const angesteckt = ev?.vehicleConnected ?? geraet?.angesteckt ?? null;

  // Was die Wallbox JETZT meldet, geht vor. Das Urteil der Regelung stammt
  // aus ihrer letzten Prüfung und kann eine Wiederkehr noch nicht kennen.
  if (ev?.state === 'offline' || (r.zustand === 'gestoert' && (ev == null || ev.state === 'not-connected'))) {
    return { titel: 'Wallbox nicht erreichbar', text: r.grund ?? '', ton: 'fehler' };
  }
  if (r.zustand === 'gestoert') {
    return { titel: 'Regelung gestört', text: r.grund ?? '', ton: 'fehler' };
  }
  if (ev?.state === 'fault') {
    return { titel: 'Störung an der Wallbox', text: ev.faultText ?? r.grund ?? '', ton: 'fehler' };
  }
  // Meldet die Wallbox ein gestecktes Auto, zählt das, auch wenn die letzte
  // Regelprüfung noch keins kannte.
  if (angesteckt === false || (r.zustand === 'nicht-verbunden' && angesteckt !== true)) {
    const naechstes = r.betriebsart === 'manuell'
      ? `Beim nächsten Anstecken: Manuell · ${r.manuellA} A`
      : r.betriebsart === 'intelligent'
        ? 'Beim nächsten Anstecken: Intelligent'
        : 'Noch kein Lademodus gewählt.';
    return { titel: 'Kein Auto angesteckt', text: naechstes, ton: 'neutral' };
  }
  if (angesteckt === null) {
    return { titel: 'Anschluss unbekannt', text: 'Die Wallbox meldet gerade nicht, ob ein Auto steckt.', ton: 'warn' };
  }
  if (r.betriebsart === null || r.zustand === 'wahl-fehlt') {
    return { titel: 'Lademodus wählen', text: 'Ohne Wahl wird nicht geladen.', ton: 'warn' };
  }
  if (r.gestoppt) {
    const bestaetigt = geraet?.schalterAn === false && !laedt;
    return bestaetigt
      ? { titel: 'Pausiert', text: 'Die Wallbox ist abgeschaltet. „Laden fortsetzen“ hebt die Pause auf.', ton: 'neutral' }
      : { titel: 'Pause angefordert', text: 'Der Stopp ist gesendet; die Wallbox hat ihn noch nicht bestätigt.', ton: 'neutral' };
  }
  if (befehl?.status === 'fehlgeschlagen') {
    return { titel: 'Befehl nicht übernommen', text: befehl.fehler ?? 'Die Wallbox hat den Befehl nicht angenommen.', ton: 'fehler' };
  }
  if (laedt) {
    return r.betriebsart === 'manuell'
      ? { titel: 'Lädt manuell', text: `Fester Sollwert ${r.manuellA} A. Bei Bedarf Netzstrom.`, ton: 'neutral' }
      : { titel: 'Lädt intelligent', text: r.grund ?? '', ton: 'ok' };
  }
  if (befehl?.schalter === true && befehl.status === 'uebermittelt') {
    return { titel: 'Start wird übermittelt', text: 'Warte auf Antwort der Wallbox …', ton: 'neutral' };
  }
  if (r.zustand === 'fordert-nicht') {
    return { titel: 'Fahrzeug nimmt derzeit keinen Strom an', text: r.grund ?? '', ton: 'neutral' };
  }
  if (r.zustand === 'laedt') {
    return {
      titel: 'Freigegeben — keine Stromaufnahme',
      text: befehl?.status === 'bestaetigt'
        ? 'Die Wallbox ist freigegeben, das Fahrzeug nimmt gerade nichts ab.'
        : 'Freigabe gesendet; die Wallbox hat sie noch nicht bestätigt.',
      ton: 'neutral',
    };
  }
  if (r.zustand === 'pausiert-messwerte') {
    return { titel: 'Pausiert — Messwerte unsicher', text: r.grund ?? '', ton: 'warn' };
  }
  if (String(r.zustand).startsWith('pausiert') || r.zustand === 'wartet') {
    return { titel: 'Wartet auf Überschuss', text: r.grund ?? '', ton: 'neutral' };
  }
  if (r.zustand === 'beendet') return { titel: 'Ladevorgang beendet', text: r.grund ?? '', ton: 'neutral' };
  return { titel: 'Zustand unbekannt', text: r.grund ?? '', ton: 'warn' };
}
