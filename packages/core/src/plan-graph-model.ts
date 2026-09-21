// Flattens a resolved planTree into a { nodes, edges } graph shape for the
// React Flow + Dagre plan graph view ("Plan graph view" in
// docs-site/contributor-guide/architecture/drill-down.md). The Exchange
// write/read split is done upstream now, in resolvePlanTree
// (event-handlers.ts): this file just walks the already-split tree and maps
// each real PlanNode onto a PlanGraphNodeData. sourceNodeId still lets a
// write half point back to its read half's id, so aggregate logic over
// nodes can group a pair without special-casing exchangeRole everywhere.
import { walkPlanTree } from './plan-tree-walk.ts';
import {
  classifyNode,
  buildDurationMap,
  parseOperatorDetail,
  getPrimaryMetric,
  formatPlanMetricValue,
} from './plan-node-detail.ts';
import { computeSegments, mapSegmentsToStagesForDisplay } from './plan-duration-attribution.ts';
import { stageIdsForSqlExec } from './detectors.ts';
import type {
  AppModel, Finding, PlanGraphDurationMode, PlanGraphEdge, PlanGraphModel, PlanGraphNodeData, PlanNode,
} from './types.ts';

function makeGraphNode({
  id,
  sourceNodeId,
  planNode,
  category,
  segmentIndex,
  splitRole,
  durationShare,
  exclusiveDurationShare,
  findings,
}: {
  id: string;
  sourceNodeId: string;
  planNode: PlanNode;
  category: string;
  segmentIndex: number;
  splitRole: 'read' | 'write' | null;
  durationShare?: number | null;
  exclusiveDurationShare?: number | null;
  findings: Finding[];
}): PlanGraphNodeData {
  return {
    id,
    sourceNodeId,
    label: planNode.name,
    category,
    operatorDetail: parseOperatorDetail(planNode.name, planNode.detail ?? ''),
    primaryMetric: getPrimaryMetric(planNode.metrics),
    segmentIndex,
    splitRole,
    durationShare: durationShare ?? null,
    exclusiveDurationShare: exclusiveDurationShare ?? null,
    findings,
    metrics: (planNode.metrics ?? []).map((m) => ({ name: m.name, value: formatPlanMetricValue(m) })),
    // Drop a detail that only repeats the operator name (no extra information
    // for the card); parseOperatorDetail already treats that case as empty.
    detailText: planNode.detail && planNode.detail !== planNode.name ? planNode.detail : '',
  };
}

