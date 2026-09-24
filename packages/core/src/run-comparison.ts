import { computeWallClock } from './wall-clock.ts';
import { normalizeDetail } from './detectors.ts';
import { cyrb53 } from './string-hash.ts';
import { captureSnapshot } from './session-snapshot.ts';
import type { Stage, PlanNode, SparkAppInfo, AppModel, Finding } from './types.ts';
import type { SessionSnapshot } from './session-snapshot.ts';

export interface MetricDeltaRow {
  key: string; label: string;
  baseline: number | null; candidate: number | null; delta: number | null;
  direction: 'improvement' | 'regression' | 'unchanged' | 'neutral' | 'unavailable';
  unavailableReason?: string;
}
export interface FindingsDeltaRow {
  rule: string; impactBand: string; baseCount: number; candCount: number; delta: number; stages: string[];
}
export interface CompareRunsResult {
  baselineLabel: string; candidateLabel: string;
  confidence: 'ok' | 'low'; reason: string | null;
  matchedCoverage: number;
  metrics: MetricDeltaRow[];
  findings: { introduced: FindingsDeltaRow[]; resolved: FindingsDeltaRow[] };
  stageSkew: Array<{ identity: string; baseId: number; candId: number; baseline: number | null; candidate: number | null; delta: number | null }>;
  baseStages: Array<{ id: number; name: string; metrics: StageMetricsRow }>;
  candStages: Array<{ id: number; name: string; metrics: StageMetricsRow }>;
}

// Replace run-varying tokens (digit runs, long hex ids) with a stable marker so
// the same logical stage across two runs normalizes to one identity.
export function normalizeStageName(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, '#') // hex ids/uuids first (they contain digits)
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

// Bottom-up, order-independent structural identity of a resolved plan tree:
// each node folds its normalized name/detail with its children's digests
// (children sorted, so AQE picking a different broadcast side still matches),
// so two plans collide only when their whole shape and every node's detail
// agree. `normalizeDetail` strips the run-to-run noise (expr ids, `plan_id=`,
// codegen numbers, AQE build-side choice, commutative-operand order). Each
// node folds to a fixed-length cyrb53 digest (JSON.stringify-encoded, so
// detail text containing `<`/`>`/`{`/`,` can't collide two different plans)
// instead of embedding full child identity strings, which would re-escape
// every level below and blow identity size up to ~2^depth on the 20-60+
// operator-deep plans real Spark produces.
function planTreeIdentity(root: PlanNode | null | undefined): string | null {
  if (!root) return null;
  function visit(node: PlanNode): string {
    const childDigests = (node.children ?? []).map(visit).sort();
    return cyrb53(JSON.stringify([normalizeStageName(node.name ?? ''), normalizeDetail(node.detail ?? ''), childDigests]));
  }
  return visit(root);
}

// Plan identity for the stage's SQL execution, scoped to only the plan nodes
// this stage actually ran (`node.stageIds`), not the whole tree: two stages
// sharing one SQL execution (e.g. a self-join's two Exchange stages) otherwise
// collapse onto one identity regardless of which part of the plan each ran.
// Falls back to the coarser whole-tree identity when the stage has no
// attributed nodes (hand-built snapshots without `stageIds`, or unmatched
// accumulables).
function sqlNodeIdentity(stage: Stage, snapshot: SessionSnapshot): string {
  const execId = stage.sqlExecutionId;
  if (execId == null) return '';
  const root = snapshot.sql.get(execId)?.planTree ?? null;
  if (!root) return '';
  const fingerprints: string[] = [];
  (function collect(node: PlanNode): void {
    if (node.stageIds?.includes(stage.id)) {
      fingerprints.push(JSON.stringify([normalizeStageName(node.name ?? ''), normalizeDetail(node.detail ?? '')]));
    }
    for (const child of node.children ?? []) collect(child);
  })(root);
  if (fingerprints.length === 0) return planTreeIdentity(root) ?? '';
  return cyrb53(JSON.stringify(fingerprints.sort()));
}

export function stageIdentity(stage: Stage, snapshot: SessionSnapshot): string {
  return normalizeStageName(stage.name ?? '') + '§' + sqlNodeIdentity(stage, snapshot);
}

