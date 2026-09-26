// Savings figures as every surface prints them: the dashboard's widgets and verdict, and the
// CLI/MCP evidence report. One formatter set, so units and rounding never drift between paths.
import { formatBytes, formatDuration } from './format-utils.ts';
import type { Finding, RawWasteFigure } from './types.ts';

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

// formatRawWaste/fmtMs round to a fixed precision (one decimal place, or
// whole milliseconds below 1s), which can collapse a small but genuinely
// nonzero value down to a formatted string that reads exactly like zero
// (0.04 coreHours -> "0.0 core-h"). Checking the raw value against 0 misses
// this; checking the *formatted* text against zero's own formatted text
// catches it regardless of unit. The fractional group must consume the
// entire decimal part (all zeros) before the terminator: otherwise a real
// value like "0.5 core-h" leaves the "." unconsumed, and the terminator
// char class excludes ".", so it correctly fails to match.
export function readsAsZero(formatted: string): boolean {
  return /^0(\.0+)?(?:[^0-9.]|$)/.test(formatted);
}

/** A finding's one-line savings figure: the wall-clock range for a time-based
 * finding, the raw resource figure for a `resourceOnly` one, or nothing for a
 * purely informational estimate or a raw figure that rounds to zero ("0.0
 * core-h" reads as a measured nothing). */
export function impactFigure(finding: Finding): string | null {
  const estimate = finding.impactEstimate;
  if (!estimate) return null;
  if (estimate.wallClock) return formatWallClockRange(estimate.wallClock.low, estimate.wallClock.high);
  if (estimate.rawWaste) {
    const text = formatRawWaste(estimate.rawWaste);
    return readsAsZero(text) ? null : text;
  }
  return null;
}

/** What a savings figure counts, as the words that follow it: run time for a
 * wall-clock claim, or the resource a cost-only (`resourceOnly`) figure
 * measures. A time figure and a capacity figure look alike ("58.6s",
 * "0.7 core-h") but only the first shortens the run. Null when the finding
 * shows no figure. */
export function savingsMeaning(finding: Finding): string | null {
  const estimate = finding.impactEstimate;
  if (!estimate) return null;
  if (estimate.wallClock) return 'of run time';
  switch (estimate.rawWaste?.unit) {
    case 'mbSeconds': return 'of unused executor memory';
    case 'coreHours':
    case 'coreMs': return 'of core time';
    case 'bytes': return 'of extra data written';
    case 'ms': return 'of task time';
    default: return null;
  }
}
