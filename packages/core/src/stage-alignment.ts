// The stage aligner: two snapshots and options in, typed stage pairs out. Pure (no I/O, no
// dependency on the CLI, MCP or UI) and deterministic; swapping baseline and candidate mirrors the
// pairs. `compareRuns` calls it, and every surface that compares runs reads its result
// (`stagePairs`) instead of comparing stage keys.
//
// Pairing keys on `comparisonIdentity`: the `stageIdentity` recipe run with the comparison
// normalizer, so the volatile tokens that make two runs of one job differ (staging directories,
// dates, IN-lists, Delta log file counts, column order) and the caller's `--normalize-path`
// patterns do not split a stage in two. `stageIdentity` itself stays the frozen exact key.

import { normalizeDetail } from './detectors.ts';
import { isDeltaLogRead, scanRelationId } from './plan-summary.ts';
import { withEarlierAttempts, totalExecutorCpuMs } from './run-totals.ts';
import { planNodesOfStage } from './stage-plan-nodes.ts';
import { identityIndexWith, pairEqualCounts, stageIdentityWith, type DetailNormalizer } from './stage-identity.ts';
import type { SessionSnapshot } from './session-snapshot.ts';
import type { Stage, PlanNode } from './types.ts';

/** Version of the comparison block (`stagePairs`, `unmatched`, `replanned`, `bookkeepingStageIds`,
 * `runtimeCoverage`). Additive changes keep it; a consumer refuses a version it does not know. */
export const COMPARISON_SCHEMA_VERSION = 1;

// ---- Comparison normalizer ------------------------------------------------------------------

// Targeted patches for the volatile tokens that differ between two runs of one job. Each applies
// on top of `normalizeDetail`, in this order. No blanket numeric or path stripping: those fuse
// distinct stages of one run.
export const COMPARISON_PATCHES: ReadonlyArray<{ name: string; apply: (s: string) => string }> = [
  // Delta log and file-index file counts track how many files or commits exist, not the query:
  // DeltaLogFileIndex(4 paths) vs DeltaLogFileIndex(8 paths).
  { name: 'fileCounts', apply: (s) => s.replace(/FileIndex\(\d+ paths\)/g, 'FileIndex(n paths)') },
  // Date and timestamp literals: the run's processing window.
  { name: 'dates', apply: (s) => s.replace(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)?/g, 'DATE') },
  // IN-lists grow with the window. Spark prints small lists as `IN (a, b)` and large ones
  // (InSet) as `INSET a, b` with no opening parenthesis.
  {
    name: 'inLists',
    apply: (s) => s.replace(/\bIN \([^()]*\)/g, 'IN (...)').replace(/\bINSET [^()]*?(?=\))/g, 'INSET ...'),
  },
  // Random per-run staging directory segments (`/ds/aB3xYz/`): a 6-8 character alphanumeric path
  // segment that mixes cases, or letters with digits. An ALL-CAPS or all-lowercase name survives,
  // but a real directory that looks like that (`/output01/`, `/Region3/`) is rewritten too.
  {
    name: 'stagingDirs',
    apply: (s) => s.replace(/\/([A-Za-z0-9]{6,8})(?=\/)/g, (m, seg: string) =>
      (/[A-Z]/.test(seg) && /[a-z]/.test(seg)) || (/[A-Za-z]/.test(seg) && /\d/.test(seg)) ? '/TMP' : m),
  },
  // Column order: the entries of each innermost bracketed list are sorted, for lists a Python set
  // emits in a different order per process (Expand projections, grouping ids). Text outside the
  // brackets, operators and parentheses stay as printed.
  { name: 'columnOrder', apply: (s) => s.replace(/\[([^[\]]*)\]/g, (_m, list: string) => `[${sortListEntries(list).join(', ')}]`) },
];

// Splits a bracketed list at its top-level commas (commas inside parentheses stay put), trims
// each entry and sorts them.
function sortListEntries(list: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      entries.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  entries.push(list.slice(start).trim());
  return entries.sort();
}

/** What every match of a caller-supplied pattern is replaced with. */
export const NORMALIZE_PATH_TOKEN = 'NORMALIZED';
/** Longest caller pattern accepted. A pattern from an agent can backtrack catastrophically, so
 * the length is capped; the cap does not make a bad pattern safe. */
export const MAX_NORMALIZE_PATTERN_LENGTH = 200;
export const MAX_NORMALIZE_PATTERNS = 16;

/** Compiles caller-supplied normalize patterns (global, every match replaced). Throws an Error
 * naming the offending pattern when one is too long, not a valid regular expression, or matches
 * the empty string (which would insert the token between every character). */