function identityIndex(snapshot: SessionSnapshot): Map<string, number[]> {
  const byIdentity = new Map<string, number[]>();
  for (const [id, stage] of snapshot.stages) {
    const key = stageIdentity(stage, snapshot);
    const ids = byIdentity.get(key);
    if (ids) ids.push(id);
    else byIdentity.set(key, [id]);
  }
  return byIdentity;
}

export function matchStages(baseSnap: SessionSnapshot, candSnap: SessionSnapshot): {
  pairs: Array<{ identity: string; baseId: number; candId: number }>;
  matchedIdentities: Set<string>;
  collisionIdentities: Set<string>;
  coverage: number;
} {
  const baseIdx = identityIndex(baseSnap);
  const candIdx = identityIndex(candSnap);
  const pairs: Array<{ identity: string; baseId: number; candId: number }> = [];
  const matchedIdentities = new Set<string>();
  const collisionIdentities = new Set<string>();
  // A collision is a single-run property: more than one stage in the SAME run
  // shares an identity. Recorded per-run regardless of whether the other run
  // shares it too. Some collisions get resolved into `pairs` below and some
  // don't, so this set means "was ambiguous", not "stayed unpaired".
  for (const idx of [baseIdx, candIdx])
    for (const [identity, ids] of idx) if (ids.length > 1) collisionIdentities.add(identity);
  // An identity colliding equally on both sides has no genuine ambiguity about
  // *count*, so pair its stages off positionally by sorted id rather than
  // dropping them. This is exact when the identity actually distinguishes
  // stages (e.g. self-comparing a run: every stage matches itself). It's a
  // best-effort guess when the identity is coarse (no SQL/attribution) and
  // the two sides are genuinely different runs -- two unrelated same-named
  // stages could get cross-paired. Accepted tradeoff: dropping them instead
  // would also sacrifice the exact-self-comparison case, which matters more.
  for (const identity of [...baseIdx.keys()].sort()) {
    const candIds = candIdx.get(identity);
    if (!candIds) continue;
    const baseIds = baseIdx.get(identity)!;
    if (baseIds.length !== candIds.length) continue;
    const sortedBaseIds = [...baseIds].sort((a, b) => a - b);
    const sortedCandIds = [...candIds].sort((a, b) => a - b);
    for (let i = 0; i < sortedBaseIds.length; i++) {
      pairs.push({ identity, baseId: sortedBaseIds[i], candId: sortedCandIds[i] });
    }
    matchedIdentities.add(identity);
  }
  const total = baseSnap.stages.size + candSnap.stages.size;
  // Both runs stage-less: nothing to compare, not "nothing matched".
  const coverage = total === 0 ? 1 : (2 * pairs.length) / total;
  return { pairs, matchedIdentities, collisionIdentities, coverage };
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length) - 1; // nearest-rank, deterministic
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

// The stage numeric fields sumField/perStageMetrics read; keeps the generic
// `field` parameter narrowed to a known numeric Stage property instead of
// widening to `string` (Stage also carries a `[key: string]: unknown` index
// signature for detector-only fields).
type NumericStageField =
  | 'memoryBytesSpilled' | 'diskBytesSpilled' | 'jvmGCTime' | 'inputBytes'
  | 'outputBytes' | 'executorRunTime' | 'taskCount' | 'failedTasks';

// Sum a numeric stage field over a stage list; `present` is false when no stage
// carried a finite value (so the metric renders Unavailable rather than a false 0).
function sumField(stages: Stage[], field: NumericStageField): { sum: number; present: boolean } {
  let sum = 0, present = false;
  for (const s of stages) {
    const v = s[field];
    if (Number.isFinite(v)) { sum += v as number; present = true; }
  }
  return { sum, present };
}

// Shared by skewRatios (whole-run p95 input) and stageSkewDeltas' `ratio`
// closure (per-pair matched comparison): both need the identical per-stage
// task-skew formula (max task duration over stage wall-clock duration).
function stageSkewRatio(stage: Stage): number | null {
  const dur = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
  return dur > 0 && Number.isFinite(stage.taskDurationMax) ? (stage.taskDurationMax as number) / dur : null;
}

