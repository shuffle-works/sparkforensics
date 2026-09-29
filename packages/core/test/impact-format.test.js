import { describe, it, expect } from 'vitest';
import {
  estimateProvenance, impactEstimateCompact, impactEstimateFigure, rawWasteMeaning, savingsMeaning,
} from '../src/impact-format.ts';
import { formatRawWaste, formatWallClockRange } from '../src/format-utils.ts';

describe('formatWallClockRange', () => {
  it('formats a zero endpoint without the no-data placeholder', () => {
    expect(formatWallClockRange(0, 0)).toBe('0s');
  });

  it('formats equal low/high as a single value, not a range', () => {
    expect(formatWallClockRange(2000, 2000)).toBe('2.0s');
  });

  it('formats a genuine range as low-high, including a zero low endpoint', () => {
    expect(formatWallClockRange(0, 25000)).toBe('0s-25.0s');
  });

  it('collapses a range whose endpoints round to the same formatted string, not just the same raw ms', () => {
    // 140100ms and 140800ms are distinct raw values but both floor to "2m 20s"
    // under formatDuration's whole-second bucketing once ms >= 60000.
    expect(formatWallClockRange(140100, 140800)).toBe('2m 20s');
  });

  it('still renders a range once endpoints land in different formatted buckets', () => {
    expect(formatWallClockRange(140100, 145200)).toBe('2m 20s-2m 25s');
  });
});

describe('formatRawWaste', () => {
  it('formats bytes using the shared byte formatter', () => {
    expect(formatRawWaste({ value: 1_500_000_000, unit: 'bytes' })).toMatch(/GB|MB/);
  });

  it('formats coreHours with one decimal place', () => {
    expect(formatRawWaste({ value: 6.25, unit: 'coreHours' })).toBe('6.3 core-h');
  });

  it('formats mbSeconds', () => {
    // formatRawWaste pins locale to en-US, so assert against that, not the ambient default.
    expect(formatRawWaste({ value: 1000, unit: 'mbSeconds' })).toBe(`${(1000).toLocaleString('en-US')} MB-s`);
  });

  it('formats a small coreMs value as core-seconds', () => {
    expect(formatRawWaste({ value: 4200, unit: 'coreMs' })).toBe('4.2 core-s');
  });

  it('formats a coreMs value of a tenth of a core-hour or more as core-hours', () => {
    expect(formatRawWaste({ value: 360_000, unit: 'coreMs' })).toBe('0.1 core-h');
    expect(formatRawWaste({ value: 9_000_000, unit: 'coreMs' })).toBe('2.5 core-h');
    expect(formatRawWaste({ value: 359_999, unit: 'coreMs' })).toBe('360.0 core-s');
  });

  it('turns a run-sized mbSeconds value into GB-hours instead of millions of MB-s', () => {
    // 10,956,685.3 MB-s / 1024 / 3600 = 2.97 GB-h.
    expect(formatRawWaste({ value: 10_956_685.3, unit: 'mbSeconds' })).toBe('3.0 GB-h');
    expect(formatRawWaste({ value: 59004952.576, unit: 'mbSeconds' })).toBe('16.0 GB-h');
    expect(formatRawWaste({ value: 1024 * 3600 * 1500, unit: 'mbSeconds' })).toBe('1,500.0 GB-h');
  });

  it('keeps MB-s below a tenth of a GB-hour, so a small figure never reads as 0.0 GB-h', () => {
    expect(formatRawWaste({ value: 368_639, unit: 'mbSeconds' })).toBe(`${(368_639).toLocaleString('en-US')} MB-s`);
    expect(formatRawWaste({ value: 368_640, unit: 'mbSeconds' })).toBe('0.1 GB-h');
  });

  it('formats zero ms without the no-data placeholder', () => {
    expect(formatRawWaste({ value: 0, unit: 'ms' })).toBe('0s');
  });

  it('rounds a small nonzero coreHours value down to the same text as a genuine zero', () => {
    // 0.04 core-h * 10 = 0.4, rounds to 0 -> "0.0 core-h", identical to formatRawWaste({value: 0, ...}).
    expect(formatRawWaste({ value: 0.04, unit: 'coreHours' })).toBe('0.0 core-h');
  });
});

