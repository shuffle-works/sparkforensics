// User threshold overrides: validation of a parsed config file, and which of a detector's
// thresholds an override actually moved off its specification default. Only the CLI and the MCP
// server accept overrides; the dashboard always runs the defaults. Reading the file is
// cli/threshold-config.ts's job, so this module stays free of Node APIs.
import {
  DETECTORS, ENTRY_BY_TYPE, detectorCatalog, type Detector, type DetectorCatalogEntry, type DetectorThresholds, type ThresholdOverrides,
} from './detectors.ts';
import type { TunedThreshold, TunedThresholds } from './types.ts';

const entries: readonly Detector[] = DETECTORS;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// Entries a user may tune: not config-scope (those audits compare against Spark's own defaults,
// such as its memoryOverhead floor), and with at least one threshold.
function tunableEntry(type: string): Detector {
  const entry = entries.find((d) => d.type === type);
  if (!entry) {
    const tunable = entries.filter((d) => d.scope !== 'config' && Object.keys(d.thresholds).length > 0).map((d) => d.type);
    throw new Error(`unknown detector "${type}" (tunable detectors: ${tunable.join(', ')})`);
  }
  if (entry.scope === 'config') throw new Error(`"${type}" is not tunable: its checks compare against Spark's own defaults`);
  if (Object.keys(entry.thresholds).length === 0) throw new Error(`"${type}" has no thresholds to tune`);
  return entry;
}

function checkValue(type: string, name: string, fallback: number | readonly number[], value: unknown): number | readonly number[] {
  if (!Array.isArray(fallback)) {
    if (!isNonNegativeNumber(value)) throw new Error(`"${type}.${name}" must be a non-negative number`);
    return value;
  }
  // Tier tables are indexed by position and read as ascending bands.
  const ascending = Array.isArray(value) && value.length === fallback.length
    && value.every(isNonNegativeNumber) && value.every((v, i) => i === 0 || v >= value[i - 1]);
  if (!ascending) throw new Error(`"${type}.${name}" must be an ascending list of ${fallback.length} non-negative numbers`);
  return Object.freeze([...value]);
}

/**
 * Validates a parsed thresholds config: `{ "<detector type>": { "<threshold>": value } }`, with each
 * value shaped like that threshold's default (see a report's `detectors` catalog for the names,
 * units and defaults). Throws an Error naming the first problem; never drops a bad entry silently.
 */
export function parseThresholdOverrides(raw: unknown): ThresholdOverrides {
  if (!isPlainObject(raw)) throw new Error('expected a JSON object keyed by detector type');
  const result: Record<string, DetectorThresholds> = {};
  for (const [type, perDetector] of Object.entries(raw)) {
    const entry = tunableEntry(type);
    if (!isPlainObject(perDetector)) throw new Error(`"${type}" must be an object of threshold values`);
    const values: Record<string, number | readonly number[]> = {};
    for (const [name, value] of Object.entries(perDetector)) {
      // Own keys only: an inherited name such as `constructor` or `toString` is no threshold.
      if (!Object.hasOwn(entry.thresholds, name)) {
        throw new Error(`unknown threshold "${type}.${name}" (${type} thresholds: ${Object.keys(entry.thresholds).join(', ')})`);
      }
      values[name] = checkValue(type, name, entry.thresholds[name], value);
    }
    result[type] = Object.freeze(values);
  }
  return Object.freeze(result) as ThresholdOverrides;
}

/** The overrides for one entry, as the untyped map withThresholds() takes. */
export function overridesFor(entry: Detector, overrides: ThresholdOverrides | undefined): DetectorThresholds | undefined {
  return (overrides as Readonly<Record<string, DetectorThresholds>> | undefined)?.[entry.type];
}

function sameValue(a: number | readonly number[], b: number | readonly number[]): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/** The entry's thresholds that `overrides` moves off the default, or null when none does (no
 * override, or one equal to the default: that run is the specification's). */
export function tunedThresholdsOf(entry: Detector, overrides: ThresholdOverrides | undefined): TunedThresholds | null {
  const tuned: Record<string, TunedThreshold> = {};
  for (const [name, value] of Object.entries(overridesFor(entry, overrides) ?? {})) {
    if (!Object.hasOwn(entry.thresholds, name)) continue;
    const fallback = entry.thresholds[name];
    if (!sameValue(value, fallback)) tuned[name] = { value, default: fallback };
  }
  return Object.keys(tuned).length > 0 ? tuned : null;
}

