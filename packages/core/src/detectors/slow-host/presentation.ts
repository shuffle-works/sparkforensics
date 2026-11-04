import type { FindingPresentation } from '../../finding-presentation.ts';
import { switchAlreadyOn } from '../presentation-shared.ts';

export const presentation = {
  slowHost: {
    name: 'slow executor host',
    tag: 'HOST',
    family: 'speed',
    pitch: 'One executor host runs its tasks far slower than the rest of the cluster.',
    thresholdSummary: (t) => `a host ${t.ratioWarn}× slower than its peers by mean task time (per-executor figures from ${t.ratioTiers[0]}×, and only when the stage's own task-time spread cannot explain the gap)`,
    actionLabel(f) {
      if (f.variant === 'durationShare') return 'Fix data locality';
      if (f.variant === 'multiDim') return 'Investigate degraded executor';
      return 'Check slow host';
    },
    genericRecommendation(f) {
      if (f.variant === 'durationShare') return 'Check for data locality or partition assignment skewing work onto one node.';
      if (f.variant === 'multiDim') return 'Investigate uneven partition assignment or a degraded executor.';
      const check = 'Check what this host was running: it may just hold data locality for its tasks or carry one heavy stage, rather than a hardware fault.';
      return switchAlreadyOn(f, 'spark.speculation')
        ? `${check} Speculation is already on, so a lagging task there is already relaunched.`
        : `${check} Enable spark.speculation to relaunch a lagging task automatically.`;
    },
  },
} as const satisfies {
  slowHost: FindingPresentation<'slowHost'>;
};