function skewRatios(stages: Stage[]): number[] {
  const out: number[] = [];
  for (const s of stages) {
    const ratio = stageSkewRatio(s);
    if (ratio != null) out.push(ratio);
  }
  return out;
}

// Every key metricDeltas() emits, in emission order. The CLI validates
// --regression-metric against it, so a misspelled key is a usage error rather
// than an inconclusive budget. A contract test keeps it in sync.
export const COMPARISON_METRIC_KEYS: readonly string[] = [
  'wallClock', 'shuffleSpill', 'taskSkew', 'failedTaskRate', 'diskSpill', 'gcTime',
  'inputBytes', 'outputBytes', 'executorRunTime', 'taskCount', 'executorsAdded',
];

// Volume/count metrics, not cost metrics: more or less input/output data, or
// tasks/executors, isn't inherently better or worse (it may just reflect a
// differently-sized job), unlike wall-clock, spill, GC, etc. Exported as the
// single source of truth for "which metrics have no better/worse direction",
// shared by the view (RunComparison.tsx, for Δ coloring) and by
// src/cli/budgets.ts's checkRegression (so a `--regression-metric inputBytes`
// budget can't misread "processed more data" as a regression).
export const NEUTRAL_METRIC_KEYS: ReadonlySet<string> = new Set(['inputBytes', 'outputBytes', 'taskCount', 'executorsAdded']);

function direction(key: string, baseline: number | null, candidate: number | null): MetricDeltaRow['direction'] {
  if (baseline == null || candidate == null) return 'unavailable';
  if (NEUTRAL_METRIC_KEYS.has(key)) return candidate === baseline ? 'unchanged' : 'neutral';
  const d = candidate - baseline;
  return d < 0 ? 'improvement' : d > 0 ? 'regression' : 'unchanged';
}

function metric(
  key: string, label: string, baseline: number | null, candidate: number | null,
  extra: { unavailableReason?: string } = {},
): MetricDeltaRow {
  const dir = direction(key, baseline, candidate);
  const delta = baseline == null || candidate == null ? null : candidate - baseline;
  return { key, label, baseline, candidate, delta, direction: dir, ...extra };
}

