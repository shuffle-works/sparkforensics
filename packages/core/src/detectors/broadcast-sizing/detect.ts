import { formatBytes } from '../../units.ts';
import { walkPlanTree } from '../../plan-tree-walk.ts';
import { BROADCAST_BANDWIDTH_BPS, stageMappableWasteOrCostOnly } from '../../impact-model.ts';
import { isBroadcastExchangeNode } from '../../plan-node-detail.ts';
import { decreaseConf, increaseConf } from '../../remediation.ts';
import { parseSparkBytes } from '../../spark-conf.ts';
import type { Finding, ImpactEstimate, PlanNode, FindingOf } from '../../types.ts';
import { effectiveConf, queryApp } from '../conf.ts';
import { defineSqlDetector } from '../define.ts';
import { sqlStageIds, unionStageIds } from '../plan-attribution.ts';
import { broadcastCandidate, shuffleBytes } from '../plan-joins.ts';
import type { DetectorApp } from '../types.ts';
import { GB, MB } from '../units.ts';
import type { NumericFinding, PlanFindingEvidence, PlanNodeOrigin } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

/** How the effective broadcast threshold (spark.sql.autoBroadcastJoinThreshold, or its adaptive counterpart under AQE) relates to the finding: 'limits' (the
 * property decided it, or is unknown), 'notLimiting' (already admits, or already below, the
 * broadcast, so something else decided it) or 'disabled' (-1). */
export type BroadcastThreshold = 'limits' | 'notLimiting' | 'disabled';

export interface UnderBroadcastEvidence extends PlanFindingEvidence {
  /** The join's other, larger side (`value` is the smaller, build side). */
  largerSideBytes: number;
  /** The join type and the side a broadcast would build from, the smaller of those the type allows. */
  joinType: string;
  buildSide: 'left' | 'right';
  broadcastThreshold?: BroadcastThreshold;
}

export interface UnderBroadcastFinding extends NumericFinding<'underBroadcast'>, UnderBroadcastEvidence, PlanNodeOrigin {}

export interface OverBroadcastEvidence extends PlanFindingEvidence {
  broadcastThreshold?: BroadcastThreshold;
}

export interface OverBroadcastFinding extends NumericFinding<'overBroadcast'>, OverBroadcastEvidence, PlanNodeOrigin {}

// Labels a byte threshold in binary units, so a 1 GiB default reads '1 GB'.
function binaryThresholdLabel(bytes: number): string {
  const [unit, size] = ([['GB', GB], ['MB', MB], ['KB', 1024]] as const).find(([, u]) => bytes >= u) ?? ['bytes', 1];
  return `${Math.round(bytes / size * 10) / 10} ${unit}`;
}

const BROADCAST_THRESHOLD_KEY = 'spark.sql.autoBroadcastJoinThreshold';

const ADAPTIVE_BROADCAST_THRESHOLD_KEY = 'spark.sql.adaptive.autoBroadcastJoinThreshold';

// AQE keeps a join side out of a broadcast when too few of its shuffle partitions are non-empty
// (DynamicJoinSelection at v3.5.0).
const NON_EMPTY_PARTITION_RATIO_KEY = 'spark.sql.adaptive.nonEmptyPartitionRatioForBroadcastJoin';

// The property that bounds a broadcast: with AQE, runtime sizes are judged against the adaptive
// threshold when it is set (JoinSelectionHelper.canBroadcastBySize, apache/spark v3.5.0), and
// against spark.sql.autoBroadcastJoinThreshold otherwise.
function broadcastThresholdKey(app: DetectorApp | null, aqe: boolean): string {
  return aqe && effectiveConf(app, ADAPTIVE_BROADCAST_THRESHOLD_KEY) !== undefined ? ADAPTIVE_BROADCAST_THRESHOLD_KEY : BROADCAST_THRESHOLD_KEY;
}

// The run's effective value of a broadcast threshold property in bytes (logged, else Spark's 10 MiB
// default for the static one); negative when auto-broadcast is disabled, null when the value is
// not a size or the property has none.
function effectiveBroadcastThreshold(app: DetectorApp | null, key: string): number | null {
  const raw = effectiveConf(app, key);
  if (raw != null && /^-\d+$/.test(raw)) return -1;
  return parseSparkBytes(raw);
}

