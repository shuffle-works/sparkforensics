import { DETECTORS, type Detector } from './detectors.ts';
import { computePeakConcurrentCores } from './core-count.ts';
import { assertNever } from './assert-never.ts';
import { estimateImpact } from './impact-estimator.ts';
import { computeOccupancy, type OccupancyStage } from './occupancy.ts';
import { deriveImpactBand } from './impact-band.ts';
import { IMPACT_BAND_ORDER } from './format-utils.ts';
import type {
  Finding, SparkAppInfo, Stage, ExecutorEvent, Job, SqlExecution, RunAggregates,
} from './types.ts';

// FNV-1a 32-bit stable string hash: deterministic finding id across runs, no timestamps/randomness.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function findingId(f: Finding): string {
  // Location key: stage, else SQL execution, else audited config property.
  const locKey = f.stageId ?? f.executionId ?? f.property ?? '';
  // Discriminators for detectors that emit multiple findings on the same
  // location+metric; without them these siblings hash to one id:
  //   slowHost (host), memoryUtilization (executorId+dimension), partitionSizing (rule);
  //   cacheUtilization (rddId+variant), cachingOpportunity (relation/format for leaf,
  //     operator+relation for composite, executionIds as last resort);
  //   smallFiles (direction/nodeName), duplicatePlanSubtree (groupIndex is the real
  //     uniqueness guarantee: rootName+subtreeSize can collide across groups),
  //     broadcastSizing (value+largerSideBytes per node/side).
  // memoryUtilization excludes `rule`: one heap band per executor, so executorId is already
  // unique and folding rule in risks id churn if band logic changes. partitionSizing keeps
  // `rule`: a stage can emit several rules at once sharing stageId+metric.
  const rule = f.type === 'memoryUtilization' ? undefined : f.rule;
  const disc = [
    f.host, f.executorId, rule, f.variant, f.dimension,
    f.direction, f.nodeName, f.rootName, f.subtreeSize, f.groupIndex, f.largerSideBytes,
    f.rddId, f.relation, f.format, f.operator,
    f.executionIds ? f.executionIds.join(',') : '',
  ].map((v) => v ?? '').join('|');
  return fnv1a(`${f.type}|${locKey}|${f.metric ?? ''}|${f.value ?? ''}|${disc}`);
}

// skew's max/median branch (stage.taskCount below minTasksForP95) and straggler are both driven
// by the identical (taskDurationMax - taskDurationP50) delta on the same stage: the same
// dominant outlier task reported by two detectors, each independently clipped (see "Overlap
// caveat: skew / straggler" in impact-estimation.md). skew's P95/median branch samples a
// different task and stays independent. Flags both sides via validationRequired (rather than
// suppressing either) so neither finding's own diagnostic value is lost; the flag rides the same
// confidence-caveat UI a reader already sees before trusting either finding's magnitude.
function overlapNote(otherType: 'skew' | 'straggler'): string {
  return `This overlaps with the ${otherType} finding on this stage: both are driven by the same dominant outlier task, so don't add their recoverable-time figures together.`;
}

function flagSkewStragglerOverlap(findings: Finding[]): void {
  const maxMedianSkewStages = new Set(
    findings.filter((f) => f.type === 'skew' && f.metric === 'max/median' && f.stageId != null).map((f) => f.stageId),
  );
  if (maxMedianSkewStages.size === 0) return;
  const stragglerStages = new Set(
    findings.filter((f) => f.type === 'straggler' && f.stageId != null).map((f) => f.stageId),
  );
  const overlapStages = new Set([...maxMedianSkewStages].filter((id) => stragglerStages.has(id)));
  if (overlapStages.size === 0) return;
  for (const f of findings) {
    if (f.stageId == null || !overlapStages.has(f.stageId)) continue;
    const note = f.type === 'skew' ? overlapNote('straggler') : f.type === 'straggler' ? overlapNote('skew') : null;
    if (!note) continue;
    f.validationRequired = f.validationRequired ? `${f.validationRequired} ${note}` : note;
  }
}