export function compileNormalizePatterns(patterns: readonly string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  if (patterns.length > MAX_NORMALIZE_PATTERNS) {
    throw new Error(`At most ${MAX_NORMALIZE_PATTERNS} normalize patterns are accepted, got ${patterns.length}.`);
  }
  return patterns.map((source) => {
    if (typeof source !== 'string' || source.length === 0) throw new Error('A normalize pattern must be a non-empty string.');
    if (source.length > MAX_NORMALIZE_PATTERN_LENGTH) {
      throw new Error(`Normalize pattern "${source.slice(0, 40)}..." is ${source.length} characters; the limit is ${MAX_NORMALIZE_PATTERN_LENGTH}.`);
    }
    let re: RegExp;
    try {
      re = new RegExp(source, 'g');
    } catch (e) {
      throw new Error(`Normalize pattern "${source}" is not a valid regular expression: ${(e as Error).message}`);
    }
    if (re.test('')) throw new Error(`Normalize pattern "${source}" matches the empty string.`);
    re.lastIndex = 0;
    return re;
  });
}

/** The detail normalizer the comparison keys use: caller patterns first, on the text as Spark
 * printed it (a path pattern would not match once the column bag below has split it), then
 * `normalizeDetail`, then the targeted patches. */
export function comparisonDetailNormalizer(callerPatterns: readonly RegExp[] = []): DetailNormalizer {
  return (detail) => {
    let s = detail;
    for (const re of callerPatterns) s = s.replace(re, NORMALIZE_PATH_TOKEN);
    s = normalizeDetail(s);
    for (const patch of COMPARISON_PATCHES) s = patch.apply(s);
    return s;
  };
}

// ---- Identity and bookkeeping ---------------------------------------------------------------

/** `stageIdentity`'s recipe (normalized stage name plus the attributed nodes' fingerprint) with the
 * comparison normalizer. Internal to the aligner: consumers key on a pair's `pairId`. */
export function comparisonIdentity(
  stage: Stage, snapshot: Pick<SessionSnapshot, 'sql'>, normalizer: DetailNormalizer, nodes?: PlanNode[],
): string {
  return stageIdentityWith(stage, snapshot, normalizer, nodes);
}

function isScanNode(node: PlanNode): boolean {
  return /^(Scan|BatchScan)\b/.test(node.name ?? '') || /FileScan|JDBCRelation/.test(node.detail ?? '');
}

/** True for a stage whose scans only read Delta log files or checkpoints: it has at least one scan
 * and every scan is internal Delta metadata. Such a stage is table bookkeeping, not query work.
 * A stage with no attributed plan nodes has no scans to test, so it is never flagged. */
export function isDeltaBookkeepingStage(
  stage: Pick<Stage, 'id' | 'sqlExecutionId'>, sql: SessionSnapshot['sql'], nodes: PlanNode[] = planNodesOfStage(stage, sql),
): boolean {
  let scans = 0;
  for (const node of nodes) {
    if (!isScanNode(node)) continue;
    const name = node.name ?? '', detail = node.detail ?? '';
    if (scanRelationId(name, detail) !== null || !isDeltaLogRead(name, detail)) return false;
    scans++;
  }
  return scans > 0;
}

// ---- Alignment ------------------------------------------------------------------------------

export const PAIR_DELTA_METRICS = [
  'executorRunTime', 'executorCpuTime', 'memoryBytesSpilled', 'diskBytesSpilled',
  'inputBytes', 'outputBytes', 'shuffleReadBytes', 'shuffleWriteBytes',
] as const;
export type PairDeltaMetric = typeof PAIR_DELTA_METRICS[number];

export interface StageDelta { baseline: number | null; candidate: number | null; delta: number | null }

export interface StagePair {
  /** Stable for one pair of runs; what a consumer keys on. */
  pairId: string;
  baseStageIds: number[];
  candStageIds: number[];
  quality: 'exact' | 'structural' | 'aligned';
  /** 0-1; 1 for an exact pair. */
  score: number;
  deltas: Record<PairDeltaMetric, StageDelta>;
}

export interface StageAlignment {
  pairs: StagePair[];
  /** Stages (bookkeeping stages excluded) that paired with nothing. */
  unmatched: { baseStageIds: number[]; candStageIds: number[] };
  /** Re-planned execution groups; always empty until re-plan detection exists. */
  replanned: never[];
  /** Delta bookkeeping stages: in neither the pairs, the unmatched lists nor the coverage. */
  bookkeepingStageIds: { baseStageIds: number[]; candStageIds: number[] };
  /** Executor run time of the paired stages over the total of both runs (bookkeeping excluded);
   * null when that total is zero. */
  runtimeCoverage: number | null;
}

export interface AlignOptions {
  /** Compiled caller patterns (`compileNormalizePatterns`). */
  normalizePath?: readonly RegExp[];
}

// Sum of a field over the stage's own record and the work its figures leave out (earlier
// attempts, a failed attempt's late tasks), the same all-attempt sums the run totals use.
// null when no row carried a finite value, so an unrecorded field is not a false 0.
function attemptSum(rows: Stage[], field: Exclude<PairDeltaMetric, 'executorCpuTime'>): number | null {
  let sum = 0, present = false;
  for (const row of rows) {
    const v = row[field];
    if (typeof v === 'number' && Number.isFinite(v)) { sum += v; present = true; }
  }
  return present ? sum : null;
}

