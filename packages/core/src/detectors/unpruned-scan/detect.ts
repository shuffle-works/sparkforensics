import { parseScanFilters } from '../../plan-summary.ts';
import { walkPlanTree } from '../../plan-tree-walk.ts';
import { noWasteModel } from '../../impact-model.ts';
import { metricValue } from '../../write-targets.ts';
import type { Finding, PlanNode, FindingOf } from '../../types.ts';
import { defineSqlDetector } from '../define.ts';
import { sqlStageIds, unionStageIds } from '../plan-attribution.ts';
import { FILES_READ_BYTES, relationIdOf } from '../plan-shape.ts';
import { GB } from '../units.ts';
import type { NumericFinding, PlanFindingEvidence, PlanNodeOrigin } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

/** A scan of a partitioned table that filters the rows it reads but has no partition filter, one finding per table in an
 * execution. `value` is the bytes all its flagged scans read. The plan does not name the partition columns, so the finding asks
 * for confirmation. */
export interface UnprunedScanEvidence extends PlanFindingEvidence {
  /** The most partitions one scan read: scans of one table read the same partitions. */
  partitionsRead: number;
  /** The scan's row filters, without the null checks Spark adds. */
  dataFilters: string[];
  /** The scanned table or path, as the Sources list names it; the full path when two tables in the execution share that name. */
  relation: string;
}

export interface UnprunedScanFinding extends NumericFinding<'unprunedScan'>, UnprunedScanEvidence, PlanNodeOrigin {}

export const unprunedScanDetector = defineSqlDetector({
  type: 'unprunedScan', order: 137, bandPolicy: 'own', fixEffort: 'code', version: 1,
  emits: ['unprunedScan'],
  docAnchor: '#table-formats',
  // A scan of a partitioned table (it reports "number of partitions read") that reads at least
  // minPartitionsRead partitions and minBytesRead bytes with no partition filter.
  thresholds: { minBytesRead: GB, minPartitionsRead: 2 },
  detect(sqlExec, ctx, thresholds): Finding[] | null {
    if (!sqlExec.planTree) return null;
    // One finding per table: a self-join's scans of one table share its id discriminators. The
    // relation is a path basename, so the full Location value keys the table.
    const byTable = new Map<string, { relation: string; path: string; nodes: PlanNode[]; bytesRead: number; partitionsRead: number; dataFilters: Set<string> }>();
    walkPlanTree(sqlExec.planTree, (node) => {
      const partitionsRead = metricValue(node, 'number of partitions read');
      const bytesRead = metricValue(node, FILES_READ_BYTES);
      const relation = relationIdOf(node);
      if (partitionsRead == null || bytesRead == null || relation === null) return;
      if (partitionsRead < thresholds.minPartitionsRead || bytesRead < thresholds.minBytesRead) return;
      const { partitionFilters, dataFilters } = parseScanFilters(node.detail ?? '');
      if (partitionFilters.length > 0 || dataFilters.length === 0) return;
      const location = node.detail?.match(/Location:\s*(.*?)(?=,\s*\w+:|$)/)?.[1] ?? '';
      const tableKey = `${relation}|${location}`;
      const path = location.match(/\[([^\],]+)/)?.[1].trim() ?? location;
      const group = byTable.get(tableKey) ?? { relation, path, nodes: [], bytesRead: 0, partitionsRead: 0, dataFilters: new Set<string>() };
      group.nodes.push(node);
      group.bytesRead += bytesRead;
      group.partitionsRead = Math.max(group.partitionsRead, partitionsRead);
      for (const f of dataFilters) group.dataFilters.add(f);
      byTable.set(tableKey, group);
    }, { dedupe: true });
    if (byTable.size === 0) return null;
    // Tables that share a basename are named by full path: relation is their id discriminator.
    const basenameCount = new Map<string, number>();
    for (const group of byTable.values()) basenameCount.set(group.relation, (basenameCount.get(group.relation) ?? 0) + 1);
    return [...byTable.values()].map((group): Finding => ({
      type: 'unprunedScan', executionId: sqlExec.id, stageIds: unionStageIds(group.nodes, sqlStageIds(ctx, sqlExec.id)),
      planNodeIds: group.nodes.flatMap((n) => (n.id ? [n.id] : [])), impactBand: 'info',
      metric: 'bytesRead', value: group.bytesRead, partitionsRead: group.partitionsRead, dataFilters: [...group.dataFilters],
      relation: basenameCount.get(group.relation)! > 1 ? group.path : group.relation.replace(/^[a-z]+:/, ''),
      confidence: 'low',
      validationRequired: 'The plan does not name the table\'s partition columns. Confirm which columns it is partitioned by: the scan filters other columns, so partition pruning did not apply.',
      recommendation: 'No partition filter reached the scan of this partitioned table: add a filter on a partition column, for example the date the table is partitioned by, so Spark can skip partitions.',
    }));
  },
  estimate: noWasteModel,
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  unprunedScan: { finding: UnprunedScanFinding; evidence: UnprunedScanEvidence };
}

export declare const emits: Emits;

export const detectors = [unprunedScanDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  unprunedScan: ['executionId', 'stageIds', 'relation', 'partitionsRead', 'dataFilters'],
} as const satisfies {
  unprunedScan: readonly AllKeys<UnprunedScanEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  unprunedScan: ['relation'],
} as const satisfies {
  unprunedScan: readonly (DiscriminatorSlot & AllKeys<FindingOf<'unprunedScan'>>)[];
};
