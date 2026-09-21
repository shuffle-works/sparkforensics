import { test, expect } from 'vitest';
import {
  formatBytes, formatDuration, typeTag, buildHistogram, VISIBLE_LIMIT, worstImpactBand,
  formatFindingMagnitude, formatFindingChipDetail, stageWidgetFrequency, formatStageIdsLabel,
  escHtml, trimCallsite, runLabel, recommendPartitions,
} from '../src/format-utils.js';

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

test('formatFindingMagnitude converts a stageDurationMinutes value to a formatted duration', () => {
  expect(formatFindingMagnitude({ metric: 'stageDurationMinutes', value: 2 })).toBe('2m 0s');
});

test('formatDuration renders whole minutes and seconds past the 60s boundary', () => {
  expect(formatDuration(125000)).toBe('2m 5s');
});

test('stageWidgetFrequency counts distinct board widgets flagging each stage, deduping same-widget types', () => {
  const freq = stageWidgetFrequency([
    { stageId: 1, type: 'skew' },
    { stageId: 1, type: 'straggler' }, // same widget (task-skew) as skew: counts once
    { stageId: 1, type: 'shuffle' }, // a different widget: bumps the count
    { stageId: 2, type: 'gc' },
    { stageId: 2, type: 'coldStart' }, // a different widget than gc: bumps the count
  ]);
  expect(freq.get(1)).toBe(2);
  expect(freq.get(2)).toBe(2);
});

test('stageWidgetFrequency ignores findings with no stageId or with an unmapped type', () => {
  const freq = stageWidgetFrequency([
    { stageId: null, type: 'skew' },
    { type: 'shuffle' },
    { stageId: 3, type: 'configAudit' },
  ]);
  expect(freq.size).toBe(0);
});

test('formatStageIdsLabel prints every id when within the default cap', () => {
  expect(formatStageIdsLabel([1, 2, 3])).toBe('1, 2, 3');
});

test('formatStageIdsLabel truncates past the default cap and counts the remainder', () => {
  const ids = Array.from({ length: 10 }, (_, i) => i + 1);
  expect(formatStageIdsLabel(ids)).toBe('1, 2, 3, 4, 5, 6, 7, 8, +2 more');
});

test('formatStageIdsLabel honors a custom cap', () => {
  expect(formatStageIdsLabel([1, 2, 3, 4], 2)).toBe('1, 2, +2 more');
});

test('escHtml escapes ampersands and angle brackets', () => {
  expect(escHtml('<script>a&b</script>')).toBe('&lt;script&gt;a&amp;b&lt;/script&gt;');
});

test('trimCallsite reduces an hdfs/s3 path in a Spark callsite to its basename', () => {
  expect(trimCallsite('collect at /u02/app/utils.py:1869')).toBe('collect at utils.py:1869');
  expect(trimCallsite('save at hdfs://host/warehouse/table/part.parquet:12')).toBe('save at part.parquet:12');
});

test('trimCallsite passes through a string with no " at " separator unchanged', () => {
  expect(trimCallsite('no callsite here')).toBe('no callsite here');
});

test('runLabel takes the name segment of a recent-files composite id', () => {
  expect(runLabel('app-name::12345::1700000000000')).toBe('app-name');
});

test('runLabel returns the whole string when there is no "::" separator', () => {
  expect(runLabel('bare-id')).toBe('bare-id');
});

test('recommendPartitions returns null for a stage with no shuffle read bytes', () => {
  expect(recommendPartitions({ shuffleReadBytes: 0, taskCount: 10 })).toBeNull();
});

test('recommendPartitions returns null when the recommendation is not a meaningful increase', () => {
  // 128MB target => 1 recommended partition for 100MB; current 10 tasks is already well above that.
  expect(recommendPartitions({ shuffleReadBytes: 100 * 1024 * 1024, taskCount: 10 })).toBeNull();
});

test('recommendPartitions recommends more partitions when current parallelism is too low', () => {
  const result = recommendPartitions({ shuffleReadBytes: 10 * 1024 * 1024 * 1024, taskCount: 4 });
  expect(result).toEqual({ recommended: 80, current: 4 });
});

test('buildHistogram returns empty labels/data for an empty input', () => {
  expect(buildHistogram([], 4)).toEqual({ labels: [], data: [] });
});