function stageFigures(stage: Stage): Record<PairDeltaMetric, number | null> {
  const rows = withEarlierAttempts([stage]);
  return {
    executorRunTime: attemptSum(rows, 'executorRunTime'),
    executorCpuTime: totalExecutorCpuMs(rows),
    memoryBytesSpilled: attemptSum(rows, 'memoryBytesSpilled'),
    diskBytesSpilled: attemptSum(rows, 'diskBytesSpilled'),
    inputBytes: attemptSum(rows, 'inputBytes'),
    outputBytes: attemptSum(rows, 'outputBytes'),
    shuffleReadBytes: attemptSum(rows, 'shuffleReadBytes'),
    shuffleWriteBytes: attemptSum(rows, 'shuffleWriteBytes'),
  };
}

const ascending = (a: number, b: number): number => a - b;

/** Pairs the stages of two runs. At this stage the pairing is `matchStages`' algorithm over
 * `comparisonIdentity`: stages sharing an identity pair off by sorted id when each run has the same
 * count of them, and every pair is `exact`. */
export function alignStages(baseSnap: SessionSnapshot, candSnap: SessionSnapshot, options: AlignOptions = {}): StageAlignment {
  const normalizer = comparisonDetailNormalizer(options.normalizePath);
  // One walk of the plan per stage serves the bookkeeping test and the identity.
  const index = (snap: SessionSnapshot) => {
    const nodesOf = new Map<number, PlanNode[]>();
    const bookkeeping = new Set<number>();
    for (const [id, stage] of snap.stages) {
      const nodes = planNodesOfStage(stage, snap.sql);
      nodesOf.set(id, nodes);
      if (isDeltaBookkeepingStage(stage, snap.sql, nodes)) bookkeeping.add(id);
    }
    const identities = identityIndexWith(
      snap, (stage, id) => comparisonIdentity(stage, snap, normalizer, nodesOf.get(id)), (id) => !bookkeeping.has(id),
    );
    return { identities, bookkeeping };
  };
  const base = index(baseSnap), cand = index(candSnap);
  const baseBook = base.bookkeeping, candBook = cand.bookkeeping;
  const { pairs: idPairs } = pairEqualCounts(base.identities, cand.identities);

  const baseFigures = new Map<number, Record<PairDeltaMetric, number | null>>();
  const candFigures = new Map<number, Record<PairDeltaMetric, number | null>>();
  const figures = (cache: typeof baseFigures, snap: SessionSnapshot, id: number) => {
    let f = cache.get(id);
    if (!f) { f = stageFigures(snap.stages.get(id)!); cache.set(id, f); }
    return f;
  };

  const pairs: StagePair[] = idPairs
    .map(({ baseId, candId }): StagePair => {
      const b = figures(baseFigures, baseSnap, baseId), c = figures(candFigures, candSnap, candId);
      const deltas = {} as Record<PairDeltaMetric, StageDelta>;
      for (const metric of PAIR_DELTA_METRICS) {
        const [bv, cv] = [b[metric], c[metric]];
        deltas[metric] = { baseline: bv, candidate: cv, delta: bv != null && cv != null ? cv - bv : null };
      }
      return { pairId: `b${baseId}-c${candId}`, baseStageIds: [baseId], candStageIds: [candId], quality: 'exact', score: 1, deltas };
    })
    .sort((x, y) => x.baseStageIds[0] - y.baseStageIds[0] || x.candStageIds[0] - y.candStageIds[0]);

  const pairedBase = new Set(pairs.flatMap((p) => p.baseStageIds));
  const pairedCand = new Set(pairs.flatMap((p) => p.candStageIds));
  const unmatchedOf = (snap: SessionSnapshot, book: Set<number>, paired: Set<number>): number[] =>
    [...snap.stages.keys()].filter((id) => !book.has(id) && !paired.has(id)).sort(ascending);

  // Run time counts every attempt, the same figure the stage-pair deltas and the run totals use.
  const runTime = (cache: typeof baseFigures, snap: SessionSnapshot, id: number): number => figures(cache, snap, id).executorRunTime ?? 0;
  let total = 0, matched = 0;
  for (const id of baseSnap.stages.keys()) {
    if (baseBook.has(id)) continue;
    const t = runTime(baseFigures, baseSnap, id);
    total += t;
    if (pairedBase.has(id)) matched += t;
  }
  for (const id of candSnap.stages.keys()) {
    if (candBook.has(id)) continue;
    const t = runTime(candFigures, candSnap, id);
    total += t;
    if (pairedCand.has(id)) matched += t;
  }

  return {
    pairs,
    unmatched: { baseStageIds: unmatchedOf(baseSnap, baseBook, pairedBase), candStageIds: unmatchedOf(candSnap, candBook, pairedCand) },
    replanned: [],
    bookkeepingStageIds: { baseStageIds: [...baseBook].sort(ascending), candStageIds: [...candBook].sort(ascending) },
    runtimeCoverage: total > 0 ? matched / total : null,
  };
}
