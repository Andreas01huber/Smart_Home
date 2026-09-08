/**
 * Minimaler Tuya-Cloud-Client.
 *
 * Bis zur Überschussregelung war diese Datei ausdrücklich nur lesend. Sie kann
 * jetzt auch senden — aber eng geführt: `sendCommands()` ist die einzige
 * schreibende Funktion, und der Aufrufer (`tuya-evse.ts`) lässt nur einen
 * einzigen Datenpunkt durch. Der Ladestrom. Nichts sonst.
 *
 * Warum überhaupt: Das Auto soll nur laden, wenn Sonne oder freigegebener
 * Speicher da sind. Ohne Stellgriff wäre das nicht regelbar.
 *
 * Signaturverfahren nach offizieller Tuya-Doku (HMAC-SHA256):
 *   sign = HMAC-SHA256(clientId + [accessToken] + t + nonce + stringToSign)
 *   stringToSign = METHOD \n SHA256(body) \n headers \n pfad
 *
 * Warum Cloud statt lokal: Der lokale Tuya-Port des Geräts ist zwar offen,
 * beantwortet aber weder Protokoll 3.3 noch 3.4 noch 3.5 (empirisch geprüft am
 * 26.08.2026). Die Cloud-Abfrage funktioniert dagegen zuverlässig. Der Zugriff
 * ist in `TuyaCloudClient` gekapselt, damit später ein lokaler Transport
 * eingesetzt werden kann, ohne den Connector zu ändern.
 */

import { createHash, createHmac } from 'node:crypto';

export interface TuyaCloudOptions {
  readonly accessId: string;
  readonly accessSecret: string;
  /** Rechenzentrum: eu (Europa), us, cn, in. */
  readonly region?: string;
  readonly timeoutMs?: number;
}

interface TuyaResponse<T> {
  readonly success: boolean;
  readonly result?: T;
  readonly msg?: string;
  readonly code?: number;
}

export interface TuyaStatusEntry {
  readonly code: string;
  readonly value: unknown;
}

const EMPTY_BODY_HASH = createHash('sha256').update('').digest('hex');

