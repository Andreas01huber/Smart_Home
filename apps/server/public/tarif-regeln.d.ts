export declare const TARIF_GRENZEN: Readonly<{
  importPricePerKWh: { min: number; max: number };
  exportPricePerKWh: { min: number; max: number };
  baseFeePerMonth: { min: number; max: number };
}>;

export interface GeprueterTarif {
  importPricePerKWh: number;
  exportPricePerKWh: number;
  baseFeePerMonth?: number;
  gueltigAb?: string;
}

export declare function istTagesdatum(wert: unknown): wert is string;

export declare function pruefeTarif(
  roh: unknown,
): { ok: true; tarif: GeprueterTarif } | { ok: false; fehler: string };
