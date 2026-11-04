import { shareLabel } from '../../finding-presentation.ts';
import { computeCoreLocalityRatio, NON_LOCAL_TIERS } from '../../core-locality-ratio.ts';
import { NETWORK_FETCH_PENALTY_MS, costOnly, withAssumptions } from '../../impact-model.ts';
import { increaseConf } from '../../remediation.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { effectiveConf } from '../conf.ts';
import { coreLocalityConfidence } from '../confidence.ts';
import { defineAppDetector } from '../define.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface CoreLocalityEvidence {
  nonLocalTaskCount: number;
}

export interface CoreLocalityFinding extends NumericFinding<'coreLocality'>, CoreLocalityEvidence {}

const LOCALITY_WAIT_KEY = 'spark.locality.wait';

const LOCAL_TIERS = new Set(['PROCESS_LOCAL', 'NODE_LOCAL']);

export const coreLocalityDetector = defineAppDetector({
  // Non-local task ratio across stage.localityStats (RACK_LOCAL + ANY vs all tasks), the other
  // half of the "Wasted Cores Ratio" (idle-core half is memoryUtilization's idleCores).
  // NO_PREF stays in the denominator only: shuffle-read stages legitimately report it.
  type: 'coreLocality', order: 103, bandPolicy: 'own', fixEffort: 'config', version: 1,
  emits: ['coreLocality'],
  docAnchor: '#bottleneck-core-locality',
  thresholds: { minTasks: 50, warnRatio: 0.15, critRatio: 0.35 },
  detect(ctx, thresholds): Finding | null {
    const { totalTasks, nonLocalTasks, ratio, topStages } = computeCoreLocalityRatio([...ctx.stages.values()]);
    if (totalTasks == null || totalTasks < thresholds.minTasks) return null;
    // computeCoreLocalityRatio only returns ratio:null together with totalTasks:null (shared
    // EMPTY sentinel); the totalTasks guard above rules that out, so ratio is non-null here.
    if (ratio! < thresholds.warnRatio) return null;

    const value = Math.round(ratio! * 100);
    const hosts = new Set(ctx.executorsAdded.flatMap((e) => (e.host ? [e.host] : []))).size;
    const worst = topStages.filter((s) => s.nonLocalTasks > 0).slice(0, 3).map((s) => `stage ${s.stageId} (${Math.round(s.ratio * 100)}% of ${s.taskCount})`).join(', ');
    const wait = effectiveConf(ctx.app, LOCALITY_WAIT_KEY);
    const hasLocalSlots = [...ctx.stages.values()]
      .filter((s) => s.localityStats?.some((l) => NON_LOCAL_TIERS.has(l.locality) && l.count > 0))
      .some((s) => s.localityStats!.some((l) => LOCAL_TIERS.has(l.locality) && l.count > 0));
    const waitAdvice = hasLocalSlots
      ? `Raise ${LOCALITY_WAIT_KEY}${wait ? ` (${wait})` : ''} so the scheduler waits longer for a local slot, or run executors on the hosts that hold the data.`
      : `No task in the stages with non-local tasks reached process- or node-local placement, so no data-local executor exists and a longer ${LOCALITY_WAIT_KEY}${wait ? ` (${wait})` : ''} only delays each task: run executors on the hosts that hold the data.`;
    return {
      type: 'coreLocality', stageId: null,
      impactBand: ratio! >= thresholds.critRatio ? 'critical' : 'warning',
      metric: 'nonLocalRatio', value,
      // Raw count behind the ratio, for the impact estimator. Non-null whenever totalTasks is.
      nonLocalTaskCount: nonLocalTasks!,
      confidence: coreLocalityConfidence(ratio!, totalTasks, thresholds),
      validationRequired: `Flagged when at least ${shareLabel(thresholds.warnRatio)} of tasks run non-local (critical at ${shareLabel(thresholds.critRatio)}), on runs of ${thresholds.minTasks}+ tasks.`,
      recommendation: `${value}% of tasks (${nonLocalTasks!}) ran without process- or node-local data placement${hosts > 0 ? ` on a run of ${hosts} ${hosts === 1 ? 'host' : 'hosts'}` : ''}`
        + `${worst ? `, highest in ${worst}` : ''}. ${waitAdvice}`,
      remediation: hasLocalSlots ? [increaseConf(LOCALITY_WAIT_KEY)] : [],
    };
  },
  estimate(finding): ImpactEstimate | null {
    const nonLocal = (finding.nonLocalTaskCount as number | undefined) ?? 0;
    return withAssumptions(
      costOnly('modeled', { value: nonLocal * NETWORK_FETCH_PENALTY_MS, unit: 'coreMs' }),
      `assumes ${NETWORK_FETCH_PENALTY_MS} ms of extra core time per non-local task; the log has no measured fetch cost`,
    );
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  coreLocality: { finding: CoreLocalityFinding; evidence: CoreLocalityEvidence };
}

export declare const emits: Emits;

export const detectors = [coreLocalityDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  coreLocality: ['nonLocalTaskCount'],
} as const satisfies {
  coreLocality: readonly AllKeys<CoreLocalityEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  coreLocality: [],
} as const satisfies {
  coreLocality: readonly (DiscriminatorSlot & AllKeys<FindingOf<'coreLocality'>>)[];
};
