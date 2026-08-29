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