export function buildPlanGraphModel(
  planTree: PlanNode | null,
  opts: {
    scope: 'segment' | 'full';
    stageId: number;
    appModel: AppModel;
    findings?: Finding[];
    durationMode?: PlanGraphDurationMode;
  },
): PlanGraphModel {
  const { scope, stageId, appModel, findings = [], durationMode = 'exclusive' } = opts;
  if (!planTree) return { nodes: [], edges: [], segmentIndex: null, segmentCount: 0, scope: 'full', segmentStageIds: new Map<number, number>() };

  const stage = appModel.stages.get(stageId);
  const sqlExecutionId = stage?.sqlExecutionId ?? null;
  const sqlExec = sqlExecutionId != null ? appModel.sql.get(sqlExecutionId) : null;

  const { segments, segOf, segmentTopology } = computeSegments(planTree);
  const segmentCount = segments.filter(Boolean).length;

  const durationMap =
    sqlExec && sqlExecutionId != null ? buildDurationMap(planTree, appModel, sqlExec, sqlExecutionId, durationMode) : null;
  // A second, always-exclusive map, independent of the requested `durationMode`.
  // Exclusive shares are a true, non-overlapping partition of each paired
  // stage's wall time (computeExclusiveSharesForPairs), so their sum is a
  // stable normalization total. PlanGraphCanvas needs this alongside
  // `durationMap` (the mode-selected values actually shown) because summing
  // `durationMap` itself would double/triple-count under 'inclusive' mode,
  // where an ancestor's share already folds in every descendant's share.
  // durationMode === 'exclusive' already computed the same map above; only
  // redo the work when the requested mode actually differs.
  const exclusiveDurationMap =
    durationMode === 'exclusive'
      ? durationMap
      : sqlExec && sqlExecutionId != null ? buildDurationMap(planTree, appModel, sqlExec, sqlExecutionId, 'exclusive') : null;

  const segmentStageIds = new Map<number, number>();
  const linkedStageIds: number[] =
    sqlExec && sqlExecutionId != null ? stageIdsForSqlExec(sqlExecutionId, appModel.stages) : [];
  if (linkedStageIds.length) {
    const stagesById = new Map<number, { submittedAt?: number; completedAt?: number }>();
    for (const id of linkedStageIds) {
      const s = appModel.stages.get(id);
      if (s) stagesById.set(id, { submittedAt: s.submittedAt, completedAt: s.completedAt });
    }
    for (const [segIdx, sId] of mapSegmentsToStagesForDisplay(segments, stagesById, linkedStageIds, segmentTopology)) {
      segmentStageIds.set(segIdx, sId);
    }
  }

  // resolvePlanTree (event-handlers.ts) now prefixes every id with its owning
  // execution, but this filter stays as defense in depth: a finding is scoped
  // to the execution whose graph is being built before it's indexed by node
  // id, so a stale/synthetic finding whose planNodeIds happen to collide with
  // this tree's ids (e.g. hand-built test fixtures, or data from before the
  // prefix existed) still can't badge onto the wrong tree. No linked SQL
  // execution means no findings attach, matching the sqlExec-falsy behavior
  // used elsewhere in this function (durationMap, linkedStageIds).
  const findingsByNodeId = new Map<string, Finding[]>();
  if (sqlExecutionId != null) {
    for (const finding of findings) {
      if (finding.executionId !== sqlExecutionId) continue;
      for (const nodeId of finding.planNodeIds ?? []) {
        const list = findingsByNodeId.get(nodeId);
        if (list) list.push(finding);
        else findingsByNodeId.set(nodeId, [finding]);
      }
    }
  }

  const allNodes: PlanGraphNodeData[] = [];
  const allEdges: PlanGraphEdge[] = [];

  // Both halves of one split Exchange share a sourceNodeId (the read half's id:
  // the read half points at itself, the write half at its read parent). Collect
  // them under that key during the walk so the post-pass below can cross-link
  // the pair and mirror the shuffle-boundary bytes onto both halves, even
  // though only one half is visible from any single-segment view.
  const splitPairs = new Map<string, { read?: PlanGraphNodeData; write?: PlanGraphNodeData; shuffleBytes?: number }>();

  walkPlanTree(planTree, (node, parent) => {
    // resolvePlanTree always sets id; safe downstream of it.
    const id = node.id!;
    const category = classifyNode(node.name);
    const seg = segOf.get(node)!;
    const parentId = parent ? parent.id! : null;
    const sourceNodeId = node.exchangeRole === 'write' && parent ? parent.id! : id;

    const graphNode = makeGraphNode({
      id,
      sourceNodeId,
      planNode: node,
      category,
      segmentIndex: seg,
      splitRole: node.exchangeRole ?? null,
      durationShare: durationMap?.get(node),
      exclusiveDurationShare: exclusiveDurationMap?.get(node),
      findings: findingsByNodeId.get(id) ?? [],
    });
    allNodes.push(graphNode);
    if (node.exchangeRole) {
      const entry = splitPairs.get(sourceNodeId) ?? {};
      entry[node.exchangeRole] = graphNode;
      splitPairs.set(sourceNodeId, entry);
    }
    if (parentId) {
      const edge: PlanGraphEdge = { id: `${parentId}->${id}`, source: parentId, target: id };
      // The read->write pairing edge is the shuffle boundary: weight it by the
      // bytes written across it. The write half lives in the producer segment,
      // and its stage's shuffleWriteBytes is exactly the data materialized to
      // this shuffle, falling back to shuffleReadBytes when the write side
      // wasn't captured. Zero/absent on both means no weight, so a broadcast
      // (which moves little by design) or an empty exchange stays a plain edge.
      if (node.exchangeRole === 'write') {
        const producingStageId = segmentStageIds.get(seg);
        const producingStage = producingStageId != null ? appModel.stages.get(producingStageId) : undefined;
        const shuffleBytes = producingStage?.shuffleWriteBytes || producingStage?.shuffleReadBytes;
        if (shuffleBytes) {
          edge.shuffleBytes = shuffleBytes;
          const entry = splitPairs.get(sourceNodeId) ?? {};
          entry.shuffleBytes = shuffleBytes;
          splitPairs.set(sourceNodeId, entry);
        }
      }
      allEdges.push(edge);
    }
  }, { dedupe: true });

  // Cross-link each Exchange pair and mirror the shuffle-boundary bytes onto
  // both halves, so the detail card can reach the partner and show the volume
  // whichever half is open. Runs over the full node set before any scope
  // filtering, so pairedNodeId stays set even when the partner is scoped out.
  for (const { read, write, shuffleBytes } of splitPairs.values()) {
    if (read && write) {
      read.pairedNodeId = write.id;
      write.pairedNodeId = read.id;
    }
    if (shuffleBytes != null) {
      if (read) read.exchangeShuffleBytes = shuffleBytes;
      if (write) write.exchangeShuffleBytes = shuffleBytes;
    }
  }

  if (scope === 'full') {
    return { nodes: allNodes, edges: allEdges, segmentIndex: null, segmentCount, scope: 'full', segmentStageIds };
  }

  let targetSegmentIndex: number | null = null;
  for (const [segIdx, sId] of segmentStageIds) {
    if (sId === stageId) { targetSegmentIndex = segIdx; break; }
  }

  if (targetSegmentIndex === null) {
    return { nodes: allNodes, edges: allEdges, segmentIndex: null, segmentCount, scope: 'full', segmentStageIds };
  }

  const nodeIds = new Set<string>();
  const nodes = allNodes.filter((n) => {
    if (n.segmentIndex !== targetSegmentIndex) return false;
    nodeIds.add(n.id);
    return true;
  });
  const edges = allEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  return { nodes, edges, segmentIndex: targetSegmentIndex, segmentCount, scope: 'segment', segmentStageIds };
}
