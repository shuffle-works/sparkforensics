import { DETECTORS, ENTRY_BY_TYPE, type Detector, type DetectorCtx, type DetectorConfigTarget, type ThresholdOverrides } from './detectors.ts';
import { effectiveThresholds, findingTunedThresholds, overridesFor, tunedThresholdsNote } from './threshold-overrides.ts';
import { computePeakConcurrentCores } from './core-count.ts';
import { assertNever } from './assert-never.ts';
import { estimateImpact, type EstimateCtx } from './impact-estimator.ts';
import { computeOccupancy, type OccupancyStage } from './occupancy.ts';
import { deriveImpactBand, IMPACT_FLOOR_PCT_CRIT, IMPACT_FLOOR_PCT_WARN, type ImpactBandFloors } from './impact-band.ts';
import { IMPACT_BAND_ORDER } from './format-utils.ts';
import type {
  Finding, FindingOf, FindingType, SparkAppInfo, Stage, ExecutorEvent, Job, SqlExecution, RunAggregates, TunedThresholds,
} from './types.ts';

// The runner reads each entry through the Detector contract, not its own precise `as const` shape:
// the scope switch below calls each entry's bound detect with that scope's target.
const detectors: readonly Detector[] = DETECTORS;

export interface AnalyzeOptions {
  /** Per-detector overrides merged over each entry's own thresholds (validate user input with
   * parseThresholdOverrides first). Findings from an entry an override moves off its defaults, or
   * whose `suppressedBy` entry it moves, carry `tunedThresholds` (with an uncalibrated-estimate
   * caveat when they have an estimate figure), and an entry's tuned floorPctWarn/floorPctCrit
   * grade its findings' impact band. Omitted: the specification. */
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
// memoryUtilization leaves out `rule`: the run has one heap band (on its busiest executor), so
// executorId is already unique and folding rule in risks id churn if band logic changes. partitionSizing keeps
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

// ID_DISCRIMINATORS as Sets, built once: findingId runs once per finding.
const ID_DISCRIMINATOR_SETS = new Map<string, ReadonlySet<DiscriminatorSlot>>(
  Object.entries(ID_DISCRIMINATORS).map(([type, slots]) => [type, new Set<DiscriminatorSlot>(slots)]),
);

// Location key: stage, else SQL execution, else audited config property.
function locationKey(f: Finding): number | string {
  if (f.stageId != null) return f.stageId;
  if ('executionId' in f) return f.executionId;
  if (f.type === 'configAudit') return f.property;
  return '';
}

export function findingId(f: Finding): string {
  const fields = f as unknown as Partial<Record<DiscriminatorSlot, unknown>>;
  const listed = ID_DISCRIMINATOR_SETS.get(f.type);
  const disc = DISCRIMINATOR_SLOTS.map((slot) => {
    const v = listed?.has(slot) ? fields[slot] : undefined;
    return Array.isArray(v) ? v.join(',') : v ?? '';
  }).join('|');
  return fnv1a(`${f.type}|${locationKey(f)}|${f.metric ?? ''}|${f.value ?? f.valueText ?? ''}|${disc}`);
}

// skew (either branch) and straggler both claim the stage's replayed tail recovery
// (tailReplayRecoveryMs via tailRecoveryMs): the same slow-task tail reported by two detectors
// (see "Overlap caveat: skew / straggler" in impact-estimation/caveats-tuning-and-coverage.md). skew's branch only changes
// the fallback single-task delta on a stage without the replay, so every skew + straggler pair
// on a stage is flagged. Flags both sides via validationRequired (rather than suppressing
// either) so neither finding's own diagnostic value is lost; the flag rides the same
// confidence-caveat UI a reader already sees before trusting either finding's magnitude.
function overlapNote(otherType: 'skew' | 'straggler'): string {
  return `This overlaps with the ${otherType} finding on this stage: both measure the same slow-task tail, so don't add their recoverable-time figures together.`;
}

function flagSkewStragglerOverlap(findings: Finding[]): void {
  const skewStages = new Set(
    findings.filter((f) => f.type === 'skew' && f.stageId != null).map((f) => f.stageId),
  );
  if (skewStages.size === 0) return;
  const stragglerStages = new Set(
    findings.filter((f) => f.type === 'straggler' && f.stageId != null).map((f) => f.stageId),
  );
  const overlapStages = new Set([...skewStages].filter((id) => stragglerStages.has(id)));
  if (overlapStages.size === 0) return;
  for (const f of findings) {
    if (f.stageId == null || !overlapStages.has(f.stageId)) continue;
    const note = f.type === 'skew' ? overlapNote('straggler') : f.type === 'straggler' ? overlapNote('skew') : null;
    if (!note) continue;
    f.validationRequired = [f.validationRequired, note].filter(Boolean).join(' ');
  }
}

function push(out: Finding[], entry: Detector, result: Finding | Finding[] | null, tuned: TunedThresholds | null = null): void {
  if (!result) return;
  const detectorVersion = entry.version ?? 1;
  for (const f of (Array.isArray(result) ? result : [result])) {
    if (!f) continue;
    const stamped = { ...f, docAnchor: f.docAnchor ?? entry.docAnchor, detectorVersion };
    if (tuned) stamped.tunedThresholds = tuned;
    const id = findingId(stamped);
    // Dedup guard: same id => same finding, keep first. Correctness depends on
    // findingId's discriminators being unique per distinct finding, not on this line.
    if (out.some((existing) => existing.id === id)) continue;
    out.push({ ...stamped, id });
  }
}

// A tuned finding's caveat, once its estimate is known: only a finding with an estimate figure
// (wall-clock or raw waste) says that figure is unvalidated.
function noteTunedThresholds(findings: Finding[]): void {
  for (const f of findings) {
    if (!f.tunedThresholds) continue;
    const hasFigure = f.impactEstimate != null && f.impactEstimate.basis !== 'informational';
    const note = tunedThresholdsNote(f.tunedThresholds, hasFigure);
    f.validationRequired = f.validationRequired ? `${f.validationRequired} ${note}` : note;
  }
}

// skew and straggler gate on floorPctWarn/floorPctCrit thresholds that default to the band's own
// floors, so a finding they admit at their warn floor grades at least warning. A tuned floor grades
// that entry's findings too; a type whose entry has no such threshold keeps the defaults.
function bandFloors(type: string, overrides: ThresholdOverrides): ImpactBandFloors | null {
  const entry = ENTRY_BY_TYPE.get(type);
  if (!entry) return null;
  const { floorPctWarn, floorPctCrit } = effectiveThresholds(entry, overrides);
  return {
    warnPct: typeof floorPctWarn === 'number' ? floorPctWarn : IMPACT_FLOOR_PCT_WARN,
    critPct: typeof floorPctCrit === 'number' ? floorPctCrit : IMPACT_FLOOR_PCT_CRIT,
  };
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
  // One occupancy sweep per analysis, shared by the detectors' runtime floors and every entry's
  // estimate(), so a floor gates on the same occupancy-clipped figure displayed as savings.
  const impact: EstimateCtx = {
    stages, totalCores, sql,
    occupancy: computeOccupancy(stages as unknown as Map<number, OccupancyStage>, totalCores),
  };
  // The one cast from the posted-model types to the detector-side shapes: types.ts's Stage and
  // SqlExecution carry a catch-all index signature, while every field DetectorStage/DetectorSqlExec
  // declare is one finalizeStage and event-handlers.ts always set (see detectors.ts's header).
  const ctx: DetectorCtx = {
    app, jobs, executorsAdded, executorsRemoved, runAggregates, impact,
    stages: stages as unknown as DetectorCtx['stages'],
    sql: sql as unknown as DetectorCtx['sql'],
  };
  const out: Finding[] = [];
  for (const d of detectors) {
    if (d.inScorecard === false) continue;
    const overrides = overridesFor(d, thresholds);
    const tuned = findingTunedThresholds(d, thresholds);
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
  estimateImpact(findings, impact);
  noteTunedThresholds(findings);
  deriveImpactBand(findings, app, thresholds ? (type) => bandFloors(type, thresholds) : undefined);
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
  // configAudit's estimate is unconditionally costOnly('none'): needs no stages/totalCores, so an
  // empty context gives parity with analyze().
  estimateImpact(out, { stages: new Map(), occupancy: new Map(), totalCores: 0 });
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
