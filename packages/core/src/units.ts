import { metricUnit, type MetricName } from './finding-presentation.ts';
import type { RawWasteFigure } from './types.ts';

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

// Spark reports some duration fields (e.g. executorCpuTime) in nanoseconds
// while most of this codebase works in milliseconds; convert at the source
// rather than trusting call sites to remember the unit.
export function nsToMs(ns: number): number {
  return ns / 1e6;
}

// A finding's magnitude, or 0 when it has none (an evidence caveat, or a text-valued finding whose
// value is in `valueText`).
export function numericValue(f: { value?: number }): number {
  return f.value ?? 0;
}

// Low-level "number -> display string" step shared by every widget's per-finding label resolver:
// each keeps its own type/metric routing and calls this only for the final value-to-string step,
// so the same number renders identically ("42%", "2.3×") everywhere.
export function formatMetricValue(unit: 'pct' | 'pctFraction' | 'ratio' | 'ms' | 'count', value: number): string {
  switch (unit) {
    case 'pct': return `${value}%`;
    // 'pct' expects an already-scaled 0-100 value (every detector's Finding.value convention); this
    // variant is for the rare metric (slowHost's hostDurationShare) whose value is a raw 0-1 fraction.
    case 'pctFraction': return `${Math.round(value * 100)}%`;
    case 'ratio': return `${value}×`;
    case 'ms': return formatDuration(value);
    case 'count': return `${value}`;
  }
}

// The compact plan-graph finding chip shows a metric's value in its unit (metrics.ts). 'bytes'
// handles the sub-KB tier formatBytes deliberately lacks; 'minutes' and 'seconds' convert to ms so
// they share formatDuration's phrasing.
// formatBytes floors at KB (its guarded contract, see partition-sizing.test.tsx); the plan-graph
// chip is the one place a sub-KB magnitude is meaningful (a smallFiles avgFileSizeBytes can be a
// few hundred bytes), so render that tier here rather than widening the shared formatter.
function formatChipBytes(bytes: number): string {
  if (bytes > 0 && bytes < 1000) return `${Math.round(bytes)} B`;
  return formatBytes(bytes);
}

/** Compact magnitude for a finding's plan-graph chip (e.g. "4.2 GB", "3.2×", "45%"), taken from the
 * finding's own `value` rendered in its `metric`'s unit. Returns null when there is no `value` (a
 * text-valued finding carries `valueText` instead) or the metric has no magnitude. */
export function formatFindingMagnitude(finding: { metric?: MetricName; value?: number }): string | null {
  if (!finding.metric || finding.value == null) return null;
  const unit = metricUnit(finding.metric);
  switch (unit) {
    case 'bytes': return formatChipBytes(finding.value);
    case 'minutes': return formatDuration(finding.value * 60000);
    case 'seconds': return formatDuration(finding.value * 1000);
    case 'mbSeconds': return formatRawWaste({ value: finding.value, unit: 'mbSeconds' });
    case 'text':
    case 'none': return null;
    case 'ms': return formatMetricValue('ms', finding.value);
    case 'ratio': return formatMetricValue('ratio', finding.value);
    case 'pct': return formatMetricValue('pct', finding.value);
    case 'pctFraction': return formatMetricValue('pctFraction', finding.value);
    case 'count': return formatMetricValue('count', finding.value);
  }
}

/** The plan-graph finding chip's detail text: the finding's magnitude and, when a wall-clock
 * recovery is claimed, "~<time>" (the optimistic `high` bound, matching formatImpactEstimateCompact),
 * joined by " · " (e.g. "4.2 GB · ~38.0s"). null when neither part is available. */
export function formatFindingChipDetail(
  finding: { metric?: MetricName; value?: number; impactEstimate?: { wallClock?: { low: number; high: number } | null } },
): string | null {
  const magnitude = formatFindingMagnitude(finding);
  const wallClock = finding.impactEstimate?.wallClock;
  const recoverable = wallClock ? `~${formatDuration(wallClock.high)}` : null;
  const parts = [magnitude, recoverable].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// Unit formatting for savings and resource figures, shared by the interpretation and by
// renderers that total a filtered selection themselves (the recommendation rollup).
export function fmtMs(ms: number): string {
  return ms === 0 ? '0s' : formatDuration(ms);
}

export function formatWallClockRange(low: number, high: number): string {
  const lowText = fmtMs(low);
  const highText = fmtMs(high);
  // Compare the formatted strings, not the raw ms values: formatDuration
  // floors to whole seconds (or minutes+seconds) once a value hits 60s, so
  // two endpoints that differ by under a bucket's precision (e.g. 140900ms
  // vs 141200ms, both "2m 21s") would still fail a raw low === high check
  // and render as a degenerate "2m 21s-2m 21s" range.
  if (lowText === highText) return highText;
  return `${lowText}-${highText}`;
}

const MS_PER_HOUR = 3_600_000;
const MB_SECONDS_PER_GB_HOUR = 1024 * 3600;
/** Below this many hours a figure keeps its small unit, so "0.0 GB-h" never
 * hides a real but small amount. */
const MIN_HOURS_SHOWN = 0.1;

const oneDecimal = (value: number): string =>
  (Math.round(value * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatRawWaste(rawWaste: RawWasteFigure): string {
  const rounded = Math.round(rawWaste.value * 10) / 10;
  switch (rawWaste.unit) {
    case 'bytes':
      return formatBytes(rawWaste.value);
    case 'ms':
      return fmtMs(rawWaste.value);
    case 'mbSeconds': {
      // A whole run's idle memory reaches millions of MB-seconds; GB-hours
      // keeps it a number a reader can compare.
      const gbHours = rawWaste.value / MB_SECONDS_PER_GB_HOUR;
      return gbHours >= MIN_HOURS_SHOWN ? `${oneDecimal(gbHours)} GB-h` : `${rounded.toLocaleString('en-US')} MB-s`;
    }
    case 'coreHours':
      return `${rounded.toFixed(1)} core-h`;
    case 'coreMs': {
      const coreHours = rawWaste.value / MS_PER_HOUR;
      return coreHours >= MIN_HOURS_SHOWN ? `${oneDecimal(coreHours)} core-h` : `${oneDecimal(rawWaste.value / 1000)} core-s`;
    }
    default:
      return String(rawWaste.value);
  }
}

/** A cost-only figure as core time. Task time summed over tasks (`ms`) is core time, and printing
 * it as a duration beside wall-clock savings reads as run time it does not shorten. */
export function asCoreTime(rawWaste: RawWasteFigure): RawWasteFigure {
  return rawWaste.unit === 'ms' ? { ...rawWaste, unit: 'coreMs' } : rawWaste;
}

// True when a formatted figure reads as zero, including a small nonzero value the fixed rounding
// collapsed (0.04 coreHours -> "0.0 core-h"). It tests the formatted text, so it holds for any unit.
// The fractional group must consume the whole decimal part before the terminator, so "0.5 core-h"
// does not match.
export function readsAsZero(formatted: string): boolean {
  return /^0(\.0+)?(?:[^0-9.]|$)/.test(formatted);
}

/** Whole cores from 10 up; one decimal below, so a small run's peak never
 * rounds down to "0 cores". */
export function formatCores(cores: number): string {
  return cores >= 10 ? String(Math.round(cores)) : cores.toFixed(1).replace(/\.0$/, '');
}

export const MS_PER_CORE_HOUR: number = 3.6e6;
