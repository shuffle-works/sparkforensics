import type { Finding } from '@sparkforensics/core/types';

const TARGET_PARTITION_BYTES = 128 * 1024 * 1024;
const MAX_RECOMMENDED = 8000;
const MEANINGFUL_RATIO = 1.5;

export function recommendPartitions(stage: {shuffleReadBytes?: number; taskCount?: number}): {recommended: number; current: number} | null {
  const bytes = stage.shuffleReadBytes ?? 0;
  if (bytes <= 0) return null;
  const recommended = Math.min(MAX_RECOMMENDED, Math.ceil(bytes / TARGET_PARTITION_BYTES));
  const current = stage.taskCount ?? 0;
  if (recommended <= current * MEANINGFUL_RATIO) return null;
  return { recommended, current };
}

/** The count to try for the stage of a shuffle or spill finding, only when `spark.sql.shuffle.partitions`
 * is what sized the stage. A shuffle finding says so with `partitions: 'raise'`; a spill finding whose input
 * exchange is the job's own `repartition(n)` says the opposite. */
export function partitionHint(finding: Finding, stage: {shuffleReadBytes?: number; taskCount?: number}): {recommended: number; current: number} | null {
  if (finding.type === 'shuffle' && finding.partitions !== 'raise') return null;
  if (finding.type === 'spill' && finding.exchanges?.[0]?.origin === 'REPARTITION_BY_NUM') return null;
  return recommendPartitions(stage);
}
