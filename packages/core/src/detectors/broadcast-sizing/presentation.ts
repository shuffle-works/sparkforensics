import type { FindingPresentation } from '../../finding-presentation.ts';
import type { ConfRemediation, Remediation } from '../../finding-types.ts';

// The broadcast threshold properties a broadcast-sizing row's remediation names: the adaptive one when
// it governed the query, else (and for a row with none) spark.sql.autoBroadcastJoinThreshold.
function broadcastThresholdKeyOf(f: { remediation?: Remediation[] }): string {
  const keys = (f.remediation ?? []).filter((r): r is ConfRemediation => r.kind === 'conf').map((r) => r.key);
  return keys.length ? keys.join(' or ') : 'spark.sql.autoBroadcastJoinThreshold';
}

export const presentation = {
  underBroadcast: {
    name: 'missed broadcast join',
    tag: 'PLAN',
    family: 'plan',
    pitch: 'A shuffle join could broadcast its small side and skip the shuffle.',
    thresholdSummary: (t) => `a join side its type can broadcast, between ${t.minSmallerSideBytes / 1048576} MiB and ${t.overBroadcastBytes / 1073741824} GiB, that skipped broadcast`,
    actionLabel: () => 'Use broadcast join',
    genericRecommendation: (f) => (f.broadcastThreshold === 'notLimiting'
      ? 'The threshold already admits the build side, so it is not what stopped the broadcast: consider a broadcast() hint or collecting table statistics.'
      : `This could have been a broadcast join: consider a broadcast() hint or raising ${broadcastThresholdKeyOf(f)}.`),
  },
  overBroadcast: {
    name: 'oversized broadcast join',
    tag: 'PLAN',
    family: 'plan',
    pitch: 'A broadcast join ships a table too large to broadcast.',
    thresholdSummary: (t) => `a broadcast over ${t.overBroadcastBytes / 1073741824} GiB`,
    actionLabel: () => 'Fix oversized broadcast',
    genericRecommendation: (f) => (f.broadcastThreshold === 'notLimiting'
      ? 'The configured threshold is below this broadcast, so remove the broadcast() hint that forced it.'
      : f.broadcastThreshold === 'disabled'
      ? 'Automatic broadcast is already disabled, so remove the broadcast() hint that forced it.'
      : `Check for a misapplied broadcast hint or a misconfigured ${broadcastThresholdKeyOf(f)}.`),
  },
} as const satisfies {
  underBroadcast: FindingPresentation<'underBroadcast'>;
  overBroadcast: FindingPresentation<'overBroadcast'>;
};
