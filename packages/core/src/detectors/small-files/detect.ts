import { pathBasename } from '../../text-format.ts';
import { walkPlanTree } from '../../plan-tree-walk.ts';
import { FILE_OPEN_OVERHEAD_MS, stageMappableWasteOrCostOnly } from '../../impact-model.ts';
import type { Finding, ImpactEstimate, PlanNode, FindingOf } from '../../types.ts';
import { defineSqlDetector } from '../define.ts';
import { sqlStageIds, unionStageIds } from '../plan-attribution.ts';
import { FILES_READ_BYTES, FILES_READ_COUNT, FILES_WRITTEN_BYTES, FILES_WRITTEN_COUNT } from '../plan-shape.ts';
import { MB } from '../units.ts';
import type { NumericFinding, PlanFindingEvidence, PlanNodeOrigin } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface SmallFilesEvidence extends PlanFindingEvidence {
  fileCount: number;
  direction: 'read' | 'write';
  nodeName: string;
}

export interface SmallFilesFinding extends NumericFinding<'smallFiles'>, SmallFilesEvidence, PlanNodeOrigin {}

export const smallFilesDetector = defineSqlDetector({
  type: 'smallFiles', order: 131, bandPolicy: 'derived', fixEffort: 'config', version: 2,
  emits: ['smallFiles'],
  docAnchor: '#bottleneck-small-files',
  thresholds: { minFiles: 100, maxAvgFileSizeMB: 3 },
  detect(sqlExec, ctx, thresholds): Finding[] | null {
    if (!sqlExec.planTree) return null;
    const { minFiles, maxAvgFileSizeMB } = thresholds;
    interface SmallFilesHit { direction: 'read' | 'write'; fileCount: number; avgBytes: number; nodeName: string; node: PlanNode; }
    const hits: SmallFilesHit[] = [];
    walkPlanTree(sqlExec.planTree, (node) => {
      const metrics = node.metrics ?? [];
      const byName = (name: string) => metrics.find(m => m.name === name);
      const checkSide = (
        countMetric: { name: string; value: number } | undefined,
        bytesMetric: { name: string; value: number } | undefined,
        direction: 'read' | 'write',
      ) => {
        if (!countMetric || !bytesMetric || !(countMetric.value > minFiles)) return;
        const avgBytes = bytesMetric.value / countMetric.value;
        if (!(avgBytes < maxAvgFileSizeMB * MB)) return;
        hits.push({ direction, fileCount: countMetric.value, avgBytes, nodeName: node.name, node });
      };
      checkSide(byName(FILES_READ_COUNT), byName(FILES_READ_BYTES), 'read');
      checkSide(byName(FILES_WRITTEN_COUNT), byName(FILES_WRITTEN_BYTES), 'write');
    });
    if (hits.length === 0) return null;
    const fallbackStageIds = sqlStageIds(ctx, sqlExec.id);
    return hits.map(h => {
      const stageIds = unionStageIds([h.node], fallbackStageIds);
      const planNodeIds = h.node.id ? [h.node.id] : [];
      return {
        type: 'smallFiles', executionId: sqlExec.id, stageIds, planNodeIds,
        impactBand: 'warning',
        metric: 'avgFileSizeBytes', value: Math.round(h.avgBytes),
        fileCount: h.fileCount, direction: h.direction, nodeName: h.nodeName,
        recommendation: h.direction === 'read'
          ? `${h.fileCount} small files were read at ${pathBasename(h.nodeName)}: consider compacting the upstream output so fewer, larger files are produced.`
          : `${h.fileCount} small files were written at ${pathBasename(h.nodeName)}: repartition or coalesce before writing to raise the average file size.`,
      };
    });
  },
  estimate(finding, ctx): ImpactEstimate | null {
    const fileMs = ((finding.fileCount as number | undefined) ?? 0) * FILE_OPEN_OVERHEAD_MS;
    // A read's files are opened by the scan's tasks, in parallel: spread the per-file cost over
    // the most tasks its stages ran at once. A write keeps the serial sum: the job commit moves each
    // output file on the driver, one after another.
    const stageIds = finding.stageIds as number[] | undefined;
    let slots = 1;
    if (finding.direction === 'read') {
      for (const id of stageIds ?? []) slots = Math.max(slots, ctx.stages.get(id)?.peakConcurrentTasks ?? 1);
    }
    return stageMappableWasteOrCostOnly(fileMs / slots, stageIds, ctx);
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  smallFiles: { finding: SmallFilesFinding; evidence: SmallFilesEvidence };
}

export declare const emits: Emits;

export const detectors = [smallFilesDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  smallFiles: ['executionId', 'stageIds', 'fileCount', 'direction', 'nodeName'],
} as const satisfies {
  smallFiles: readonly AllKeys<SmallFilesEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  smallFiles: ['direction', 'nodeName'],
} as const satisfies {
  smallFiles: readonly (DiscriminatorSlot & AllKeys<FindingOf<'smallFiles'>>)[];
};