describe('impactEstimateFigure', () => {
  it('prints the wall-clock range with no prefix, as run time', () => {
    expect(impactEstimateFigure({ basis: 'serial', estimateMethod: 'measured', wallClock: { low: 26100, high: 26100 } }))
      .toEqual({ text: '26.1s', meaning: 'of run time' });
  });

  it('falls back to the raw waste in dashboard units when there is no range', () => {
    const estimate = { basis: 'resourceOnly', estimateMethod: 'modeled', rawWaste: { value: 1639227.1, unit: 'mbSeconds' } };
    expect(impactEstimateFigure(estimate)).toEqual({ text: '0.4 GB-h', meaning: 'of unused executor memory' });
  });

  it('shows nothing for a figure that reads as zero or an informational estimate', () => {
    expect(impactEstimateFigure({ basis: 'resourceOnly', estimateMethod: 'measured', rawWaste: { value: 0.01, unit: 'coreHours' } })).toBeNull();
    expect(impactEstimateFigure({ basis: 'serial', estimateMethod: 'measured', wallClock: { low: 0, high: 0 } })).toBeNull();
    expect(impactEstimateFigure({ basis: 'informational', estimateMethod: 'none' })).toBeNull();
  });

  it('reads core time in core-s below a tenth of a core-hour', () => {
    expect(formatRawWaste({ value: 12_300, unit: 'coreMs' })).toBe('12.3 core-s');
    expect(rawWasteMeaning('coreMs')).toBe('of core time');
  });
});

describe('savingsMeaning', () => {
  const withEstimate = (impactEstimate) => ({ type: 'skew', stageId: 1, impactBand: 'critical', impactEstimate });
  const costOnly = (unit) =>
    withEstimate({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 10, unit } });

  it('says a wall-clock figure is run time, and names the resource behind a cost-only one', () => {
    expect(savingsMeaning(withEstimate({ basis: 'serial', wallClock: { low: 1, high: 1 }, estimateMethod: 'measured' }))).toBe('of run time');
    expect(savingsMeaning(costOnly('mbSeconds'))).toBe('of unused executor memory');
    expect(savingsMeaning(costOnly('coreHours'))).toBe('of core time');
    expect(savingsMeaning(costOnly('coreMs'))).toBe('of core time');
    expect(savingsMeaning(costOnly('bytes'))).toBe('of extra data written');
    expect(savingsMeaning(withEstimate({ basis: 'informational', wallClock: null, estimateMethod: 'none' }))).toBeNull();
    expect(savingsMeaning(withEstimate(undefined))).toBeNull();
  });
});

