import { walkPlanTree } from '../../plan-tree-walk.ts';
import { noWasteModel } from '../../impact-model.ts';
import { commandOf, mergeRowsOf, metricValue } from '../../write-targets.ts';
import { indexByRoot, resolveDeltaCommandTarget } from '../../delta-targets.ts';
import type { Finding, FindingOf } from '../../types.ts';
import { defineSqlDetector } from '../define.ts';
import { unionStageIds } from '../plan-attribution.ts';
import type { NumericFinding, PlanFindingEvidence, PlanNodeOrigin } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

/** A MergeIntoCommand that rewrote far more unmodified target rows than it changed (`rewrittenRows`),
 * or kept most target files after skipping although its changes touched few of the partitions it
 * scanned (`weakSkipping`). `value` is the unmodified rows rewritten, or the files kept. The file and
 * partition counts are null for a rule that does not read them. */
export interface MergeRewriteEvidence extends PlanFindingEvidence {
  rule: 'rewrittenRows' | 'weakSkipping';
  rewrittenRows: number;
  changedRows: number;
  filesBefore: number | null;
  filesAfter: number | null;
  partitionsScanned: number | null;
  partitionsTouched: number | null;
  /** The table or path the MERGE writes, null when the log does not name exactly one. */
  target: string | null;
}

export interface MergeRewriteFinding extends NumericFinding<'mergeRewrite'>, MergeRewriteEvidence, PlanNodeOrigin {}

export const mergeRewriteDetector = defineSqlDetector({
  type: 'mergeRewrite', order: 135, bandPolicy: 'own', fixEffort: 'code', version: 1,
  emits: ['mergeRewrite'],
  docAnchor: '#table-formats',
  // rewrittenRows: unmodified rows rewritten (at least minCopiedRows, and minCopiedToChangedRatio
  // times the rows inserted, updated and deleted). weakSkipping: at least minTargetFiles files and
  // minFilesKeptShare of them kept after skipping, while the files removed and added sit in at most
  // maxTouchedPartitionShare of the partitions scanned.
  thresholds: {
    minCopiedRows: 100_000, minCopiedToChangedRatio: 2,
    minTargetFiles: 8, minFilesKeptShare: 0.9, maxTouchedPartitionShare: 0.5,
  },
  detect(sqlExec, ctx, thresholds): Finding[] | null {
    if (!sqlExec.planTree) return null;
    const out: Finding[] = [];
    walkPlanTree(sqlExec.planTree, (node) => {
      const command = commandOf(node.name);
      const rows = mergeRowsOf(command, node);
      if (rows?.copied == null) return;
      const changedRows = (rows.inserted ?? 0) + (rows.updated ?? 0) + (rows.deleted ?? 0);
      const filesBefore = metricValue(node, 'number of target files before skipping');
      const filesAfter = metricValue(node, 'number of target files after skipping');
      const partitionsScanned = metricValue(node, 'number of target partitions after skipping');
      // A partition the MERGE removed files from or added files to holds a change: each counter is a
      // lower bound on the partitions changed, so the larger one is.
      const removedFrom = metricValue(node, 'number of target partitions from which files were removed');
      const addedTo = metricValue(node, 'number of target partitions to which files were added');
      const partitionsTouched = removedFrom == null || addedTo == null ? removedFrom ?? addedTo : Math.max(removedFrom, addedTo);
      ctx.executionsByRoot ??= indexByRoot(ctx.sql);
      const target = resolveDeltaCommandTarget(command, sqlExec, node, ctx.executionsByRoot)?.target ?? null;
      const base = {
        type: 'mergeRewrite' as const, executionId: sqlExec.id, stageIds: unionStageIds([node], []),
        planNodeIds: [node.id!].filter(Boolean), impactBand: 'info' as const,
        rewrittenRows: rows.copied, changedRows, filesBefore, filesAfter, partitionsScanned, partitionsTouched, target,
      };
      if (rows.copied >= thresholds.minCopiedRows && rows.copied >= thresholds.minCopiedToChangedRatio * changedRows) {
        out.push({
          ...base, rule: 'rewrittenRows', metric: 'rewrittenRows', value: rows.copied,
          recommendation: `Most rows the MERGE rewrote did not change: filter the MERGE source to the rows that changed (for example with a row-hash anti-join), repeat the target partition range in the MERGE condition so Delta can prune files, and check the target's file layout.`,
        });
      }
      if (filesBefore != null && filesAfter != null && partitionsScanned != null && partitionsTouched != null
        && filesBefore >= thresholds.minTargetFiles && filesAfter >= thresholds.minFilesKeptShare * filesBefore
        && partitionsScanned > 1 && partitionsTouched <= thresholds.maxTouchedPartitionShare * partitionsScanned) {
        out.push({
          ...base, rule: 'weakSkipping', metric: 'filesKept', value: filesAfter,
          recommendation: `The MERGE kept most target files after skipping although its changes touch few partitions: repeat the target partition range in the MERGE condition so Delta can prune files, and check the target's file layout.`,
        });
      }
    }, { dedupe: true });
    return out.length > 0 ? out : null;
  },
  estimate: noWasteModel,
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  mergeRewrite: { finding: MergeRewriteFinding; evidence: MergeRewriteEvidence };
}

export declare const emits: Emits;

export const detectors = [mergeRewriteDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  mergeRewrite: ['executionId', 'stageIds', 'rule', 'rewrittenRows', 'changedRows', 'filesBefore', 'filesAfter', 'partitionsScanned', 'partitionsTouched', 'target'],
} as const satisfies {
  mergeRewrite: readonly AllKeys<MergeRewriteEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  mergeRewrite: ['rule'],
} as const satisfies {
  mergeRewrite: readonly (DiscriminatorSlot & AllKeys<FindingOf<'mergeRewrite'>>)[];
};