export function metricDeltas(baseSnap: SessionSnapshot, candSnap: SessionSnapshot): MetricDeltaRow[] {
  const out: MetricDeltaRow[] = [];

  // Wall-clock: always computable (computeWallClock tolerates a null app).
  out.push(metric('wallClock', 'Wall-clock duration',
    computeWallClock(baseSnap.app, baseSnap.stages).total,
    computeWallClock(candSnap.app, candSnap.stages).total));

  // Shuffle spill over the whole run: a sum needs no stage matching, and
  // matching is unreliable on real logs (see plan rationale), so scope it to
  // all stages exactly like task-skew and failed-rate below.
  const bSpill = sumField([...baseSnap.stages.values()], 'memoryBytesSpilled');
  const cSpill = sumField([...candSnap.stages.values()], 'memoryBytesSpilled');
  out.push(metric('shuffleSpill', 'Shuffle spill',
    bSpill.present ? bSpill.sum : null, cSpill.present ? cSpill.sum : null,
    { unavailableReason: bSpill.present && cSpill.present ? undefined : 'No shuffle-spill data recorded for a run' }));

  // Task skew: p95 of per-stage ratio across the whole run.
  const bSkew = p95(skewRatios([...baseSnap.stages.values()]));
  const cSkew = p95(skewRatios([...candSnap.stages.values()]));
  out.push(metric('taskSkew', 'Task skew (p95)', bSkew, cSkew,
    { unavailableReason: bSkew != null && cSkew != null ? undefined : 'No stage had measurable duration for a run' }));

  // Failed-task rate: Σ failedTasks / Σ taskCount.
  const bTasks = sumField([...baseSnap.stages.values()], 'taskCount');
  const cTasks = sumField([...candSnap.stages.values()], 'taskCount');
  const bFailed = sumField([...baseSnap.stages.values()], 'failedTasks');
  const cFailed = sumField([...candSnap.stages.values()], 'failedTasks');
  // Guard on BOTH inputs: a missing `failedTasks` field must render Unavailable,
  // not a false 0% rate (dividing an absent-and-therefore-0 numerator).
  const bRate = bTasks.present && bTasks.sum > 0 && bFailed.present ? bFailed.sum / bTasks.sum : null;
  const cRate = cTasks.present && cTasks.sum > 0 && cFailed.present ? cFailed.sum / cTasks.sum : null;
  out.push(metric('failedTaskRate', 'Failed-task rate', bRate, cRate,
    { unavailableReason: bRate != null && cRate != null ? undefined : 'No task or failure counts recorded for a run' }));

  // Additional whole-run aggregates: plain sums of fields the stage already
  // carries (set in finalizeStage). Correct at any match coverage, like the
  // sums above; no parser or detector change.
  const sumMetric = (key: string, label: string, field: NumericStageField, reason: string) => {
    const b = sumField([...baseSnap.stages.values()], field);
    const c = sumField([...candSnap.stages.values()], field);
    out.push(metric(key, label, b.present ? b.sum : null, c.present ? c.sum : null,
      { unavailableReason: b.present && c.present ? undefined : reason }));
  };
  sumMetric('diskSpill', 'Disk spill', 'diskBytesSpilled', 'No disk-spill data recorded for a run');
  sumMetric('gcTime', 'GC time', 'jvmGCTime', 'No GC-time data recorded for a run');
  sumMetric('inputBytes', 'Input read', 'inputBytes', 'No input-bytes data recorded for a run');
  sumMetric('outputBytes', 'Output written', 'outputBytes', 'No output-bytes data recorded for a run');
  sumMetric('executorRunTime', 'Executor run-time', 'executorRunTime', 'No executor run-time recorded for a run');
  sumMetric('taskCount', 'Task count', 'taskCount', 'No task counts recorded for a run');

  // Executor count is app-level, not per-stage. `executors` is absent on
  // hand-built snapshots; guard so it renders Unavailable, not a crash.
  const execCount = (snap: SessionSnapshot): number | null =>
    (Array.isArray(snap.executors?.added) ? snap.executors.added.length : null);
  const bExec = execCount(baseSnap), cExec = execCount(candSnap);
  out.push(metric('executorsAdded', 'Executors added', bExec, cExec,
    { unavailableReason: bExec != null && cExec != null ? undefined : 'No executor events recorded for a run' }));

  return out;
}

// Finding categories are counted, not matched: a (rule × impact band) tally needs
// no cross-run stage identity, so it stays correct even when almost no stages
// match uniquely (the common case on real logs, see plan rationale). A
// category the candidate has more of is "introduced"; fewer, "resolved".
export function findingsDelta(baseSnap: SessionSnapshot, candSnap: SessionSnapshot): {
  introduced: FindingsDeltaRow[]; resolved: FindingsDeltaRow[];
} {
  interface TallyEntry { rule: string; impactBand: string; count: number; stages: Set<string>; }
  const tally = (snap: SessionSnapshot): Map<string, TallyEntry> => {
    const m = new Map<string, TallyEntry>(); // `${rule}§${impactBand}` -> { rule, impactBand, count, stages:Set }
    for (const f of snap.catalog) {
      const rule = typeof f.rule === 'string' ? f.rule : f.type;
      const impactBand = f.impactBand ?? 'unknown';
      const key = `${rule}§${impactBand}`;
      const e = m.get(key) ?? { rule, impactBand, count: 0, stages: new Set<string>() };
      e.count++;
      // Resolve stageId → name on this snapshot only: a single-side lookup, so
      // it needs no cross-run identity. App-level findings (stageId null) add none.
      const stage = f.stageId != null ? snap.stages.get(f.stageId) : null;
      if (stage?.name) e.stages.add(stage.name);
      m.set(key, e);
    }
    return m;
  };
  const b = tally(baseSnap), c = tally(candSnap);
  const introduced: FindingsDeltaRow[] = [], resolved: FindingsDeltaRow[] = [];
  for (const key of [...new Set([...b.keys(), ...c.keys()])].sort()) {
    const be = b.get(key), ce = c.get(key);
    const baseCount = be?.count ?? 0;
    const candCount = ce?.count ?? 0;
    if (candCount === baseCount) continue;
    const meta = ce ?? be!;
    const more = candCount > baseCount ? ce! : be!; // the side with more supplies the labels
    const row: FindingsDeltaRow = { rule: meta.rule, impactBand: meta.impactBand, baseCount, candCount,
      delta: candCount - baseCount, stages: [...more.stages].sort() };
    (candCount > baseCount ? introduced : resolved).push(row);
  }
  return { introduced, resolved };
}