// straggler judges a tail with skew's resolved thresholds (DetectorCtx.skewThresholds), so tuning skew
// changes which tails it reports without any `suppressedBy` link.
const THRESHOLD_DEPENDENCY: Readonly<Record<string, string>> = { straggler: 'skew' };

/** The tuned thresholds an entry's findings carry: its own, plus its `suppressedBy` entry's or the
 * entry it reads thresholds from (named `<entry>.<threshold>`), since tuning either changes which
 * of them survive. */
export function findingTunedThresholds(entry: Detector, overrides: ThresholdOverrides | undefined): TunedThresholds | null {
  const own = tunedThresholdsOf(entry, overrides);
  const suppressorType = entry.suppressedBy ?? THRESHOLD_DEPENDENCY[entry.type];
  const suppressor = suppressorType ? entries.find((d) => d.type === suppressorType) : undefined;
  const bySuppressor = suppressor ? tunedThresholdsOf(suppressor, overrides) : null;
  if (!suppressor || !bySuppressor) return own;
  const prefixed = Object.fromEntries(Object.entries(bySuppressor).map(([name, t]) => [`${suppressor.type}.${name}`, t]));
  return { ...own, ...prefixed };
}

/** findingTunedThresholds() for the first entry emitting finding type `type`, the entry whose
 * thresholds its clean-check summary reads. */
export function tunedThresholdsForType(type: string, overrides: ThresholdOverrides | undefined): TunedThresholds | null {
  const entry = ENTRY_BY_TYPE.get(type);
  return entry ? findingTunedThresholds(entry, overrides) : null;
}

/** Every tuned detector's overridden thresholds, keyed by entry type, or null when none is tuned. */
export function tunedDetectors(overrides: ThresholdOverrides | undefined): Record<string, TunedThresholds> | null {
  const byType: Record<string, TunedThresholds> = {};
  for (const entry of entries) {
    const tuned = tunedThresholdsOf(entry, overrides);
    if (tuned) byType[entry.type] = tuned;
  }
  return Object.keys(byType).length > 0 ? byType : null;
}

/** The thresholds an entry runs with under `overrides`: its own, with any override merged in. */
export function effectiveThresholds(entry: Detector, overrides: ThresholdOverrides | undefined): DetectorThresholds {
  const own = overridesFor(entry, overrides);
  return own ? { ...entry.thresholds, ...own } : entry.thresholds;
}

/** detectorCatalog() as a run under `overrides` used it: each row's effective thresholds, plus
 * `tunedThresholds` on a row an override moved off its defaults. */
export function tunedDetectorCatalog(overrides: ThresholdOverrides | undefined): DetectorCatalogEntry[] {
  return detectorCatalog().map((row, i) => {
    const entry = entries[i];
    const tuned = tunedThresholdsOf(entry, overrides);
    return tuned ? { ...row, thresholds: effectiveThresholds(entry, overrides), tunedThresholds: tuned } : row;
  });
}

function formatThresholdValue(value: number | readonly number[]): string {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

/** "ratioWarn 5 (default 3), minTasksForP95 40 (default 20)". */
export function describeTunedThresholds(tuned: TunedThresholds): string {
  return Object.entries(tuned)
    .map(([name, { value, default: fallback }]) => `${name} ${formatThresholdValue(value)} (default ${formatThresholdValue(fallback)})`)
    .join(', ');
}

/** A tuned run's report line after its label: every tuned detector's thresholds, then why its
 * findings' estimates are uncalibrated. `byType` is tunedDetectors()'s result. */
export function tunedRunNote(byType: Record<string, TunedThresholds>): string {
  const tuned = Object.entries(byType).map(([type, t]) => `${type} ${describeTunedThresholds(t)}`).join('; ');
  return `${tuned}. Findings from these detectors are marked, and their impact estimates are uncalibrated: the estimates are calibrated against the default thresholds.`;
}

/** The caveat a tuned finding carries in `validationRequired`: which thresholds produced it and,
 * when it has an estimate figure (`hasEstimate`), that the figure was never calibrated. */
export function tunedThresholdsNote(tuned: TunedThresholds, hasEstimate: boolean): string {
  const label = `Produced with tuned thresholds: ${describeTunedThresholds(tuned)}.`;
  return hasEstimate
    ? `${label} Impact estimates are calibrated against the default thresholds, so this finding's estimate is unvalidated.`
    : label;
}
