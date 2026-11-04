import { walkPlanTree } from '../../plan-tree-walk.ts';
import { costOnly, multiStageImpact } from '../../impact-model.ts';
import { outputRowsOf, ownOutputRows, parseNestedLoopJoin } from '../../nested-loop-join.ts';
import { codeFix } from '../../remediation.ts';
import type { Finding, ImpactEstimate, RawWasteFigure, FindingOf } from '../../types.ts';
import { defineSqlDetector } from '../define.ts';
import { unionStageIds } from '../plan-attribution.ts';
import type { NumericFinding, PlanFindingEvidence, PlanNodeOrigin } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

/** A BroadcastNestedLoopJoin or CartesianProduct whose output is far larger than both inputs.
 * `nodeName` is the operator, `joinType` the Spark join type (null when the plan line has none)
 * and `condition` the join condition with expression ids removed (null for a join without one).
 * `leftRows` and `rightRows` are the input row counts the executors reported, null for a
 * CartesianProduct, which re-reads its inputs so their counts are not row counts. */
export interface NestedLoopJoinEvidence extends PlanFindingEvidence {
  nodeName: 'BroadcastNestedLoopJoin' | 'CartesianProduct';
  joinType: string | null;
  condition: string | null;
  outputRows: number;
  leftRows: number | null;
  rightRows: number | null;
}

export interface NestedLoopJoinFinding extends NumericFinding<'nestedLoopJoin'>, NestedLoopJoinEvidence, PlanNodeOrigin {}

export const nestedLoopJoinDetector = defineSqlDetector({
  type: 'nestedLoopJoin', order: 133, bandPolicy: 'derived', fixEffort: 'code', version: 1,
  emits: ['nestedLoopJoin'],
  docAnchor: '#joins',
  // minOutputRows: below it the join is cheap whatever its shape. minExpansion: a
  // BroadcastNestedLoopJoin's output must be this many times its larger input, so a join that
  // keeps its rows, or a cross join against a one-row side, is not an explosion. The stage time the
  // finding is graded on decides how much it matters.
  thresholds: { minOutputRows: 1_000_000, minExpansion: 10 },
  detect(sqlExec, _ctx, thresholds): Finding[] | null {
    if (!sqlExec.planTree) return null;
    const out: Finding[] = [];
    walkPlanTree(sqlExec.planTree, (node) => {
      const shape = parseNestedLoopJoin(node);
      if (!shape || node.children.length !== 2) return;
      const outputRows = ownOutputRows(node);
      if (outputRows == null || outputRows < thresholds.minOutputRows) return;
      // A CartesianProduct re-reads its inputs (UnsafeCartesianRDD in joins/CartesianProductExec
      // computes every left and right partition pair, so each input partition is read once per
      // partition of the other side), so the executors' input counts exceed the real row counts and cannot be compared with the output. It runs only when neither side can
      // be broadcast, and its output is the product of the inputs, so size alone qualifies it.
      const counted = shape.operator === 'CartesianProduct';
      const leftRows = counted ? null : outputRowsOf(node.children[0]);
      const rightRows = counted ? null : outputRowsOf(node.children[1]);
      let expansion: number | null = null;
      if (!counted) {
        // Without both input counts "far above both inputs" cannot be shown.
        if (leftRows == null || rightRows == null) return;
        expansion = outputRows / Math.max(leftRows, rightRows, 1);
        if (expansion < thresholds.minExpansion) return;
      }
      // Only the stages that run the join: the whole execution's stages would claim time the
      // join never spent.
      const stageIds = unionStageIds([node], []);
      const advice = shape.condition == null
        ? 'Confirm the cross join is intended, or add a join key so the rows are matched instead of multiplied.'
        : 'Add an equi-join key so Spark can use a hash or sort-merge join; for a range condition, bucket the range and join on the bucket as well.';
      const on = shape.condition == null ? '' : ` on ${shape.condition}`;
      out.push({
        type: 'nestedLoopJoin', executionId: sqlExec.id, stageIds,
        planNodeIds: [node.id!].filter(Boolean),
        impactBand: 'info',
        metric: 'outputRows', value: outputRows,
        nodeName: shape.operator, joinType: shape.joinType, condition: shape.condition,
        outputRows, leftRows, rightRows,
        confidence: 'medium',
        validationRequired: 'Row counts are the executors\' measured values; the time graded is the whole stage that runs the join, which also covers its other operators.',
        recommendation: `${shape.operator}${on} produced ${outputRows.toLocaleString('en-US')} rows${expansion == null
          ? shape.condition == null
            ? ', every left row paired with every right row.'
            // The condition filtered the pairings: the output is the rows it kept, not the product.
            : ': the pairs its condition kept from every left and right pairing it compared.'
          : ` from ${leftRows!.toLocaleString('en-US')} and ${rightRows!.toLocaleString('en-US')} input rows (${Math.round(expansion).toLocaleString('en-US')}x the larger side).`} ${advice}`,
        remediation: [codeFix(advice)],
      });
    });
    return out.length > 0 ? out : null;
  },
  estimate(finding, ctx): ImpactEstimate | null {
    const stageIds = finding.stageIds as number[] | undefined;
    if (!stageIds || stageIds.length === 0) return costOnly('none');
    // The join's cost is the time of the stages that run it: a nested-loop join is O(n x m)
    // inside them. Time with tasks running, not submit-to-complete (a stage waiting for cores
    // is not looping).
    const wasteMsByStage = new Map<number, number>();
    for (const id of stageIds) {
      const s = ctx.stages.get(id);
      if (s) wasteMsByStage.set(id, s.taskActiveMs ?? Math.max(0, (s.completedAt ?? 0) - (s.submittedAt ?? 0)));
    }
    if (wasteMsByStage.size === 0) return costOnly('none');
    const totalMs = [...wasteMsByStage.values()].reduce((sum, ms) => sum + ms, 0);
    const rawWaste: RawWasteFigure = { value: totalMs, unit: 'ms' };
    return multiStageImpact([...wasteMsByStage.keys()], wasteMsByStage, ctx, 'modeled', rawWaste)
      ?? costOnly('modeled', rawWaste);
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  nestedLoopJoin: { finding: NestedLoopJoinFinding; evidence: NestedLoopJoinEvidence };
}

export const detectors = [nestedLoopJoinDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  nestedLoopJoin: ['executionId', 'stageIds', 'nodeName', 'joinType', 'condition', 'outputRows', 'leftRows', 'rightRows'],
} as const satisfies {
  nestedLoopJoin: readonly AllKeys<NestedLoopJoinEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  nestedLoopJoin: ['nodeName'],
} as const satisfies {
  nestedLoopJoin: readonly (DiscriminatorSlot & AllKeys<FindingOf<'nestedLoopJoin'>>)[];
};