function namesConflict(a: SparkAppInfo | null, b: SparkAppInfo | null): boolean {
  return a?.name != null && b?.name != null && a.name !== b.name;
}

// A pair's skew ratio is null when the stage's duration wasn't measurable (see
// `stageSkewRatio`). `baseId`/`candId` are carried through so a consumer can
// key rows uniquely: two pairs can share one `identity` (a same-run collision
// resolved positionally in matchStages), but never the same baseId+candId.
function stageSkewDeltas(
  baseSnap: SessionSnapshot,
  candSnap: SessionSnapshot,
  match: { pairs: Array<{ identity: string; baseId: number; candId: number }> },
): Array<{ identity: string; baseId: number; candId: number; baseline: number | null; candidate: number | null; delta: number | null }> {
  return match.pairs.map((p) => {
    const b = stageSkewRatio(baseSnap.stages.get(p.baseId)!);
    const c = stageSkewRatio(candSnap.stages.get(p.candId)!);
    return { identity: p.identity, baseId: p.baseId, candId: p.candId, baseline: b, candidate: c, delta: b != null && c != null ? c - b : null };
  }).sort((x, y) => x.identity < y.identity ? -1 : x.identity > y.identity ? 1 : 0);
}

// Compact, view-friendly per-stage record for the manual stage-pinning panel.
// Every field is number | null; a null means the stage did not carry it.
// Exported: it's CompareRunsResult['baseStages'/'candStages']'s metrics type.
export interface StageMetricsRow {
  duration: number | null;
  memoryBytesSpilled: number | null;
  diskBytesSpilled: number | null;
  jvmGCTime: number | null;
  inputBytes: number | null;
  outputBytes: number | null;
  executorRunTime: number | null;
  taskCount: number | null;
  failedTasks: number | null;
}

function perStageMetrics(stage: Stage): StageMetricsRow {
  const num = (v: unknown): number | null => (Number.isFinite(v) ? (v as number) : null);
  const dur = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
  return {
    duration: dur > 0 ? dur : null,
    memoryBytesSpilled: num(stage.memoryBytesSpilled),
    diskBytesSpilled: num(stage.diskBytesSpilled),
    jvmGCTime: num(stage.jvmGCTime),
    inputBytes: num(stage.inputBytes),
    outputBytes: num(stage.outputBytes),
    executorRunTime: num(stage.executorRunTime),
    taskCount: num(stage.taskCount),
    failedTasks: num(stage.failedTasks),
  };
}

function stageList(snap: SessionSnapshot): Array<{ id: number; name: string; metrics: StageMetricsRow }> {
  return [...snap.stages].map(([id, s]) => ({ id, name: s.name ?? `Stage ${id}`, metrics: perStageMetrics(s) }));
}

// captureSnapshot copies this into a fresh Map internally and never mutates the
// caller's reference, so one shared empty Map is safe here.
const EMPTY_TASK_DATA = new Map<number, unknown>();

// Wraps the analyze()-to-compareRuns() snapshot-building sequence shared by
// the CLI's --baseline path and mcp-tools.ts's compareRuns tool: both need
// captureSnapshot (with an empty taskDataCache, the interactive drill-down
// cache, never read by compareRuns/matchStages/metricDeltas/findingsDelta)
// for each side before diffing them.
export function buildComparison(
  baseline: { label: string; appModel: AppModel; catalog: Finding[] },
  candidate: { label: string; appModel: AppModel; catalog: Finding[] },
): CompareRunsResult {
  return compareRuns(
    { label: baseline.label, snapshot: captureSnapshot(baseline.appModel, baseline.catalog, EMPTY_TASK_DATA) },
    { label: candidate.label, snapshot: captureSnapshot(candidate.appModel, candidate.catalog, EMPTY_TASK_DATA) },
  );
}

