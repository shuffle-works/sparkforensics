import { DETECTORS, type Detector, type DetectorCtx, type DetectorConfigTarget, type ThresholdOverrides } from './detectors.ts';
import { overridesFor, tunedEstimateNote, tunedThresholdsOf } from './threshold-overrides.ts';
import { computePeakConcurrentCores } from './core-count.ts';
import { assertNever } from './assert-never.ts';
import { estimateImpact } from './impact-estimator.ts';
import { computeOccupancy, type OccupancyStage } from './occupancy.ts';
import { deriveImpactBand } from './impact-band.ts';
import { IMPACT_BAND_ORDER } from './format-utils.ts';
import type {
  Finding, FindingOf, FindingType, SparkAppInfo, Stage, ExecutorEvent, Job, SqlExecution, RunAggregates, TunedThresholds,
} from './types.ts';

// The runner reads each entry through the Detector contract, not its own precise `as const` shape:
// the scope switch below calls each entry's bound detect with that scope's target.
const detectors: readonly Detector[] = DETECTORS;

export interface AnalyzeOptions {
  /** Per-detector overrides merged over each entry's own thresholds (validate user input with
   * parseThresholdOverrides first). Findings from an entry an override moves off its defaults
   * carry `tunedThresholds` and an uncalibrated-estimate caveat. Omitted: the specification. */
  thresholds?: ThresholdOverrides;
}

// FNV-1a 32-bit stable string hash: deterministic finding id across runs, no timestamps/randomness.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// The id hash's discriminator slots, in the order it has always joined them: reordering or renaming
// one changes every finding id, which needs an EVIDENCE_SCHEMA_VERSION bump.
const DISCRIMINATOR_SLOTS = [
  'host', 'executorId', 'rule', 'variant', 'dimension',
  'direction', 'nodeName', 'rootName', 'subtreeSize', 'groupIndex', 'largerSideBytes',
  'rddId', 'relation', 'format', 'operator', 'executionIds',
] as const;
type DiscriminatorSlot = (typeof DISCRIMINATOR_SLOTS)[number];

// Per type, the fields that tell apart sibling findings sharing one location and metric; without
// them those siblings hash to one id:
//   slowHost (host), memoryUtilization (executorId), partitionSizing (rule);
//   cacheUtilization (rddId+variant), cachingOpportunity (relation/format for leaf,
//     operator+relation for composite, executionIds as last resort);
//   smallFiles (direction/nodeName), duplicatePlanSubtree (groupIndex is the real
//     uniqueness guarantee: rootName+subtreeSize can collide across groups),
//     underBroadcast (value+largerSideBytes per node/side).
// memoryUtilization leaves out `rule`: one heap band per executor, so executorId is already
// unique and folding rule in risks id churn if band logic changes. partitionSizing keeps
// `rule`: a stage can emit several rules at once sharing stageId+metric.
const ID_DISCRIMINATORS: { [T in FindingType]: readonly (DiscriminatorSlot & keyof FindingOf<T>)[] } = {
  skew: [], stageShape: ['rule'], shuffle: [], partitionSizing: ['rule'], spill: [], gc: ['direction'],
  slowHost: ['host', 'executorId', 'variant', 'dimension'], stageSlowness: [], stageFailed: ['variant'],
  failures: [], straggler: [], speculationWaste: [], retryWaste: [], tinyTask: [],
  incompleteRun: [], coldStart: [], utilization: [], memoryUtilization: ['executorId', 'variant'],
  cacheUtilization: ['variant', 'rddId'], coreLocality: [], autoscalingChurn: [],
  cachingOpportunity: ['variant', 'relation', 'format', 'operator', 'executionIds'],
  jobFailureRate: [], configAudit: [],
  duplicatePlanSubtree: ['rootName', 'subtreeSize', 'groupIndex'], smallFiles: ['direction', 'nodeName'],
  underBroadcast: ['largerSideBytes'], overBroadcast: [],
};

// Location key: stage, else SQL execution, else audited config property.
function locationKey(f: Finding): number | string {
  if (f.stageId != null) return f.stageId;
  if ('executionId' in f) return f.executionId;
  if (f.type === 'configAudit') return f.property;
  return '';
}

