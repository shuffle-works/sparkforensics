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
    expect(getThresholdSummary('slowHost')).toContain(`${ratioWarn}× slower`);
    expect(getThresholdSummary('slowHost')).toContain(`from ${ratioTiers[0]}×`);
  });

  it('summarizes each emitted broadcast type, not the broadcastSizing entry', () => {
    expect(getThresholdSummary('overBroadcast')).toBe('a broadcast over 1 GiB');
    expect(getThresholdSummary('underBroadcast')).toBe('a join side its type can broadcast, between 1 MiB and 1 GiB, that skipped broadcast');
    expect(getThresholdSummary('broadcastSizing')).toBe('criteria not met');
  });

  it('reads a tuned run\'s thresholds when given its overrides', () => {
    expect(getThresholdSummary('spill', { spill: { singleTaskDiskGiB: 8 } })).toBe('single-task disk spill above 8 GiB');
    expect(getThresholdSummary('spill', { skew: { ratioWarn: 8 } })).toBe(getThresholdSummary('spill'));
  });

  it('states a tuned rate as a whole percent, without float noise', () => {
    expect(getThresholdSummary('failures')).toBe("over 5% of a stage's tasks failing");
    expect(getThresholdSummary('failures', { failures: { warnRate: 0.07 } })).toBe("over 7% of a stage's tasks failing");
  });

  it('falls back to a generic string for an unmapped type', () => {
    expect(getThresholdSummary('__unknown_type__')).toBe('criteria not met');
  });
});
