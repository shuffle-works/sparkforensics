import { test, expect } from 'vitest';
import { formatBytes, formatDuration, typeTag, buildHistogram, VISIBLE_LIMIT, worstImpactBand, formatFindingMagnitude, formatFindingChipDetail } from '../src/format-utils.js';

test('formatBytes scales units', () => {
  expect(formatBytes(0)).toBe('—');
  expect(formatBytes(2048)).toMatch(/KB$/);
});
test('formatDuration renders ms/s/m', () => {
  expect(formatDuration(500)).toMatch(/ms$/);
  expect(formatDuration(1500)).toMatch(/s$/);
});
test('typeTag maps configAudit to CFG', () => {
  expect(typeTag('configAudit')).toBe('CFG');
  expect(typeTag('skew')).toBe('SKEW');
  expect(typeTag('autoscalingChurn')).toBe('CHRN');
});
test('typeTag maps coreLocality to LOCAL', () => {
  expect(typeTag('coreLocality')).toBe('LOCAL');
});
test('buildHistogram bins values', () => {
  const h = buildHistogram([1, 2, 3, 4], 2);
  expect(h.data.reduce((a, b) => a + b, 0)).toBe(4);
});
test('VISIBLE_LIMIT constant preserved', () => {
  expect(VISIBLE_LIMIT).toBe(6);
});
test('worstImpactBand returns undefined on an empty list', () => {
  expect(worstImpactBand([])).toBeUndefined();
});
test('worstImpactBand picks the lowest-IMPACT_BAND_ORDER impact band, ties broken by first occurrence', () => {
  expect(
    worstImpactBand([{ impactBand: 'info' }, { impactBand: 'critical' }, { impactBand: 'warning' }]),
  ).toBe('critical');
  expect(worstImpactBand([{ impactBand: 'warning' }, { impactBand: 'warning' }])).toBe('warning');
});

test('formatFindingMagnitude renders byte-valued findings in scaled bytes', () => {
  expect(formatFindingMagnitude({ metric: 'memoryBytesSpilled', value: 4.2e9 })).toBe('4.2 GB');
  expect(formatFindingMagnitude({ metric: 'shuffleReadBytes', value: 1.2e6 })).toBe('1 MB');
});
test('formatFindingMagnitude renders sub-KB byte values locally (formatBytes has no such tier)', () => {
  expect(formatFindingMagnitude({ metric: 'avgFileSizeBytes', value: 500 })).toBe('500 B');
});
test('formatFindingMagnitude renders ratio/pct/count/duration units', () => {
  expect(formatFindingMagnitude({ metric: 'max/median', value: 3.2 })).toBe('3.2×');
  expect(formatFindingMagnitude({ metric: 'gcPct', value: 45 })).toBe('45%');
  expect(formatFindingMagnitude({ metric: 'hostDurationShare', value: 0.62 })).toBe('62%');
  expect(formatFindingMagnitude({ metric: 'speculativeTasks', value: 3 })).toBe('3');
  expect(formatFindingMagnitude({ metric: 'retryWasteMs', value: 38000 })).toBe('38.0s');
});
test('formatFindingMagnitude returns null for non-numeric or unmapped metrics', () => {
  expect(formatFindingMagnitude({ metric: 'stageFailureReason', value: 'ExecutorLostFailure' })).toBeNull();
  expect(formatFindingMagnitude({ metric: 'somethingUnmapped', value: 12 })).toBeNull();
  expect(formatFindingMagnitude({ value: 12 })).toBeNull();
});

test('formatFindingChipDetail joins magnitude and recoverable wall-clock time', () => {
  expect(
    formatFindingChipDetail({ metric: 'memoryBytesSpilled', value: 4.2e9, impactEstimate: { wallClock: { low: 30000, high: 38000 } } }),
  ).toBe('4.2 GB · ~38.0s');
});
test('formatFindingChipDetail shows only the recoverable time when no magnitude is available', () => {
  expect(
    formatFindingChipDetail({ metric: 'somethingUnmapped', value: 'x', impactEstimate: { wallClock: { low: 1000, high: 2000 } } }),
  ).toBe('~2.0s');
});
test('formatFindingChipDetail shows only the magnitude when there is no wall-clock claim', () => {
  expect(formatFindingChipDetail({ metric: 'gcPct', value: 45 })).toBe('45%');
  expect(formatFindingChipDetail({ metric: 'gcPct', value: 45, impactEstimate: { wallClock: null } })).toBe('45%');
});
test('formatFindingChipDetail returns null when neither magnitude nor time exists', () => {
  expect(formatFindingChipDetail({ metric: 'stageFailureReason', value: 'boom' })).toBeNull();
});
