import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  pythonUdf: {
    name: 'row-at-a-time Python UDF',
    tag: 'PLAN',
    family: 'plan',
    pitch: 'Row-at-a-time Python functions slow a stage that vectorized code would speed up.',
    thresholdSummary: (t) => `over ${t.minBytesSent / 1048576} MiB sent to Python workers by stages running over ${t.minStageMs / 1000} s`,
    actionLabel: () => 'Vectorize Python UDF',
    genericRecommendation: () => 'Use Arrow-optimized Python UDFs (spark.sql.execution.pythonUDF.arrow.enabled, Spark 3.4 and later) or a pandas UDF instead of a row-at-a-time Python UDF.',
  },
} as const satisfies {
  pythonUdf: FindingPresentation<'pythonUdf'>;
};
