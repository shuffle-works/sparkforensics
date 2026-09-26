// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Finding } from '@sparkforensics/core/types.ts';
import {
  ImpactEstimate,
  formatWallClockRange,
  formatRawWaste,
  formatImpactEstimateCompact,
} from '../../src/view/ImpactEstimate.tsx';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    type: 'skew',
    impactBand: 'warning',
    ...overrides,
  } as Finding;
}

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

describe('ImpactEstimate component', () => {
  it('renders nothing for basis: informational (wallClock null, no rawWaste)', () => {
    const testFinding = finding({ type: 'configAudit', impactBand: 'info', impactEstimate: { basis: 'informational', wallClock: null, estimateMethod: 'none' } });
    const { container } = render(<ImpactEstimate finding={testFinding} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when impactEstimate is entirely absent', () => {
    const testFinding = finding({ type: 'skew', impactBand: 'warning' });
    const { container } = render(<ImpactEstimate finding={testFinding} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders only the raw-waste figure for basis: resourceOnly (wallClock null, rawWaste present)', () => {
    const testFinding = finding({
      type: 'utilization', impactBand: 'warning',
      impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 6, unit: 'coreHours' } },
    });
    render(<ImpactEstimate finding={testFinding} />);
    expect(screen.getByText('Potential savings:')).toBeInTheDocument();
    expect(screen.getByText('6.0 core-h')).toBeInTheDocument();
  });

  it('renders only the range, not the raw-waste figure, for basis: contended', () => {
    const testFinding = finding({
      type: 'gc', impactBand: 'warning',
      impactEstimate: { basis: 'contended', wallClock: { low: 92, high: 2209.5 }, estimateMethod: 'measured', rawWaste: { value: 1080, unit: 'coreMs' } },
    });
    render(<ImpactEstimate finding={testFinding} />);
    expect(screen.getByText('92ms-2.2s')).toBeInTheDocument();
    expect(screen.queryByText('1.1 core-s')).not.toBeInTheDocument();
  });

  it('renders a single "Xs" value for basis: serial (low === high), not the rawWaste figure alongside it', () => {
    const testFinding = finding({
      type: 'retryWaste', impactBand: 'warning',
      impactEstimate: { basis: 'serial', wallClock: { low: 1200, high: 1200 }, estimateMethod: 'measured', rawWaste: { value: 1200, unit: 'ms' } },
    });
    render(<ImpactEstimate finding={testFinding} />);
    expect(screen.queryAllByText('1.2s')).toHaveLength(1);
  });

  it('renders nothing for a rawWaste value that rounds to a zero-looking figure ("0.0 core-h")', () => {
    const testFinding = finding({
      type: 'utilization', impactBand: 'info',
      impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 0.04, unit: 'coreHours' } },
    });
    const { container } = render(<ImpactEstimate finding={testFinding} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a genuinely nonzero rawWaste figure that rounds to one decimal digit ("0.5 core-h"), not the zero-looking case above', () => {
    const testFinding = finding({
      type: 'utilization', impactBand: 'warning',
      impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 0.5, unit: 'coreHours' } },
    });
    render(<ImpactEstimate finding={testFinding} />);
    expect(screen.getByText('0.5 core-h')).toBeInTheDocument();
  });

  it('exposes estimateMethod via a title attribute, following the confidence-badge convention', () => {
    const testFinding = finding({
      type: 'skew', impactBand: 'warning',
      impactEstimate: { basis: 'serial', wallClock: { low: 1000, high: 1000 }, estimateMethod: 'modeled' },
    });
    render(<ImpactEstimate finding={testFinding} />);
    const el = screen.getByText('1.0s');
    expect(el.closest('[title]')?.getAttribute('title')).toMatch(/modeled/i);
  });
});

describe('formatImpactEstimateCompact', () => {
  it('returns just the high-end wall-clock value for a serial/contended estimate', () => {
    expect(formatImpactEstimateCompact({ basis: 'contended', wallClock: { low: 1000, high: 5000 }, estimateMethod: 'measured' })).toBe('5.0s');
  });

  it('returns the raw-waste figure for a resourceOnly estimate', () => {
    expect(formatImpactEstimateCompact({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 6, unit: 'coreHours' } })).toBe('6.0 core-h');
  });

  it('returns null for an informational estimate', () => {
    expect(formatImpactEstimateCompact({ basis: 'informational', wallClock: null, estimateMethod: 'none' })).toBeNull();
  });

  it('returns null when there is no estimate at all', () => {
    expect(formatImpactEstimateCompact(undefined)).toBeNull();
  });

  it('returns null for a rawWaste value that rounds to a zero-looking string, not the misleading "0.0 core-h"', () => {
    expect(
      formatImpactEstimateCompact({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 0.04, unit: 'coreHours' } }),
    ).toBeNull();
  });

  it('returns null for a wallClock.high value that rounds to a zero-looking string', () => {
    // 0.4ms is nonzero but Math.round(0.4) -> 0 -> formatDuration renders "0ms".
    expect(formatImpactEstimateCompact({ basis: 'serial', wallClock: { low: 0, high: 0.4 }, estimateMethod: 'measured' })).toBeNull();
  });

  it('returns the formatted figure for a genuinely nonzero rawWaste value that rounds to one decimal digit ("0.3 MB-s")', () => {
    // Regression: readsAsZero used to match any "0.<nondigit>" prefix, silently
    // dropping real values like this one.
    expect(
      formatImpactEstimateCompact({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 0.3, unit: 'mbSeconds' } }),
    ).toBe('0.3 MB-s');
  });
});
