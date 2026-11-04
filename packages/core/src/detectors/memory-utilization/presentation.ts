import type { FindingPresentation } from '../../finding-presentation.ts';
import { switchAlreadyOn, idleCapacityLowering, DYNAMIC_ALLOCATION_KEY } from '../presentation-shared.ts';

export const presentation = {
  memoryUtilization: {
    name: 'memory utilization',
    tag: 'MEM',
    family: 'cost',
    pitch: 'Executors reserve far more memory than tasks use, or run close to their limit.',
    region: 'reference',
    thresholdSummary: () => 'executor heap usage outside the configured band',
    actionLabel(f) {
      switch (f.variant) {
        case 'idleCores': return 'Reduce idle cores';
        case 'wasteModel': return 'Right-size executor memory';
        case 'memoryBand':
          if (f.dataUnavailable) return 'Executor heap peaks unavailable';
          return 'Reduce executor memory';
      }
      return undefined;
    },
    genericRecommendation(f) {
      switch (f.variant) {
        case 'idleCores': return switchAlreadyOn(f, DYNAMIC_ALLOCATION_KEY)
          ? `Dynamic allocation is already on, so reduce cluster size${idleCapacityLowering(f)}.`
          : 'Either reduce cluster size (spark.executor.instances) or enable dynamic allocation.';
        case 'wasteModel': return 'Review spark.executor.memory and executor count.';
        case 'memoryBand':
          if (f.dataUnavailable) return undefined;
          return 'Memory may be over-provisioned: consider reducing spark.executor.memory for cost savings.';
      }
      return undefined;
    },
  },
} as const satisfies {
  memoryUtilization: FindingPresentation<'memoryUtilization'>;
};
