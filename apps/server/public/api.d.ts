export declare class ApiFehler extends Error {
  constructor(message: string, status: number);
  readonly status: number;
}
export declare class VeralteteAntwort extends Error {
  constructor();
}
export declare function istUeberholt(fehler: unknown): boolean;
type Transport = (pfad: string, optionen?: RequestInit) => Promise<Response>;
export declare function holeJson(pfad: string, optionen?: RequestInit, transport?: Transport): Promise<Record<string, unknown>>;
export declare function letzteAnfrage(): (
  pfad: string, optionen?: RequestInit, transport?: Transport,
) => Promise<Record<string, unknown>>;