export function findingId(f: Finding): string {
  const fields = f as unknown as Partial<Record<DiscriminatorSlot, unknown>>;
  const listed = new Set<DiscriminatorSlot>(ID_DISCRIMINATORS[f.type]);
  const disc = DISCRIMINATOR_SLOTS.map((slot) => {
    const v = listed.has(slot) ? fields[slot] : undefined;
    return Array.isArray(v) ? v.join(',') : v ?? '';
  }).join('|');
  return fnv1a(`${f.type}|${locationKey(f)}|${f.metric ?? ''}|${f.value ?? f.valueText ?? ''}|${disc}`);
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

function push(out: Finding[], entry: Detector, result: Finding | Finding[] | null, tuned: TunedThresholds | null = null): void {
  if (!result) return;
  const detectorVersion = entry.version ?? 1;
  for (const f of (Array.isArray(result) ? result : [result])) {
    if (!f) continue;
    const stamped = { ...f, docAnchor: f.docAnchor ?? entry.docAnchor, detectorVersion };
    if (tuned) {
      stamped.tunedThresholds = tuned;
      const note = tunedEstimateNote(tuned);
      stamped.validationRequired = stamped.validationRequired ? `${stamped.validationRequired} ${note}` : note;
    }
    const id = findingId(stamped);
    // Dedup guard: same id => same finding, keep first. Correctness depends on
    // findingId's discriminators being unique per distinct finding, not on this line.
    if (out.some((existing) => existing.id === id)) continue;
    out.push({ ...stamped, id });
  }
}

// An entry's `suppressedBy` names another entry: drop its findings on every stage that entry
// flagged. Runs once every detector has, so neither declaration order matters, and reads the
// unsuppressed findings, so the result doesn't depend on which suppression is applied first.
function applySuppression(out: Finding[]): Finding[] {
  const dropped = new Map<string, Set<number>>();
  for (const entry of detectors) {
    if (!entry.suppressedBy) continue;
    const suppressorTypes = new Set<string>(
      detectors.filter((d) => d.type === entry.suppressedBy).flatMap((d) => d.emits),
    );
    for (const type of entry.emits) {
      const stagesToDrop = dropped.get(type) ?? new Set<number>();
      for (const f of out) if (suppressorTypes.has(f.type) && f.stageId != null) stagesToDrop.add(f.stageId);
      dropped.set(type, stagesToDrop);
    }
  }
  if (dropped.size === 0) return out;
  return out.filter((f) => f.stageId == null || !dropped.get(f.type)?.has(f.stageId));
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
  { thresholds }: AnalyzeOptions = {},
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
  // The one cast from the posted-model types to the detector-side shapes: types.ts's Stage and
  // SqlExecution carry a catch-all index signature, while every field DetectorStage/DetectorSqlExec
  // declare is one finalizeStage and event-handlers.ts always set (see detectors.ts's header).
  const ctx: DetectorCtx = {
    app, jobs, executorsAdded, executorsRemoved, runAggregates, occupancy,
    stages: stages as unknown as DetectorCtx['stages'],
    sql: sql as unknown as DetectorCtx['sql'],
  };
  const out: Finding[] = [];
  for (const d of detectors) {
    if (d.inScorecard === false) continue;
    const overrides = overridesFor(d, thresholds);
    const tuned = tunedThresholdsOf(d, thresholds);
    switch (d.scope) {
      case 'stage': {
        const detect = d.withThresholds(overrides);
        for (const s of ctx.stages.values()) push(out, d, detect(s, ctx), tuned);
        break;
      }
      case 'sql': {
        const detect = d.withThresholds(overrides);
        for (const e of ctx.sql.values()) push(out, d, detect(e, ctx), tuned);
        break;
      }
      case 'app':
        push(out, d, d.withThresholds(overrides)(ctx), tuned);
        break;
      case 'config':
        push(out, d, d.withThresholds(overrides)(ctx satisfies DetectorConfigTarget), tuned);
        break;
      default:
        assertNever(d);
    }
  }
  const findings = applySuppression(out);
  estimateImpact(findings, stages, totalCores);
  deriveImpactBand(findings, app);
  flagSkewStragglerOverlap(findings);
  // Ascending IMPACT_BAND_ORDER (critical 0 -> info 2) puts the worst band first;
  // stable sort keeps DETECTORS declaration order within a band.
  findings.sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]);
  return findings;
}

// Memoizes auditConfig by `app` identity (like evidence-report.ts's jsonCache) so config detectors
// don't re-run when both the export and the report path audit the same app. WeakMap can't key on
// `null`, so that case skips the cache. Returns a fresh copy each call so a caller's in-place
// mutation (e.g. `.sort()`) can't corrupt the cached array.
const auditConfigCache = new WeakMap<SparkAppInfo, Finding[]>();

function computeAuditConfig(app: SparkAppInfo | null): Finding[] {
  const out: Finding[] = [];
  for (const d of detectors) if (d.scope === 'config') push(out, d, d.withThresholds()({ app }));
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
