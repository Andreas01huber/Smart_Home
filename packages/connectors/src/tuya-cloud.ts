/**
 * Minimaler Tuya-Cloud-Client — AUSSCHLIESSLICH LESEND.
 *
 * Es gibt in dieser Datei bewusst nur `get()`. Es existiert keine Funktion, die
 * POST/PUT sendet, und damit keine Möglichkeit, ein Gerät zu steuern oder zu
 * verändern. Wer später Steuerung braucht, muss das ausdrücklich ergänzen.
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

  private sign(path: string, token: string | null, t: string): string {
    const stringToSign = ['GET', EMPTY_BODY_HASH, '', path].join('\n');
    const payload = this.accessId + (token ?? '') + t + stringToSign;
    return createHmac('sha256', this.accessSecret)
      .update(payload)
      .digest('hex')
      .toUpperCase();
  }

  /** Der einzige HTTP-Zugriff dieser Klasse. Bewusst nur GET. */
  private async get<T>(path: string, token: string | null): Promise<TuyaResponse<T>> {
    const t = Date.now().toString();
    const headers: Record<string, string> = {
      client_id: this.accessId,
      sign: this.sign(path, token, t),
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
}
