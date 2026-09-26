// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Finding } from '@sparkforensics/core/types.ts';
import {
  ImpactEstimate,
  formatImpactEstimateCompact,
} from '../../src/view/ImpactEstimate.tsx';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    type: 'skew',
    impactBand: 'warning',
    ...overrides,
  } as Finding;
}

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
