import { describe, it, expect } from 'vitest';
import { estimateProvenance, formatRawWaste, impactEstimateFigure, rawWasteMeaning } from '../src/impact-format.ts';

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

describe('estimateProvenance', () => {
  it('describes a serial estimate as close to a point figure', () => {
    expect(estimateProvenance({ impactEstimate: { basis: 'serial', estimateMethod: 'measured', wallClock: { low: 2000, high: 2000 } } }))
      .toBe('2.0s, measured. The stage ran effectively alone, so this is close to a point estimate.');
  });
});
