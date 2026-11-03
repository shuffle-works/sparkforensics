import type { EvidenceKey } from '@sparkforensics/core/types';

export const EVIDENCE_LABELS: Record<EvidenceKey, string> = {
  executorMetrics: 'Executor metrics',
  rddStorageSnapshots: 'RDD storage snapshots',
  sqlPlan: 'SQL plan',
  sparkConfiguration: 'Spark configuration',
  taskCoreTime: 'Task and core time',
  infrastructureContext: 'Infrastructure context',
  sourceContext: 'Source context',
  costContext: 'Cost context',
};

export function evidenceLabel(key: EvidenceKey): string {
  return EVIDENCE_LABELS[key];
}
