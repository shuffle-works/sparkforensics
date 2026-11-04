import type { FindingPresentation } from '../../finding-presentation.ts';
import { skewJoinGeneric } from '../presentation-shared.ts';

export const presentation = {
  straggler: {
    name: 'straggling task',
    tag: 'STRAG',
    family: 'speed',
    pitch: 'A few tasks run far longer than their peers, and the stage waits for them.',
    thresholdSummary: () => 'one or more tasks finishing far after the rest of their stage, for a reason other than reading more data',
    actionLabel: () => 'Fix stragglers',
    genericRecommendation: (f) => f.cause === 'data' ? `Uneven data volume drives the slow tasks: ${skewJoinGeneric(f, 'for join-driven skew, enable AQE skew-join handling (spark.sql.adaptive.skewJoin.enabled); otherwise salt the key or repartition on a better key.')}`
      : f.cause === 'gc' ? 'GC accounts for most of the slow tasks\' extra time: reduce object creation, use primitive types, avoid UDFs, increase executor memory.'
      : f.cause === 'fetchWait' ? 'Waiting on shuffle fetches accounts for most of the slow tasks\' extra time: look for a slow or overloaded node serving shuffle blocks, executors lost mid-stage, or reducers fetching many small blocks.'
      : f.cause === 'host' ? 'Most slow tasks ran on one host: check what it was running, and consider enabling spark.speculation to relaunch a lagging task automatically.'
      : f.cause === 'unexplained' ? 'The slow tasks read no more data than the median task, and GC, shuffle fetch wait and one slow host do not account for their time: look at per-record cost (UDFs, regular expressions, a call out per row).'
      : 'Nothing in the log attributes the slow tasks to data volume, GC, shuffle fetch wait or one host: check their input sizes, GC time and hosts before choosing a fix.',
  },
} as const satisfies {
  straggler: FindingPresentation<'straggler'>;
};
