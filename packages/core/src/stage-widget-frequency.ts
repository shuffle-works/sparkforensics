import type { FindingType } from './types.ts';

const BOTTLENECK_WIDGET: Readonly<Record<string, string>> = {
  skew: 'task-skew', slowHost: 'task-skew', straggler: 'task-skew',
  shuffle: 'shuffle-io', spill: 'spill', gc: 'gc-pressure', failures: 'failures',
  coldStart: 'executor-timeline', utilization: 'executor-timeline', speculationWaste: 'executor-timeline',
} satisfies Partial<Record<FindingType, string>>;

// Cross-widget stage recurrence: how many distinct widget groups (skew, slowHost and straggler
// share task-skew) flag a stage. No production code calls it, and the group names in
// BOTTLENECK_WIDGET are labels, not ids of rendered widgets.
// `stageId` may be number|null|undefined: sql/config-scope findings never set it; `stageId == null`
// below treats both the same.
export function stageWidgetFrequency(catalog: Array<{stageId?: number | null; type: string}>): Map<number, number> {
  const perStage = new Map();
  for (const b of catalog) {
    if (b.stageId == null) continue;
    const widget = BOTTLENECK_WIDGET[b.type];
    if (!widget) continue;
    if (!perStage.has(b.stageId)) perStage.set(b.stageId, new Set());
    perStage.get(b.stageId).add(widget);
  }
  const freq = new Map();
  for (const [stageId, widgets] of perStage) freq.set(stageId, widgets.size);
  return freq;
}
