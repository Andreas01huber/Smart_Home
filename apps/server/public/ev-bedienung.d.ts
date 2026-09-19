export function bindeLadestromUebernahme(
  schieber: { value: string; addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void },
  istVorschau: () => boolean,
  uebernehmen: (ampere: number) => unknown,
  optionen?: AddEventListenerOptions,
): void;
export function sendeLadebefehl(
  pfad: string, koerper: unknown, transport?: typeof fetch,
): Promise<Record<string, unknown>>;
export function bindeLadestromBestaetigung(
  button: { addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void },
  schieber: { value: string; min: string; max: string },
  uebernehmen: (ampere: number) => unknown,
  optionen?: AddEventListenerOptions,
): void;
export function befehlsfolge(): {
  beginne(): number;
  beende(nummer: number): boolean;
  readonly laeuft: boolean;
};
export function ladezustand(
  r: Record<string, unknown> | null | undefined,
  ev: Record<string, unknown> | null | undefined,
): { titel: string; text: string; ton: 'ok' | 'neutral' | 'warn' | 'fehler' };
