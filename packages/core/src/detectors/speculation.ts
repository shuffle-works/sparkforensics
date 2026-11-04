import { effectiveConf } from './conf.ts';
import type { DetectorApp } from './types.ts';

// When Spark relaunches a slow task under the run's effective speculation settings: once the
// quantile of the stage's tasks has finished, a task running over the multiplier times the median
// of the finished ones gets a copy (TaskSetManager.checkSpeculatableTasks). Null when either
// setting is neither logged nor a default the run's Spark version fixes.
export function speculationRule(app: DetectorApp | null): string | null {
  const multiplier = Number.parseFloat(effectiveConf(app, 'spark.speculation.multiplier') ?? '');
  const quantile = Number.parseFloat(effectiveConf(app, 'spark.speculation.quantile') ?? '');
  if (!Number.isFinite(multiplier) || !Number.isFinite(quantile)) return null;
  return `a task running over ${multiplier}x the median is relaunched once ${Math.round(quantile * 100)}% of the stage's tasks have finished`;
}

export function speculationRuleNote(app: DetectorApp | null): string {
  const rule = speculationRule(app);
  return rule == null ? '' : ` (with this run's settings, ${rule})`;
}
