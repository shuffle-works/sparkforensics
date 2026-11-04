import type { FindingPresentation } from '../../finding-presentation.ts';

// The three configAudit DETECTORS entries share this row, one per audited property.
const CONFIG_AUDIT_PRESENTATION: FindingPresentation<'configAudit'> = {
  name: 'config audit',
  tag: 'CFG',
  family: 'setup',
  pitch: 'Spark properties that leave the cluster uncapped or the serializer slow.',
  thresholdSummary: () => 'a Spark conf value outside the recommended range',
  actionLabel(f) {
    switch (f.property) {
      case 'spark.dynamicAllocation.maxExecutors': return 'Set max executors';
      case 'spark.serializer': return 'Switch to Kryo';
      case 'spark.executor.memoryOverhead': return 'Raise memory overhead';
    }
    return undefined;
  },
  genericRecommendation(f) {
    switch (f.property) {
      case 'spark.dynamicAllocation.maxExecutors': return 'Set spark.dynamicAllocation.maxExecutors to cap cluster growth.';
      case 'spark.serializer': return 'Consider spark.serializer=org.apache.spark.serializer.KryoSerializer for faster, smaller buffers.';
      case 'spark.executor.memoryOverhead': return 'Raise executor memoryOverhead above the default Spark would have computed to avoid off-heap OOM-kills.';
    }
    return undefined;
  },
};

export const presentation = {
  configAudit: CONFIG_AUDIT_PRESENTATION,
} as const satisfies {
  configAudit: FindingPresentation<'configAudit'>;
};
