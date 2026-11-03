import { test, expect } from 'vitest';
import { formatBytes, formatDuration, formatFindingMagnitude, formatFindingChipDetail } from '../src/units.js';

test('formatBytes scales units', () => {
  expect(formatBytes(0)).toBe('—');
  expect(formatBytes(2048)).toMatch(/KB$/);
});
test('formatDuration renders ms/s/m', () => {
  expect(formatDuration(500)).toMatch(/ms$/);
  expect(formatDuration(1500)).toMatch(/s$/);
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
test('formatFindingMagnitude returns null for metrics with no magnitude', () => {
  expect(formatFindingMagnitude({ metric: 'stageFailureReason', valueText: 'ExecutorLostFailure' })).toBeNull();
  expect(formatFindingMagnitude({ metric: 'memoryBand', value: 12 })).toBeNull();
  expect(formatFindingMagnitude({ value: 12 })).toBeNull();
});
test('formatFindingChipDetail joins magnitude and recoverable wall-clock time', () => {
  expect(
    formatFindingChipDetail({ metric: 'memoryBytesSpilled', value: 4.2e9, impactEstimate: { wallClock: { low: 30000, high: 38000 } } }),
  ).toBe('4.2 GB · ~38.0s');
});
test('formatFindingChipDetail shows only the recoverable time when no magnitude is available', () => {
  expect(
    formatFindingChipDetail({ metric: 'stageFailureReason', value: undefined, impactEstimate: { wallClock: { low: 1000, high: 2000 } } }),
  ).toBe('~2.0s');
});
test('formatFindingChipDetail shows only the magnitude when there is no wall-clock claim', () => {
  expect(formatFindingChipDetail({ metric: 'gcPct', value: 45 })).toBe('45%');
  expect(formatFindingChipDetail({ metric: 'gcPct', value: 45, impactEstimate: { wallClock: null } })).toBe('45%');
});
test('formatFindingChipDetail returns null when neither magnitude nor time exists', () => {
  expect(formatFindingChipDetail({ metric: 'stageFailureReason', valueText: 'boom' })).toBeNull();
});
test('formatFindingMagnitude converts a stageDurationMinutes value to a formatted duration', () => {
  expect(formatFindingMagnitude({ metric: 'stageDurationMinutes', value: 2 })).toBe('2m 0s');
});
test('formatDuration renders whole minutes and seconds past the 60s boundary', () => {
  expect(formatDuration(125000)).toBe('2m 5s');
});
test('formatDuration rolls an hour or more into hours and minutes', () => {
  expect(formatDuration(59 * 60000 + 59000)).toBe('59m 59s');
  expect(formatDuration(5 * 3600000 + 59 * 60000 + 18000)).toBe('5h 59m');
});