function push(out: Finding[], entry: Detector, result: Finding | Finding[] | null): void {
  if (!result) return;
  const detectorVersion = entry.version ?? 1;
  for (const f of (Array.isArray(result) ? result : [result])) {
    if (!f) continue;
    if (entry.suppressWhen && entry.suppressWhen(f, out)) continue;
    const stamped = { ...f, docAnchor: f.docAnchor ?? entry.docAnchor, detectorVersion };
    const id = findingId(stamped);
    // Dedup guard: same id => same finding, keep first. Correctness depends on
    // findingId's discriminators being unique per distinct finding, not on this line.
    if (out.some((existing) => existing.id === id)) continue;
    out.push({ ...stamped, id });
  }
}

// `app` widened to `SparkAppInfo | null` to match real callers (AppModel.app is
// nullable at the type level); every detector below tolerates a null app.
export function analyze(
  app: SparkAppInfo | null,
  stages: Map<number, Stage>,
  executorsAdded: ExecutorEvent[],
  executorsRemoved: ExecutorEvent[],
  jobs: Map<number, Job>,
  sql: Map<number, SqlExecution> = new Map(),
  runAggregates: RunAggregates | null = null,
): Finding[] {
  // `app ?? {}`: detectors tolerate a null app (malformed logs), so this must too.
  // computePeakConcurrentCores (not computeTotalCores): the occupancy ceiling needs a
  // concurrent-capacity bound; a cumulative sum overstates it under dynamic allocation.
  // Casts: the function reads only executorId/timestamp/totalCores, but totalCores isn't
  // on ExecutorRemovedEvent, so the ExecutorEvent union mismatches its parameter shapes.
  const totalCores = computePeakConcurrentCores(
    app ?? {},
    executorsAdded as Array<{ executorId: string; timestamp: number; totalCores?: number }>,
    executorsRemoved as Array<{ executorId: string; timestamp: number }>,
  );
  // Computed once so detectors gate impact band on the same occupancy-clipped waste
  // estimateImpact displays as savings, not a raw pre-clip delta the two passes would disagree on.
  const occupancy = computeOccupancy(stages as unknown as Map<number, OccupancyStage>, totalCores);
  const ctx = {
    app, stages, executorsAdded, executorsRemoved, jobs, sql, runAggregates, occupancy,
  };
  const out: Finding[] = [];
  for (const d of DETECTORS) {
    if (d.inScorecard === false) continue;
    switch (d.scope) {
      case 'stage':
        for (const s of stages.values()) push(out, d, d.detect(s, ctx));
        break;
      case 'sql':
        for (const e of sql.values()) push(out, d, d.detect(e, ctx));
        break;
      case 'app':
      case 'config':
        push(out, d, d.detect(ctx));
        break;
      default:
        assertNever(d.scope);
    }
  }
  estimateImpact(out, stages, totalCores);
  deriveImpactBand(out, app);
  flagSkewStragglerOverlap(out);
  // Ascending IMPACT_BAND_ORDER (critical 0 -> info 2) puts the worst band first;
  // stable sort keeps DETECTORS declaration order within a band.
  out.sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]);
  return out;
}

// Memoizes auditConfig by `app` identity (like evidence-report.ts's jsonCache) so config detectors
// don't re-run when both the export and the report path audit the same app. WeakMap can't key on
// `null`, so that case skips the cache. Returns a fresh copy each call so a caller's in-place
// mutation (e.g. `.sort()`) can't corrupt the cached array.
const auditConfigCache = new WeakMap<SparkAppInfo, Finding[]>();

function computeAuditConfig(app: SparkAppInfo | null): Finding[] {
  const out: Finding[] = [];
  for (const d of DETECTORS) if (d.scope === 'config') push(out, d, d.detect({ app }));
  // configAudit's impact case is unconditionally costOnly('none'): needs no stages/totalCores,
  // an empty stages map gives parity with analyze().
  estimateImpact(out, new Map());
  deriveImpactBand(out, app);
  return out.map((f) => ({ ...f, stageId: f.stageId ?? null }));
}

export function auditConfig(app: SparkAppInfo | null): Finding[] {
  if (app === null) return computeAuditConfig(app);
  const cached = auditConfigCache.get(app);
  if (cached) return cached.slice();
  const result = computeAuditConfig(app);
  auditConfigCache.set(app, result);
  return result.slice();
}