// matchStages' coverage is a Dice coefficient: (2 * pairs.length) / (baseCount
// + candCount). Below 0.5, more than half of each run's stages went unpaired,
// so the stage-level rows (stageSkew, baseStages/candStages) mostly show
// unrelated work side by side rather than the same stage before/after -- the
// comparison is dominated by guesswork, not genuine pairing. 0.5 is thus the
// natural midpoint for "more matched than not," not an arbitrary tuning knob.
const LOW_COVERAGE_THRESHOLD = 0.5;

export function compareRuns(
  baseline: { label: string; snapshot: SessionSnapshot },
  candidate: { label: string; snapshot: SessionSnapshot },
): CompareRunsResult {
  const baseSnap = baseline.snapshot, candSnap = candidate.snapshot;
  const match = matchStages(baseSnap, candSnap);
  // Name equality is a weak confidence signal, not a hard gate: renaming a job
  // is the normal way to label an A/B experiment, so a mismatch must not block
  // the (matching-free, name-independent) deltas. Surface it as `low` instead.
  const namesDiffer = namesConflict(baseSnap.app, candSnap.app);
  // Coverage is the other half of the signal: identical names on two runs that
  // barely share any stages are just as misleading as differing names on two
  // runs that match well, so either condition alone drops confidence to `low`.
  const lowCoverage = match.coverage < LOW_COVERAGE_THRESHOLD;
  const reason = namesDiffer && lowCoverage
    ? `Run names differ and only ${(match.coverage * 100).toFixed(0)}% of stages matched, so deltas may compare different work.`
    : namesDiffer
    ? 'Run names differ, so deltas may compare different work.'
    : lowCoverage
    ? `Only ${(match.coverage * 100).toFixed(0)}% of stages matched between runs, so per-stage rows mostly compare unrelated work.`
    : null;
  return {
    baselineLabel: baseline.label, candidateLabel: candidate.label,
    confidence: namesDiffer || lowCoverage ? 'low' : 'ok',
    reason,
    matchedCoverage: match.coverage,
    metrics: metricDeltas(baseSnap, candSnap),
    findings: findingsDelta(baseSnap, candSnap),
    stageSkew: stageSkewDeltas(baseSnap, candSnap, match),
    baseStages: stageList(baseSnap),
    candStages: stageList(candSnap),
  };
}

// One introduced/resolved findings-delta block: `### <title> (<count>)`
// heading followed by one bullet per finding.
function renderFindingsSection(title: string, findings: FindingsDeltaRow[]): string[] {
  const lines = [`### ${title} (${findings.length})`, ''];
  for (const f of findings) {
    lines.push(`- [${f.impactBand}] ${f.rule}: ${f.baseCount} -> ${f.candCount}`);
  }
  return lines;
}

// Small Markdown renderer for the comparison section, matching
// evidence-report.ts's renderMarkdown house style (## section heading, ###
// subheadings, `- key: value` bullets). Shared by the CLI's --baseline
// markdown output and the MCP server's compare_runs `format: 'md'`.
export function renderComparisonMarkdown(comparison: CompareRunsResult): string {
  const lines = ['', '## Comparison to baseline', ''];
  if (comparison.confidence === 'low') {
    lines.push(`- confidence: low, ${comparison.reason}`);
    lines.push('');
  }
  lines.push(`- matched stage coverage: ${(comparison.matchedCoverage * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('### Metric deltas');
  lines.push('');
  for (const m of comparison.metrics) {
    lines.push(`- ${m.label}: ${m.baseline ?? 'n/a'} -> ${m.candidate ?? 'n/a'} (${m.direction})`);
  }
  lines.push('');
  lines.push(...renderFindingsSection('Introduced findings', comparison.findings.introduced));
  lines.push('');
  lines.push(...renderFindingsSection('Resolved findings', comparison.findings.resolved));
  return lines.join('\n');
}
