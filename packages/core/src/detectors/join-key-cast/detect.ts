import { formatBytes } from '../../units.ts';
import { walkPlanTree } from '../../plan-tree-walk.ts';
import { noWasteModel } from '../../impact-model.ts';
import { joinKeyCastOf } from '../../join-key-cast.ts';
import { codeFix } from '../../remediation.ts';
import type { Finding, PlanNode, FindingOf } from '../../types.ts';
import { defineSqlDetector } from '../define.ts';
import { unionStageIds } from '../plan-attribution.ts';
import { joinSideShuffle, shuffleBytes } from '../plan-joins.ts';
import type { NumericFinding, PlanFindingEvidence, PlanNodeOrigin } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

/** A shuffled join whose key carries a cast (two key columns of different types), followed by an
 * exchange on a column it cast, because the join's output is partitioned by the cast expression.
 * `value` is the data size of that exchange in bytes (0 when the log has none). `castKeys` and
 * `exchangeKeys` are plan expressions with expression ids removed. */
export interface JoinKeyCastEvidence extends PlanFindingEvidence {
  nodeName: 'SortMergeJoin' | 'ShuffledHashJoin';
  castKeys: string[];
  exchangeKeys: string[];
}

export interface JoinKeyCastFinding extends NumericFinding<'joinKeyCast'>, JoinKeyCastEvidence, PlanNodeOrigin {}

export const joinKeyCastDetector = defineSqlDetector({
  type: 'joinKeyCast', order: 136, bandPolicy: 'own', fixEffort: 'code', version: 1,
  emits: ['joinKeyCast'],
  docAnchor: '#joins',
  thresholds: {},
  detect(sqlExec): Finding[] | null {
    if (!sqlExec.planTree) return null;
    const parents = new Map<PlanNode, PlanNode | null>();
    const joins: PlanNode[] = [];
    walkPlanTree(sqlExec.planTree, (node, parent) => {
      parents.set(node, parent);
      if (/Join/.test(node.name)) joins.push(node);
    }, { dedupe: true });
    const out: Finding[] = [];
    for (const join of joins) {
      const cast = joinKeyCastOf(join, parents);
      if (!cast) continue;
      const bytes = shuffleBytes(joinSideShuffle(cast.exchange) ?? cast.exchange);
      const advice = 'Give both join columns the same type before the join, so Spark adds no cast to the key and the join output keeps its partitioning.';
      out.push({
        type: 'joinKeyCast', executionId: sqlExec.id, stageIds: unionStageIds([cast.exchange], []),
        planNodeIds: [join.id!, cast.exchange.id!].filter(Boolean), impactBand: 'info',
        metric: 'shuffleBytes', value: bytes,
        nodeName: cast.operator, castKeys: cast.castKeys, exchangeKeys: cast.exchangeKeys,
        recommendation: `${cast.operator} joins on ${cast.castKeys.join(' and ')}, so its output is partitioned by the cast key and the exchange after it shuffles${bytes > 0 ? ` ${formatBytes(bytes)}` : ''} again by ${cast.exchangeKeys.join(', ')}. ${advice}`,
        remediation: [codeFix(advice)],
      });
    }
    return out.length > 0 ? out : null;
  },
  estimate: noWasteModel,
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  joinKeyCast: { finding: JoinKeyCastFinding; evidence: JoinKeyCastEvidence };
}

export const detectors = [joinKeyCastDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  joinKeyCast: ['executionId', 'stageIds', 'nodeName', 'castKeys', 'exchangeKeys'],
} as const satisfies {
  joinKeyCast: readonly AllKeys<JoinKeyCastEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  joinKeyCast: ['nodeName', 'planNodeIds'],
} as const satisfies {
  joinKeyCast: readonly (DiscriminatorSlot & AllKeys<FindingOf<'joinKeyCast'>>)[];
};
