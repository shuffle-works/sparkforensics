import { describe, it, expect } from 'vitest';
import { getThresholdSummary } from '../src/threshold-summary.ts';

describe('getThresholdSummary', () => {
  it('returns a human-readable string for a single-scalar-threshold detector', () => {
    expect(getThresholdSummary('spill')).toMatch(/GiB/);
  });

  it('returns a human-readable string for a multi-condition detector', () => {
    expect(getThresholdSummary('slowHost')).toMatch(/ratio|slower/);
  });

  it('falls back to a generic string for an unmapped type', () => {
    expect(getThresholdSummary('__unknown_type__')).toBe('criteria not met');
  });
});
