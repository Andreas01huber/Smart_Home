export function bindeLadestromUebernahme(
  schieber: { value: string; addEventListener(type: string, listener: () => void): void },
  istVorschau: () => boolean,
  uebernehmen: (ampere: number) => unknown,
): void;
export function sendeLadebefehl(
  pfad: string, koerper: unknown, transport?: typeof fetch,
): Promise<Record<string, unknown>>;
