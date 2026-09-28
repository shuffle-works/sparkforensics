import { describe, it, expect } from 'vitest';
import { getThresholdSummary } from '../src/threshold-summary.ts';
import { FINDING_PRESENTATION } from '../src/finding-presentation.ts';
import { DETECTORS } from '../src/detectors.ts';

const thresholdsOf = (type) => DETECTORS.find((d) => d.type === type).thresholds;

describe('getThresholdSummary', () => {
  it('states the spill threshold from the detector\'s own thresholds', () => {
    expect(getThresholdSummary('spill')).toBe(`single-task disk spill above ${thresholdsOf('spill').singleTaskDiskGiB} GiB`);
    expect(FINDING_PRESENTATION.spill.thresholdSummary({ ...thresholdsOf('spill'), singleTaskDiskGiB: 2 })).toMatch(/above 2 GiB/);
  });

  it('states both slowHost ratios from the detector\'s own thresholds', () => {
    const { ratioWarn, ratioTiers } = thresholdsOf('slowHost');
    expect(getThresholdSummary('slowHost')).toContain(`${ratioWarn}x+ slower`);
    expect(getThresholdSummary('slowHost')).toContain(`starting at ${ratioTiers[0]}x`);
  });

  it('summarizes each emitted broadcast type, not the broadcastSizing entry', () => {
    expect(getThresholdSummary('overBroadcast')).toMatch(/size ceiling/);
    expect(getThresholdSummary('underBroadcast')).toMatch(/size floor/);
    expect(getThresholdSummary('broadcastSizing')).toBe('criteria not met');
  });

  it('falls back to a generic string for an unmapped type', () => {
    expect(getThresholdSummary('__unknown_type__')).toBe('criteria not met');
  });
});