export const broadcastSizingDetector = defineSqlDetector({
  // Entry-level type is an identifier only; it never appears on an emitted finding. Findings
  // carry 'underBroadcast'/'overBroadcast' since one shared plan-walk covers both
  // opposite-direction rules.
  type: 'broadcastSizing', order: 132, bandPolicy: 'derived', fixEffort: 'config', version: 3,
  // Listed over-first: the two share order 132, and this list order is their display tie-break.
  emits: ['overBroadcast', 'underBroadcast'],
  docAnchor: '#bottleneck-broadcast-sizing',
  thresholds: {
    broadcastTiers: [10 * MB, 100 * MB, GB],
    comparisonTiers: [10 * GB, 300 * GB],
    overBroadcastBytes: GB,
    minSmallerSideBytes: MB,
  },
  detect(sqlExec, ctx, thresholds): Finding[] | null {
    if (!sqlExec.planTree) return null;
    const { broadcastTiers, comparisonTiers, overBroadcastBytes, minSmallerSideBytes } = thresholds;
    const fallbackStageIds = sqlStageIds(ctx, sqlExec.id);
    const app = queryApp(ctx.app, sqlExec.modifiedConfigs);
    const thresholdsFor = (adaptive: boolean) => {
      const key = broadcastThresholdKey(app, adaptive);
      // A broadcast planned up front is admitted by the static threshold, one AQE converted at runtime
      // by the adaptive one, so an existing broadcast is judged against each that applied.
      const admittingKeys = key === BROADCAST_THRESHOLD_KEY ? [key] : [BROADCAST_THRESHOLD_KEY, key];
      return {
        key, threshold: effectiveBroadcastThreshold(app, key),
        admittingThresholds: admittingKeys.map((k) => ({ key: k, threshold: effectiveBroadcastThreshold(app, k) })),
      };
    };
    const staticThresholds = thresholdsFor(false);
    const adaptiveThresholds = thresholdsFor(true);
    // AdaptiveSparkPlan need not be the root: Spark 3.2-3.3 wraps only a write command's child.
    const underAdaptive = new Set<PlanNode>();
    const out: Finding[] = [];
    walkPlanTree(sqlExec.planTree, (node, parent) => {
      if (node.name === 'AdaptiveSparkPlan' || (parent != null && underAdaptive.has(parent))) underAdaptive.add(node);
      const adaptive = underAdaptive.has(node);
      const { key, threshold, admittingThresholds } = adaptive ? adaptiveThresholds : staticThresholds;
      const candidate = node.name === 'SortMergeJoin' ? broadcastCandidate(node) : null;
      if (candidate) {
        const buildBytes = shuffleBytes(candidate.build);
        const otherBytes = shuffleBytes(candidate.stream);
        // Below the floor a broadcast saves nothing measurable, nor does broadcasting the larger side;
        // above the over-broadcast limit it would be flagged there instead.
        if (buildBytes >= minSmallerSideBytes && buildBytes <= overBroadcastBytes && buildBytes <= otherBytes) {
          const broadcastThreshold: BroadcastThreshold = threshold != null && threshold < 0 ? 'disabled'
            : threshold != null && threshold >= buildBytes ? 'notLimiting' : 'limits';
          const withinTiers = buildBytes < broadcastTiers[0]
            || (buildBytes < broadcastTiers[1] && otherBytes > comparisonTiers[0])
            || (buildBytes < broadcastTiers[2] && otherBytes > comparisonTiers[1]);
          if (broadcastThreshold === 'notLimiting' || withinTiers) {
            const contributors = [candidate.build, candidate.stream];
            const { joinType, buildSide } = candidate;
            const subject = `The ${buildSide} input to this ${joinType} Sort Merge Join (${formatBytes(buildBytes)})`;
            const otherSide = ` (the other side is ${formatBytes(otherBytes)})`;
            out.push({
              type: 'underBroadcast', executionId: sqlExec.id, stageIds: unionStageIds(contributors, fallbackStageIds),
              planNodeIds: contributors.map((n) => n.id!).filter(Boolean),
              impactBand: 'info', metric: 'smallerSideBytes',
              value: buildBytes, largerSideBytes: otherBytes,
              joinType, buildSide, broadcastThreshold,
              recommendation: broadcastThreshold === 'notLimiting'
                ? `${subject} is under the effective ${key} (${formatBytes(threshold!)}) yet was not broadcast${otherSide}, so the threshold is not what stopped it: ${adaptive
                  ? `a join hint, a shuffle that had already run, or a low share of non-empty partitions (below ${NON_EMPTY_PARTITION_RATIO_KEY}) usually is. Consider a broadcast() hint or lowering ${NON_EMPTY_PARTITION_RATIO_KEY}.`
                  : 'a join hint, missing table statistics, or a shuffle that had already run usually is. Consider a broadcast() hint or collecting statistics (ANALYZE TABLE).'}`
                : broadcastThreshold === 'disabled'
                  ? `${subject} was not broadcast${otherSide} because automatic broadcast is disabled (${key}=-1): this could have been a broadcast join. Set ${key} to a positive size or add a broadcast() hint.`
                  : `${subject} is over the effective ${key} (${threshold == null ? 'not a size' : formatBytes(threshold)}) but small enough to broadcast${otherSide}: this could have been a broadcast join. Consider a broadcast() hint or raising ${key}.`,
              remediation: broadcastThreshold === 'notLimiting' ? [] : [increaseConf(key)],
            });
          }
        }
      }
      if (isBroadcastExchangeNode(node.name)) {
        const m = (node.metrics ?? []).find(x => x.name === 'data size');
        if (m && m.value > overBroadcastBytes) {
          // BroadcastExchange's own metrics are driver-computed and never on a TaskEnd, so only
          // its child, which carries the executor-side metrics, contributes stage ids.
          const child = (node.children ?? [])[0];
          // A threshold below the broadcast cannot have admitted it: with none admitting it, a hint forced it.
          const admitted = admittingThresholds.filter((t) => t.threshold == null || t.threshold >= m.value);
          const autoBroadcastOff = admittingThresholds.every((t) => t.threshold != null && t.threshold < 0);
          const hintForced = admitted.length === 0;
          const broadcastThreshold: BroadcastThreshold = autoBroadcastOff ? 'disabled' : hintForced ? 'notLimiting' : 'limits';
          const below = admittingThresholds.map((t) => `${t.key} (${t.threshold! < 0 ? 'disabled' : formatBytes(t.threshold!)})`).join(' and ');
          const admittedKeys = admitted.map((t) => t.key);
          out.push({
            type: 'overBroadcast', executionId: sqlExec.id,
            stageIds: unionStageIds(child ? [child] : [], fallbackStageIds),
            planNodeIds: [node.id!].filter(Boolean),
            impactBand: 'warning', metric: 'broadcastBytes', value: m.value, broadcastThreshold,
            recommendation: autoBroadcastOff
              ? `This broadcast (${formatBytes(m.value)}) exceeds the ${binaryThresholdLabel(overBroadcastBytes)} threshold: automatic broadcast is already disabled, so remove the broadcast() hint that forced it.`
              : hintForced
                ? `This broadcast (${formatBytes(m.value)}) exceeds the ${binaryThresholdLabel(overBroadcastBytes)} threshold: ${below} ${admittingThresholds.length > 1 ? 'are' : 'is'} below it, so a broadcast() hint forced it: remove the hint.`
                : `This broadcast (${formatBytes(m.value)}) exceeds the ${binaryThresholdLabel(overBroadcastBytes)} threshold: check for a misapplied broadcast hint or a misconfigured ${admittedKeys.join(' or ')}.`,
            remediation: admittedKeys.map((k) => decreaseConf(k)),
          });
        }
      }
    });
    return out.length ? out : null;
  },
  estimate(finding, ctx): ImpactEstimate | null {
    // Both finding types carry bytes as `value`: overBroadcast's broadcastBytes, underBroadcast's
    // smallerSideBytes (its build side), each priced as one broadcast transfer.
    const wasteMs = (((finding.value as number | undefined) ?? 0) / BROADCAST_BANDWIDTH_BPS) * 1000;
    return stageMappableWasteOrCostOnly(wasteMs, finding.stageIds as number[] | undefined, ctx);
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  underBroadcast: { finding: UnderBroadcastFinding; evidence: UnderBroadcastEvidence };
  overBroadcast: { finding: OverBroadcastFinding; evidence: OverBroadcastEvidence };
}

export const detectors = [broadcastSizingDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  overBroadcast: ['executionId', 'stageIds', 'broadcastThreshold'],
  underBroadcast: ['executionId', 'stageIds', 'largerSideBytes', 'joinType', 'buildSide', 'broadcastThreshold'],
} as const satisfies {
  overBroadcast: readonly AllKeys<OverBroadcastEvidence>[];
  underBroadcast: readonly AllKeys<UnderBroadcastEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  overBroadcast: [],
  underBroadcast: ['largerSideBytes'],
} as const satisfies {
  overBroadcast: readonly (DiscriminatorSlot & AllKeys<FindingOf<'overBroadcast'>>)[];
  underBroadcast: readonly (DiscriminatorSlot & AllKeys<FindingOf<'underBroadcast'>>)[];
};