describe('estimateProvenance', () => {
  const withEstimate = (impactEstimate) => ({ type: 'skew', stageId: 1, impactBand: 'critical', impactEstimate });

  it('calls a serial figure close to a point estimate and notes ms raw waste only when the floor clipped it', () => {
    expect(estimateProvenance(withEstimate({ basis: 'serial', wallClock: { low: 2000, high: 2000 }, estimateMethod: 'measured', rawWaste: { value: 2000, unit: 'ms' } })))
      .toBe('Measured; the stage ran alone, so this is close to a point estimate.');
    expect(estimateProvenance(withEstimate({ basis: 'serial', wallClock: { low: 2000, high: 2000 }, estimateMethod: 'measured', rawWaste: { value: 900, unit: 'ms' } })))
      .toBe('Measured; the stage ran alone, so this is close to a point estimate.');
    expect(estimateProvenance(withEstimate({ basis: 'serial', wallClock: { low: 2000, high: 2000 }, estimateMethod: 'measured', rawWaste: { value: 9000, unit: 'ms' } })))
      .toBe('Measured; the stage ran alone, so this is close to a point estimate. Raw waste before the floor clipped it: 9.0s.');
  });

  it('describes a bytes raw waste as the resource measured, never as clipped time', () => {
    const text = estimateProvenance(withEstimate({ basis: 'serial', wallClock: { low: 4000, high: 4000 }, estimateMethod: 'modeled', rawWaste: { value: 3.2e9, unit: 'bytes' } }));
    expect(text).toMatch(/^Modeled; the stage ran alone, so this is close to a point estimate\. Resource waste measured: 3\.2 GB\.$/);
    expect(text).not.toContain('clipped');
  });

  it('explains a contended range as a floor and an optimistic high, without a degenerate range', () => {
    expect(estimateProvenance(withEstimate({ basis: 'contended', wallClock: { low: 1000, high: 3000 }, estimateMethod: 'modeled' })))
      .toBe('Modeled; the stage shared the cluster: 1.0s is the floor, 3.0s if the fix fully lands.');
    expect(estimateProvenance(withEstimate({ basis: 'contended', wallClock: { low: 141_100, high: 141_400 }, estimateMethod: 'modeled' })))
      .toBe('Modeled; the stage shared the cluster: its floor and high agree.');
  });

  it('says nothing for a figure that reads as zero, like the step itself', () => {
    expect(estimateProvenance(withEstimate({ basis: 'serial', wallClock: { low: 0, high: 0 }, estimateMethod: 'measured' }))).toBeNull();
    expect(estimateProvenance(withEstimate({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 0.04, unit: 'coreHours' } }))).toBeNull();
  });

  it('makes no run-time claim for a resource-only figure, and says nothing without a model', () => {
    expect(estimateProvenance(withEstimate({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 5000, unit: 'coreMs' } })))
      .toBe('Modeled; 5.0 core-s wasted, which may not shorten the run.');
    expect(estimateProvenance(withEstimate({ basis: 'informational', wallClock: null, estimateMethod: 'none' }))).toBeNull();
    expect(estimateProvenance(withEstimate(undefined))).toBeNull();
  });
});

describe('impactEstimateCompact', () => {
  it('returns just the high-end wall-clock value for a serial/contended estimate', () => {
    expect(impactEstimateCompact({ basis: 'contended', wallClock: { low: 1000, high: 5000 }, estimateMethod: 'measured' })).toBe('5.0s');
  });

  it('returns the raw-waste figure for a resourceOnly estimate', () => {
    expect(impactEstimateCompact({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 6, unit: 'coreHours' } })).toBe('6.0 core-h');
  });

  it('returns null for an informational estimate', () => {
    expect(impactEstimateCompact({ basis: 'informational', wallClock: null, estimateMethod: 'none' })).toBeNull();
  });

  it('returns null when there is no estimate at all', () => {
    expect(impactEstimateCompact(undefined)).toBeNull();
  });

  it('returns null for a rawWaste value that rounds to a zero-looking string, not the misleading "0.0 core-h"', () => {
    expect(
      impactEstimateCompact({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 0.04, unit: 'coreHours' } }),
    ).toBeNull();
  });

  it('returns null for a wallClock.high value that rounds to a zero-looking string', () => {
    // 0.4ms is nonzero but Math.round(0.4) -> 0 -> formatDuration renders "0ms".
    expect(impactEstimateCompact({ basis: 'serial', wallClock: { low: 0, high: 0.4 }, estimateMethod: 'measured' })).toBeNull();
  });

  it('returns the formatted figure for a genuinely nonzero rawWaste value that rounds to one decimal digit ("0.3 MB-s")', () => {
    // Regression: readsAsZero used to match any "0.<nondigit>" prefix, silently
    // dropping real values like this one.
    expect(
      impactEstimateCompact({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 0.3, unit: 'mbSeconds' } }),
    ).toBe('0.3 MB-s');
  });
});
