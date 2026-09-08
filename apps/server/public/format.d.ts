/** Typdeklaration für die zentralen Frontend-Formatter (format.js). */

export function formatSoc(value: number | null | undefined): string;
export function formatPercentage(value: number | null | undefined): string;
export function formatPowerParts(watts: number | null | undefined): { value: string; unit: string };
export function formatPower(watts: number | null | undefined): string;
export function formatEnergyParts(wh: number | null | undefined): { value: string; unit: string };
export function formatEnergy(wh: number | null | undefined): string;
export function formatCurrency(value: number | null | undefined): string;
export function formatTimestamp(value: string | Date | null | undefined): string;
export function formatClock(value: string | Date | null | undefined): string;
export function formatDuration(seconds: number | null | undefined): string;
export interface LadeAnzeige {
  maxCurrentA?: number | null;
  maxPowerW?: number | null;
  powerW?: number | null;
  currentFromPowerA?: number | null;
  /** Zustand der Regelung — daraus kommt die Geraetegrenze fuer die Anzeige. */
  regelung?: {
    maxA?: number | null;
    haushaltMaxA?: number | null;
    anschluss?: { phasen?: number } | null;
  } | null;
}
export function formatLadestrom(ev: LadeAnzeige | null | undefined): string;
export function formatLadeleistung(ev: LadeAnzeige | null | undefined): string;
export interface RegelAnzeige {
  betriebsart?: string;
  zustand?: string;
  verfuegbarW?: number | null;
  minA?: number | null;
  maxA?: number | null;
  anschluss?: { phasen?: number; name?: string; wattProAmpere?: number } | null;
}
export function dosenText(regelung: RegelAnzeige | null | undefined): string;
export function umsteckText(regelung: RegelAnzeige | null | undefined): string;
