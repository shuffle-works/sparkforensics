import { walkPlanTree } from '../../plan-tree-walk.ts';
import { appDurationMs } from '../../impact-band.ts';
import { costOnly, multiStageImpact } from '../../impact-model.ts';
import { duplicateSubtreeDetail, duplicateSubtreeNote } from '../../finding-generic-recommendation.ts';
import type { Finding, ImpactEstimate, PlanNode, RawWasteFigure, FindingOf } from '../../types.ts';
import { duplicateSubtreeConfidence } from '../confidence.ts';
import { defineSqlDetector } from '../define.ts';
import { sqlStageIds, unionStageIds } from '../plan-attribution.ts';
import { findDuplicateSubtrees, normalizeDetail, relationIdOf } from '../plan-shape.ts';
import type { NumericFinding, PlanFindingEvidence, PlanNodeOrigin } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface DuplicatePlanSubtreeEvidence extends PlanFindingEvidence {
  // Share of each linked stage's operators that sit in the repeated subtree.
  stageShares: Record<number, number>;
  occurrencesIdentical: boolean;
  readsDifferentVersions: boolean;
  rootAction?: string;
  rootName: string;
  subtreeSize: number;
  sampleRelation: string | null;
  groupIndex: number;
}

export interface DuplicatePlanSubtreeFinding
  extends NumericFinding<'duplicatePlanSubtree'>, DuplicatePlanSubtreeEvidence, PlanNodeOrigin {}

// True when every occurrence also agrees node-for-node on normalized detail (filters, columns,
// scanned table, literals). The fingerprint ignores detail, so occurrences can be same-shaped
// branches over different data; only identical ones are repeated work that computing once would
// save. AQE query-stage numbers (`ShuffleQueryStage 718` vs `720`) name the same computation's
// runtime stage and are ignored too. Calibration: threshold-tables.md.
function occurrencesHaveIdenticalDetails(occurrences: PlanNode[]): boolean {
  const detailsOf = (root: PlanNode): string[] => {
    const out: string[] = [];
    walkPlanTree(root, (n) => out.push(n.detail ?? ''));
    return out;
  };
  const normalize = (d: string): string => normalizeDetail(d).replace(/\b(\w+QueryStage)\s+\d+/g, '$1');
  const first = detailsOf(occurrences[0]);
  const firstNormalized: (string | undefined)[] = [];
  for (const other of occurrences.slice(1)) {
    const details = detailsOf(other);
    if (details.length !== first.length) return false;
    for (let i = 0; i < first.length; i++) {
      if (details[i] === first[i]) continue;
      firstNormalized[i] ??= normalize(first[i]);
      if (normalize(details[i]) !== firstNormalized[i]) return false;
    }
  }
  return true;
}

// Actions that only display a result: a repeat under them is not a missed cache of the job's
// own work. Under count and save the same repeat is real waste and keeps its ranking.
const INSPECTION_ACTIONS: ReadonlySet<string> = new Set(['show', 'showString', 'collect']);

// The action in an execution description such as "count at Job.scala:12".
function rootActionOf(description: string | undefined): string | null {
  return /^\s*(\w+) at /.exec(description ?? '')?.[1] ?? null;
}

// True when the occurrences scan the same Delta tables at different recorded versions, which no
// cache can serve. A Delta scan with no recorded version makes the answer unknown, so false.
function occurrencesReadDifferentDeltaVersions(occurrences: PlanNode[]): boolean {
  const reads = occurrences.map((root) => {
    const scans: { relation: string; version?: string }[] = [];
    walkPlanTree(root, (n) => {
      const relation = relationIdOf(n);
      if (relation === null || !/delta/i.test(n.detail ?? '')) return;
      scans.push({ relation, version: /\bversion(?:AsOf)?\s*[=:]\s*(\d+)/i.exec(n.detail!)?.[1] });
    });
    return scans;
  });
  if (reads.some((scans) => scans.length === 0 || scans.some((scan) => scan.version === undefined))) return false;
  const key = (scans: typeof reads[number], field: 'relation' | 'version') => scans.map((scan) => scan[field]).join('|');
  return reads.every((scans) => key(scans, 'relation') === key(reads[0], 'relation'))
    && reads.some((scans) => key(scans, 'version') !== key(reads[0], 'version'));
}

