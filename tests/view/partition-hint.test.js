import { test, expect } from 'vitest';
import { recommendPartitions, partitionHint } from '../../src/view/partition-hint';

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
test('partitionHint advises a count only when the finding says spark.sql.shuffle.partitions sized the stage', () => {
  const stage = { shuffleReadBytes: 10 * 1024 * 1024 * 1024, taskCount: 4 };
  const shuffle = (partitions) => ({ type: 'shuffle', stageId: 1, impactBand: 'warning', value: stage.shuffleReadBytes, partitions });
  expect(partitionHint(shuffle('raise'), stage)).toEqual({ recommended: 80, current: 4 });
  for (const partitions of ['ownPartitioning', 'aqeCoalesced', 'sufficient', undefined]) {
    expect(partitionHint(shuffle(partitions), stage)).toBeNull();
  }
});
test('partitionHint gives no count for a spill finding whose input is the job\'s own repartition(n)', () => {
  const stage = { shuffleReadBytes: 10 * 1024 * 1024 * 1024, taskCount: 4 };
  const spill = (origin) => ({ type: 'spill', stageId: 1, impactBand: 'warning', value: 1, exchanges: [{ nodeId: 'e1', origin }] });
  expect(partitionHint(spill('REPARTITION_BY_NUM'), stage)).toBeNull();
  expect(partitionHint(spill('ENSURE_REQUIREMENTS'), stage)).toEqual({ recommended: 80, current: 4 });
});
