import type { FindingPresentation } from '../../finding-presentation.ts';
import { shareLabel } from '../presentation-shared.ts';

export const presentation = {
  autoscalingChurn: {
    name: 'autoscaling churn',
    tag: 'CHRN',
    family: 'cost',
    pitch: 'Dynamic allocation adds and removes executors again and again.',
    thresholdSummary: (t) => `over ${shareLabel(t.warningPct)} of removed executors living under ${t.shortLivedMs / 60000} minutes`,
    actionLabel: () => 'Reduce autoscaling churn',
    genericRecommendation: (f) => (f.dynamicAllocation === 'off'
      ? 'Dynamic allocation is off, so the churn comes from executors lost or preempted: check the cluster manager\'s preemption and executor-loss logs.'
      : 'This looks like wasteful re-provisioning rather than normal scale-down: consider raising spark.dynamicAllocation.executorIdleTimeout or widening the minExecutors/maxExecutors bounds to reduce flapping.'),
  },
} as const satisfies {
  autoscalingChurn: FindingPresentation<'autoscalingChurn'>;
};