// Stages that run nothing but the duplicated occurrences' operators: every operator attributed to
// the stage is inside `nodes`. A stage shared with operators outside them (the join consuming the
// subtree, the other join side) does other work too, so its time isn't the subtree's to claim, and
// counting it would let sibling groups claim the same stage twice. A WholeStageCodegen wrapper and
// an Exchange's write half aren't other work (the fused pipeline around an operator, the shuffle
// write of its output), so they're left out of both counts.
function countsTowardStage(node: PlanNode): boolean {
  return node.exchangeRole !== 'write' && !node.name.startsWith('WholeStageCodegen');
}

function operatorCountByStage(nodes: Iterable<PlanNode>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const node of nodes) {
    if (!countsTowardStage(node)) continue;
    for (const sid of node.stageIds ?? []) counts.set(sid, (counts.get(sid) ?? 0) + 1);
  }
  return counts;
}

function stageOperatorShares(nodes: PlanNode[], executionCounts: Map<number, number>): Record<number, number> {
  const shares: Record<number, number> = {};
  for (const [sid, count] of operatorCountByStage(nodes)) shares[sid] = count / (executionCounts.get(sid) ?? count);
  return shares;
}

export const duplicatePlanSubtreeDetector = defineSqlDetector({
  type: 'duplicatePlanSubtree', order: 130, bandPolicy: 'derived', fixEffort: 'code', version: 2,
  emits: ['duplicatePlanSubtree'],
  docAnchor: '#bottleneck-duplicate-plan-subtree',
  // stageFloorPct: the 0.5% runtime floor. The claim counts at most each linked stage's own
  // task-active time, so a repeat whose stages together lasted less than this share of the run
  // would grade info. A repeat with no linked stage time is kept.
  thresholds: { minSubtreeSize: 3, minOccurrences: 2, stageFloorPct: 0.005 },
  detect(sqlExec, ctx, thresholds): Finding[] | null {
    if (!sqlExec.planTree) return null;
    const groups = findDuplicateSubtrees(sqlExec.planTree, thresholds);
    if (groups.length === 0) return null;
    const fallbackStageIds = sqlStageIds(ctx, sqlExec.id);
    const executionNodes: PlanNode[] = [];
    walkPlanTree(sqlExec.planTree, (node) => executionNodes.push(node));
    const operatorsByStage = operatorCountByStage(executionNodes);
    const runMs = appDurationMs(ctx.app);
    const findings = groups.map((g): Finding | null => {
      const nodes: PlanNode[] = [];
      for (const n of g.nodes) walkPlanTree(n, (node) => nodes.push(node));
      const stageIds = unionStageIds(nodes, fallbackStageIds);
      let stagesMs = 0;
      for (const id of stageIds) {
        const stage = ctx.stages.get(id);
        if (stage) stagesMs += Math.max(0, (stage.completedAt ?? 0) - (stage.submittedAt ?? 0));
      }
      if (runMs != null && stagesMs > 0 && stagesMs < runMs * thresholds.stageFloorPct) return null;
      const readsDifferentVersions = occurrencesReadDifferentDeltaVersions(g.nodes);
      const occurrencesIdentical = !readsDifferentVersions && occurrencesHaveIdenticalDetails(g.nodes);
      const rootAction = rootActionOf(sqlExec.description);
      const underInspectionAction = INSPECTION_ACTIONS.has(rootAction ?? '');
      const stageShares = stageOperatorShares(nodes, operatorsByStage);
      // resolvePlanTree always sets id, so the `!` here and below is safe.
      const planNodeIds = nodes.map((n) => n.id!).filter(Boolean);
      const detail = duplicateSubtreeDetail({ ...g, value: g.occurrences });
      const note = duplicateSubtreeNote({ occurrencesIdentical, readsDifferentVersions });
      return {
        type: 'duplicatePlanSubtree', executionId: sqlExec.id, stageIds, planNodeIds,
        stageShares, occurrencesIdentical, readsDifferentVersions,
        ...(rootAction !== null && { rootAction }),
        // Repeats with differing details or under an inspection action get no estimate, and
        // neither does a subtree with no stage of its own, so this fallback band stands.
        impactBand: occurrencesIdentical && !underInspectionAction && Object.keys(stageShares).length > 0 ? 'warning' : 'info',
        metric: 'subtreeOccurrences', value: g.occurrences,
        rootName: g.rootName, subtreeSize: g.subtreeSize, sampleRelation: g.sampleRelation,
        groupIndex: g.groupIndex,
        confidence: occurrencesIdentical ? duplicateSubtreeConfidence(g.subtreeSize, g.occurrences, thresholds) : 'low',
        validationRequired: 'Matching compares operator and metric names only, not literals or expression IDs: confirm the repeat in the Spark UI SQL tab before acting.',
        recommendation: readsDifferentVersions
          ? `${detail}.${note}`
          : `${detail}: ${g.isExchangeRoot
            ? 'this looks like a possible missed exchange reuse; check whether the same shuffle could be computed once and reused.'
            : 'consider caching/persisting the shared computation or check for a duplicated query branch.'}${note}`,
      };
    }).filter((f): f is Finding => f !== null);
    return findings.length > 0 ? findings : null;
  },
  estimate(finding, ctx): ImpactEstimate | null {
    const stageIds = finding.stageIds as number[] | undefined;
    if (!stageIds || stageIds.length === 0) return null;
    // detect() reports subtreeOccurrences >= 2. Only repeats past the first are redundant:
    // computing the subtree once is real work, so waste is (occurrences-1)/occurrences of the stages' time.
    const occurrences = typeof finding.value === 'number' ? finding.value : 0;
    // One occurrence repeats nothing: reached only with minOccurrences tuned below 2 or a malformed value.
    if (occurrences < 2) return costOnly('none');
    // Same-shaped repeats whose details differ compute different data: nothing is known to be
    // recomputed, so there is no time to claim.
    if (finding.occurrencesIdentical === false) return costOnly('none');
    if (INSPECTION_ACTIONS.has(String(finding.rootAction))) return costOnly('none');
    // Each stage contributes the share of its operators inside the repeated subtree: a stage it
    // shares with other operators (the consuming join, the join's other side) isn't all its
    // time, and claiming whole stages let sibling groups claim the same stage twice. Findings
    // built without the field (hand-made fixtures) count every linked stage whole.
    const shares = (finding.stageShares ?? null) as Record<number, number> | null;
    const redundantFraction = (occurrences - 1) / occurrences;
    const wasteMsByStage = new Map<number, number>();
    for (const id of stageIds) {
      const s = ctx.stages.get(id);
      const share = shares ? (shares[id] ?? 0) : 1;
      if (s && share > 0) {
        // Time with tasks running, not submit-to-complete: a stage waiting for cores isn't
        // recomputing anything.
        const activeMs = s.taskActiveMs ?? Math.max(0, (s.completedAt ?? 0) - (s.submittedAt ?? 0));
        wasteMsByStage.set(id, activeMs * share * redundantFraction);
      }
    }
    // No operator of the subtree ran in a known stage: no time to attribute.
    if (wasteMsByStage.size === 0) return costOnly('none');
    const totalWasteMs = [...wasteMsByStage.values()].reduce((sum, ms) => sum + ms, 0);
    const rawWaste: RawWasteFigure = { value: totalWasteMs, unit: 'ms' };
    return multiStageImpact([...wasteMsByStage.keys()], wasteMsByStage, ctx, 'measured', rawWaste)
      ?? costOnly('measured', rawWaste);
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  duplicatePlanSubtree: { finding: DuplicatePlanSubtreeFinding; evidence: DuplicatePlanSubtreeEvidence };
}

export declare const emits: Emits;

export const detectors = [duplicatePlanSubtreeDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  duplicatePlanSubtree: [
    'executionId', 'stageIds', 'stageShares', 'occurrencesIdentical', 'readsDifferentVersions', 'rootAction', 'rootName', 'subtreeSize', 'sampleRelation',
    'groupIndex',
  ],
} as const satisfies {
  duplicatePlanSubtree: readonly AllKeys<DuplicatePlanSubtreeEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  duplicatePlanSubtree: ['rootName', 'subtreeSize', 'groupIndex'],
} as const satisfies {
  duplicatePlanSubtree: readonly (DiscriminatorSlot & AllKeys<FindingOf<'duplicatePlanSubtree'>>)[];
};
