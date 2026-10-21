// Parses the values a CLI caller passes for numeric, band, finding-type and stage flags. Every
// failure throws an Error naming the flag and what it accepts, so the caller refuses to run
// (exit 2) instead of treating a bad value as a pass or as an empty filter.
import { FINDING_NAMES } from '../finding-names.ts';
import { IMPACT_BANDS } from '../format-utils.ts';
import type { ImpactBand } from '../types.ts';

// Plain non-negative decimals only: Number() would also accept '', ' ', '0x10' and '1e3'.
export const PCT_PATTERN = /^\d+(\.\d+)?$/;
const STAGE_ID_PATTERN = /^\d+$/;

export const FINDING_TYPES: readonly string[] = Object.keys(FINDING_NAMES);

/** A plain non-negative decimal such as `90` or `1.5`. */
export function parseNonNegativeNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!PCT_PATTERN.test(raw) || !Number.isFinite(value)) {
    throw new Error(`${flag} needs a non-negative decimal number such as 90 or 1.5, got "${raw}".`);
  }
  return value;
}

/** A stage id: a non-negative integer with no sign, exponent or prefix. */
export function parseStageId(raw: string, flag: string): number {
  const value = Number(raw);
  if (!STAGE_ID_PATTERN.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(`${flag} needs a non-negative integer stage id such as 3, got "${raw}".`);
  }
  return value;
}

// Splits a comma list, rejecting an empty list or an unknown entry. Entries are trimmed.
function parseKnownList(list: string, flag: string, known: readonly string[], noun: string): string[] {
  const entries = list.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = entries.find((entry) => !known.includes(entry));
  if (entries.length === 0 || bad !== undefined) {
    throw new Error(`${flag}: ${bad === undefined ? `no ${noun} given` : `unknown ${noun} "${bad}"`} (expected a list from: ${known.join(', ')}).`);
  }
  return entries;
}

/** A comma list of impact bands, for `--impact`. */
export function parseImpactBands(list: string, flag: string): ImpactBand[] {
  return parseKnownList(list, flag, IMPACT_BANDS, 'impact band') as ImpactBand[];
}

/** A comma list of finding types, for `--type`. */
export function parseFindingTypes(list: string, flag: string): string[] {
  return parseKnownList(list, flag, FINDING_TYPES, 'finding type');
}

/** `all` or one impact band, for `--fail-on-introduced`. */
export function parseFailOnIntroduced(raw: string, flag: string): string {
  const accepted = ['all', ...IMPACT_BANDS];
  if (!accepted.includes(raw)) {
    throw new Error(`${flag}: unknown value "${raw}" (expected one of: ${accepted.join(', ')}).`);
  }
  return raw;
}
