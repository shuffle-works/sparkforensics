import { pathBasename } from '../text-format.ts';
import { formatBytes, formatDuration } from '../units.ts';
import { parseScanFilters } from '../plan-summary.ts';
import { walkPlanTree } from '../plan-tree-walk.ts';
import { isBatchEvalPythonNode } from '../python-stage.ts';
import { appDurationMs } from '../impact-band.ts';
import {
  BROADCAST_BANDWIDTH_BPS, FILE_OPEN_OVERHEAD_MS, costOnly, multiStageImpact, noWasteModel, stageMappableWasteOrCostOnly,
} from '../impact-model.ts';
import { isBroadcastExchangeNode } from '../plan-node-detail.ts';
import { outputRowsOf, ownOutputRows, parseNestedLoopJoin } from '../nested-loop-join.ts';
import { joinKeyCastOf } from '../join-key-cast.ts';
import { commandOf, mergeRowsOf, metricValue } from '../write-targets.ts';
import { indexByRoot, resolveDeltaCommandTarget } from '../delta-targets.ts';
import { duplicateSubtreeDetail, duplicateSubtreeNote } from '../finding-generic-recommendation.ts';
import { codeFix, decreaseConf, increaseConf } from '../remediation.ts';
import { parseSparkBytes } from '../spark-conf.ts';
import type { Finding, ImpactEstimate, PlanNode, RawWasteFigure } from '../types.ts';
import type { Remediation, BroadcastThreshold } from '../finding-types.ts';
import { effectiveConf, loggedAs, queryApp } from './conf.ts';
import { duplicateSubtreeConfidence } from './confidence.ts';
import { defineSqlDetector } from './define.ts';
import { switchFix } from './fixes.ts';
import { sqlStageIds, unionStageIds } from './plan-attribution.ts';
import { broadcastCandidate, joinSideShuffle, shuffleBytes } from './plan-joins.ts';
import {
  FILES_READ_BYTES, FILES_READ_COUNT, FILES_WRITTEN_BYTES, FILES_WRITTEN_COUNT, findDuplicateSubtrees, normalizeDetail,
  relationIdOf,
} from './plan-shape.ts';
import type { DetectorApp } from './types.ts';
import { GB, MB } from './units.ts';

// Labels a byte threshold in binary units, so a 1 GiB default reads '1 GB'.
function binaryThresholdLabel(bytes: number): string {
  const [unit, size] = ([['GB', GB], ['MB', MB], ['KB', 1024]] as const).find(([, u]) => bytes >= u) ?? ['bytes', 1];
  return `${Math.round(bytes / size * 10) / 10} ${unit}`;
}

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

const PYTHON_UDF_ARROW_KEY = 'spark.sql.execution.pythonUDF.arrow.enabled';
// The executor-side metrics of the Python evaluator operators. Spark's PythonSQLMetrics trait adds
// them in 3.4.0, the release that also adds the Arrow-optimized UDF property, so an older log never
// reports them and the detector skips it.
const PYTHON_DATA_SENT = 'data sent to Python workers';
const PYTHON_DATA_RETURNED = 'data returned from Python workers';

// How to cut the cost of a row-at-a-time Python UDF: the Arrow-optimized UDF property while the
// session lacks it, else what is left once it is on (a UDF that opted out with useArrow=False, takes no
// arguments, or was created before the property was set: all of them still run as BatchEvalPython).
function pythonUdfArrowFix(app: DetectorApp | null): { text: string; remediation: Remediation[] } {
  return switchFix(
    loggedAs(app, PYTHON_UDF_ARROW_KEY, true), PYTHON_UDF_ARROW_KEY, true,
    `set ${PYTHON_UDF_ARROW_KEY}=true to ship rows in Arrow batches, or rewrite the UDF as a pandas UDF.`,
    `Arrow-optimized Python UDFs are already on for the session, so this UDF may have opted out with useArrow=False, take no arguments, or have been created before the property was set: check which, or rewrite it as a pandas UDF.`,
  );
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

export const pythonUdfDetector = defineSqlDetector({
  type: 'pythonUdf', order: 134, bandPolicy: 'own', fixEffort: 'code', version: 1,
  emits: ['pythonUdf'],
  docAnchor: '#pyspark',
  // Unvalidated against a real workload (no corpus or private log runs a Python UDF): set high so
  // only a stage that moved a lot of data for a long time is flagged.
  thresholds: { minBytesSent: 64 * MB, minStageMs: 30_000 },
  detect(sqlExec, ctx, thresholds): Finding[] | null {
    if (!sqlExec.planTree) return null;
    const { minBytesSent, minStageMs } = thresholds;
    // BatchEvalPython runs a row-at-a-time UDF; ArrowEvalPython (an Arrow-optimized or pandas UDF)
    // is already the fix. Both Python byte metrics are executor-side; a plan that reports no sent
    // bytes is skipped.
    const nodes: PlanNode[] = [];
    let sentBytes = 0;
    let returnedBytes = 0;
    let reportsReturned = false;
    walkPlanTree(sqlExec.planTree, (node) => {
      if (!isBatchEvalPythonNode(node)) return;
      const sent = node.metrics?.find((m) => m.name === PYTHON_DATA_SENT)?.value;
      if (sent == null || !(node.stageIds?.length)) return;
      nodes.push(node);
      sentBytes += sent;
      const returned = node.metrics?.find((m) => m.name === PYTHON_DATA_RETURNED)?.value;
      if (returned != null) { returnedBytes += returned; reportsReturned = true; }
    });
    if (nodes.length === 0 || !(sentBytes >= minBytesSent)) return null;
    const stageIds = unionStageIds(nodes, []);
    const stageDurationMs = stageIds.reduce((sum, id) => {
      const stage = ctx.stages.get(id);
      return sum + Math.max(0, (stage?.completedAt ?? 0) - (stage?.submittedAt ?? 0));
    }, 0);
    if (!(stageDurationMs >= minStageMs)) return null;

    const arrowFix = pythonUdfArrowFix(queryApp(ctx.app, sqlExec.modifiedConfigs));
    const traffic = `sent ${formatBytes(sentBytes)} to Python workers${reportsReturned ? ` and received ${formatBytes(returnedBytes)} back` : ''}`;
    return [{
      type: 'pythonUdf', executionId: sqlExec.id, stageIds, planNodeIds: nodes.flatMap(n => (n.id ? [n.id] : [])),
      impactBand: 'info',
      metric: 'dataSentBytes', value: sentBytes,
      dataSentBytes: sentBytes, dataReturnedBytes: reportsReturned ? returnedBytes : null, stageDurationMs,
      recommendation: `Row-at-a-time Python UDFs (BatchEvalPython) ${traffic} over ${formatDuration(stageDurationMs)} of stage time: ${arrowFix.text}`,
      remediation: arrowFix.remediation,
    }];
  },
  estimate: noWasteModel,
});

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