export class TuyaCloudClient {
  private readonly base: string;
  private readonly accessId: string;
  private readonly accessSecret: string;
  private readonly timeoutMs: number;

  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(options: TuyaCloudOptions) {
    this.accessId = options.accessId;
    this.accessSecret = options.accessSecret;
    this.base = `https://openapi.tuya${options.region ?? 'eu'}.com`;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  /**
   * Erreichbarkeit UND Status in einem einzigen Aufruf.
   *
   * Wichtig: `/status` liefert auch dann noch die zuletzt bekannten Werte, wenn
   * das Gerät gar nicht mehr am Strom hängt. Ohne das `online`-Flag würde ein
   * ausgesteckter Charger also veraltete Werte als aktuell ausgeben. Deshalb
   * wird bewusst `/v1.0/devices/{id}` verwendet — dort kommen beide Angaben
   * zusammen, und es bleibt bei genau einem Aufruf pro Abfrage.
   */
  async deviceSnapshot(
    deviceId: string,
  ): Promise<{ online: boolean | null; status: readonly TuyaStatusEntry[] }> {
    const token = await this.ensureToken();
    const body = await this.get<{ online?: boolean; status?: TuyaStatusEntry[] }>(
      `/v1.0/devices/${encodeURIComponent(deviceId)}`,
      token,
    );
    if (!body.success || !body.result) {
      // Abgelaufenes Token: einmal erneuern und den Aufrufer neu versuchen lassen.
      if (body.code === 1010 || body.code === 1011) this.token = null;
      throw new Error(body.msg ?? 'Tuya-Abfrage fehlgeschlagen');
    }
    return {
      online: body.result.online ?? null,
      status: Array.isArray(body.result.status) ? body.result.status : [],
    };
  }

  /**
   * Sendet Befehle an ein Gerät.
   *
   * Die einzige schreibende Funktion dieser Klasse. Sie prüft NICHT, ob ein
   * Befehl fachlich zulässig ist — das gehört dort hin, wo die Gerätegrenzen
   * bekannt sind (`tuya-evse.ts`). Hier wird nur übertragen.
   *
   * Wirft bei Ablehnung durch die Cloud. Häufigster Grund im Alltag: Das
   * Cloud-Projekt hat nur Leserechte, dann kommt "permission deny" zurück.
   */
  async sendCommands(
    deviceId: string,
    commands: readonly { readonly code: string; readonly value: unknown }[],
  ): Promise<void> {
    const token = await this.ensureToken();
    const body = await this.post<boolean>(
      `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/commands`,
      token,
      { commands },
    );
    if (!body.success) {
      if (body.code === 1010 || body.code === 1011) this.token = null;
      throw new Error(body.msg ?? 'Tuya hat den Befehl abgelehnt');
    }
  }

  /**
   * Die vom Gerät angebotenen Steuerfunktionen samt ihrer Wertebereiche.
   *
   * Damit lassen sich Mindest- und Höchststrom sowie die Schrittweite vom Gerät
   * selbst erfragen, statt sie in der Konfiguration zu raten.
   */
  async deviceFunctions(
    deviceId: string,
  ): Promise<readonly { code: string; type: string; values: string }[]> {
    const token = await this.ensureToken();
    const body = await this.get<{ functions?: { code: string; type: string; values: string }[] }>(
      `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/functions`,
      token,
    );
    if (!body.success || !body.result) {
      throw new Error(body.msg ?? 'Tuya-Funktionsliste nicht abrufbar');
    }
    return body.result.functions ?? [];
  }

  /**
   * Alle Datenpunkte eines Geräts — mit Zeitstempel je Wert.
   *
   * Der Unterschied zu `deviceSnapshot` ist entscheidend und war lange
   * unbekannt: `/status` lässt Datenpunkte vom Typ `raw` weg. Genau dort steckt
   * bei dieser Wallbox `phase_a` — acht Bytes mit Spannung, Strom und Leistung,
   * die sich alle paar Sekunden erneuern. Ohne sie blieb nur `power_total`, und
   * das steht auch minutenlang auf einem alten Wert.
   *
   * Der zweite Gewinn ist die Zeit: Jeder Wert bringt mit, wann das Gerät ihn
   * zuletzt gemeldet hat. Damit lässt sich ein eingefrorener Wert erkennen,
   * statt ihn für aktuell zu halten.
   */
  async deviceProperties(
    deviceId: string,
  ): Promise<readonly { code: string; value: unknown; time: number }[]> {
    const token = await this.ensureToken();
    const pfad = `/v2.0/cloud/thing/${encodeURIComponent(deviceId)}/shadow/properties`;
    const body = await this.get<{
      properties?: { code: string; value: unknown; time: number }[];
    }>(pfad, token);
    if (!body.success || !body.result) {
      if (body.code === 1010 || body.code === 1011) this.token = null;
      throw new Error(body.msg ?? 'Tuya-Eigenschaften nicht abrufbar');
    }
    return body.result.properties ?? [];
  }

  /**
   * Roher GET auf einen beliebigen Cloud-Pfad.
   *
   * Nur für Diagnosewerkzeuge: Welche Datenpunkte ein Gerät überhaupt kennt,
   * steht in keinem Datenblatt und lässt sich nur erfragen. Die Adapter selbst
   * benutzen die benannten Methoden oben — dort ist dokumentiert, warum genau
   * dieser Pfad und kein anderer.
   */
  async rohAbfrage<T>(pfad: string): Promise<TuyaResponse<T>> {
    return this.get<T>(pfad, await this.ensureToken());
  }

  // --- intern --------------------------------------------------------------

  private async ensureToken(): Promise<string> {
    if (this.token !== null && Date.now() < this.tokenExpiresAt) return this.token;
    const body = await this.get<{ access_token: string; expire_time: number }>(
      '/v1.0/token?grant_type=1',
      null,
    );
    if (!body.success || !body.result) {
      throw new Error(body.msg ?? 'Tuya-Anmeldung fehlgeschlagen');
    }
    this.token = body.result.access_token;
    // 60 s Sicherheitsabstand vor dem tatsächlichen Ablauf.
    this.tokenExpiresAt = Date.now() + Math.max(0, body.result.expire_time - 60) * 1000;
    return this.token;
  }

  private sign(
    method: 'GET' | 'POST',
    path: string,
    token: string | null,
    t: string,
    bodyHash: string = EMPTY_BODY_HASH,
  ): string {
    const stringToSign = [method, bodyHash, '', path].join('\n');
    const payload = this.accessId + (token ?? '') + t + stringToSign;
    return createHmac('sha256', this.accessSecret)
      .update(payload)
      .digest('hex')
      .toUpperCase();
  }

  /** Lesender Zugriff. */
  private async get<T>(path: string, token: string | null): Promise<TuyaResponse<T>> {
    const t = Date.now().toString();
    const headers: Record<string, string> = {
      client_id: this.accessId,
      sign: this.sign('GET', path, token, t),
      t,
      sign_method: 'HMAC-SHA256',
    };
    if (token !== null) headers['access_token'] = token;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.base + path, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as TuyaResponse<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Schreibender Zugriff. Der Körper geht in die Signatur ein. */
  private async post<T>(
    path: string,
    token: string,
    payload: unknown,
  ): Promise<TuyaResponse<T>> {
    const t = Date.now().toString();
    const koerper = JSON.stringify(payload);
    const bodyHash = createHash('sha256').update(koerper).digest('hex');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.base + path, {
        method: 'POST',
        headers: {
          client_id: this.accessId,
          sign: this.sign('POST', path, token, t, bodyHash),
          t,
          sign_method: 'HMAC-SHA256',
          access_token: token,
          'content-type': 'application/json',
        },
        body: koerper,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as TuyaResponse<T>;
    } finally {
      clearTimeout(timer);
    }
  }
}
