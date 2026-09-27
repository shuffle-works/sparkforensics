// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Finding } from '@sparkforensics/core/types.ts';
import { ImpactEstimate } from '../../src/view/ImpactEstimate.tsx';
import { installInterpretation } from './_shared/interpretation';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    type: 'skew',
    impactBand: 'warning',
    ...overrides,
  } as Finding;
}

describe('ImpactEstimate component', () => {
  // The figure is the run interpretation's (FindingSavings.board); the component only renders it.
  it('renders nothing for basis: informational (wallClock null, no rawWaste)', () => {
    const testFinding = finding({ type: 'configAudit', impactBand: 'info', impactEstimate: { basis: 'informational', wallClock: null, estimateMethod: 'none' } });
    installInterpretation([testFinding]);
    const { container } = render(<ImpactEstimate finding={testFinding} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when impactEstimate is entirely absent', () => {
    const testFinding = finding({ type: 'skew', impactBand: 'warning' });
    installInterpretation([testFinding]);
    const { container } = render(<ImpactEstimate finding={testFinding} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders only the raw-waste figure for basis: resourceOnly (wallClock null, rawWaste present)', () => {
    const testFinding = finding({
      type: 'utilization', impactBand: 'warning',
      impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 6, unit: 'coreHours' } },
    });
    installInterpretation([testFinding]);
    render(<ImpactEstimate finding={testFinding} />);
    expect(screen.getByText('Potential savings:')).toBeInTheDocument();
    expect(screen.getByText('6.0 core-h')).toBeInTheDocument();
  });

  it('renders only the range, not the raw-waste figure, for basis: contended', () => {
    const testFinding = finding({
      type: 'gc', impactBand: 'warning',
      impactEstimate: { basis: 'contended', wallClock: { low: 92, high: 2209.5 }, estimateMethod: 'measured', rawWaste: { value: 1080, unit: 'coreMs' } },
    });
    installInterpretation([testFinding]);
    render(<ImpactEstimate finding={testFinding} />);
    expect(screen.getByText('92ms-2.2s')).toBeInTheDocument();
    expect(screen.queryByText('1.1 core-s')).not.toBeInTheDocument();
  });

  it('renders a single "Xs" value for basis: serial (low === high), not the rawWaste figure alongside it', () => {
    const testFinding = finding({
      type: 'retryWaste', impactBand: 'warning',
      impactEstimate: { basis: 'serial', wallClock: { low: 1200, high: 1200 }, estimateMethod: 'measured', rawWaste: { value: 1200, unit: 'ms' } },
    });
    installInterpretation([testFinding]);
    render(<ImpactEstimate finding={testFinding} />);
    expect(screen.queryAllByText('1.2s')).toHaveLength(1);
  });

  it('renders nothing for a rawWaste value that rounds to a zero-looking figure ("0.0 core-h")', () => {
    const testFinding = finding({
      type: 'utilization', impactBand: 'info',
      impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 0.04, unit: 'coreHours' } },
    });
    installInterpretation([testFinding]);
    const { container } = render(<ImpactEstimate finding={testFinding} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a genuinely nonzero rawWaste figure that rounds to one decimal digit ("0.5 core-h"), not the zero-looking case above', () => {
    const testFinding = finding({
      type: 'utilization', impactBand: 'warning',
      impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 0.5, unit: 'coreHours' } },
    });
    installInterpretation([testFinding]);
    render(<ImpactEstimate finding={testFinding} />);
    expect(screen.getByText('0.5 core-h')).toBeInTheDocument();
  });

  it('exposes estimateMethod via a title attribute, following the confidence-badge convention', () => {
    const testFinding = finding({
      type: 'skew', impactBand: 'warning',
      impactEstimate: { basis: 'serial', wallClock: { low: 1000, high: 1000 }, estimateMethod: 'modeled' },
    });
    installInterpretation([testFinding]);
    render(<ImpactEstimate finding={testFinding} />);
    const el = screen.getByText('1.0s');
    expect(el.closest('[title]')?.getAttribute('title')).toMatch(/modeled/i);
  });
});
