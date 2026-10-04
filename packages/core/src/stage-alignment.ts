// The stage aligner: two snapshots and options in, typed stage pairs out. Pure (no I/O, no
// dependency on the CLI, MCP or UI) and deterministic; swapping baseline and candidate mirrors the
// pairs. `compareRuns` calls it, and every surface that compares runs reads its result
// (`stagePairs`) instead of comparing stage keys.
//
// Pairing runs in two levels (see `alignStages`). The exact key is `comparisonIdentity`: the
// `stageIdentity` recipe run with the comparison normalizer, so the volatile tokens that make two
// runs of one job differ (staging directories, dates, IN-lists, Delta log file counts) and the
// caller's `--normalize-path` patterns do not split a stage in two. A coarser structural key
// (`stage-structure.ts`) and a detail similarity pair what the exact key splits. `stageIdentity`
// itself stays the frozen exact key.

import { normalizeDetail } from './detectors.ts';
import { isDeltaLogRead, scanRelationId } from './plan-summary.ts';
import { withEarlierAttempts, totalExecutorCpuMs } from './run-totals.ts';
import { planNodesOfStage } from './stage-plan-nodes.ts';
import { normalizeStageName, stageIdentityWith, type DetailNormalizer } from './stage-identity.ts';
import { alignSequences } from './sequence-alignment.ts';
import { attributeNames, detailTokens, jaccard, structuralKey } from './stage-structure.ts';
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
];

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
 * printed it, then `normalizeDetail`, then the targeted patches. */
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
  /** `exact`: same comparison key. `structural`: same operator-tree shape, node names and attribute
   * names, different details. `aligned`: different structure but similar details, or no plan to
   * compare and paired by position. */
  quality: 'exact' | 'structural' | 'aligned';
  /** 0-1; 1 for an exact pair, the detail similarity for a structural or aligned one, and
   * `POSITIONAL_SCORE` for a pair made by position alone. */
  score: number;
  deltas: Record<PairDeltaMetric, StageDelta>;
}

/** The stages an aligned execution pair left unpaired when its two sides ran different numbers of
 * stages: a different plan (a broadcast join in place of an exchange and a sort-merge join), not
 * changed work. `deltas` totals each metric over the leftover stages of each side. */
export interface ReplannedGroup {
  baseExecutionId: number;
  candExecutionId: number;
  baseStageIds: number[];
  candStageIds: number[];
  deltas: Record<PairDeltaMetric, StageDelta>;
}

export interface ExecutionAlignment {
  /** SQL executions that ran at least one stage outside the Delta bookkeeping set. */
  baseExecutions: number;
  candExecutions: number;
  /** Executions the sequence alignment paired. */
  pairedExecutions: number;
  /** True when the alignment ran in the band form (see `FULL_ALIGNMENT_MAX_CELLS`). */
  bounded: boolean;
  /** The share of both runs' executions that paired, `2 * pairedExecutions / (baseExecutions +
   * candExecutions)`; null when either run has none. */
  agreement: number | null;
  /** False when `agreement` is below `MIN_EXECUTION_AGREEMENT`: the runs share too little SQL work to
   * be one job, so no stage is paired. */
  accepted: boolean;
}

export interface StageAlignment {
  pairs: StagePair[];
  /** Stages (bookkeeping stages excluded) that paired with nothing and sit in no replanned group. */
  unmatched: { baseStageIds: number[]; candStageIds: number[] };
  /** Aligned execution pairs whose stage counts differ and left stages unpaired. */
  replanned: ReplannedGroup[];
  /** Delta bookkeeping stages: in neither the pairs, the unmatched lists nor the coverage. */
  bookkeepingStageIds: { baseStageIds: number[]; candStageIds: number[] };
  /** Executor run time of the paired stages, plus the replanned ones when
   * `REPLANNED_COUNTS_TOWARD_COVERAGE`, over the total of both runs (bookkeeping excluded); null when
   * that total is zero. */
  runtimeCoverage: number | null;
  executionAlignment: ExecutionAlignment;
}

export interface AlignOptions {
  /** Compiled caller patterns (`compileNormalizePatterns`). */
  normalizePath?: readonly RegExp[];
}

/** An execution pair scores at least this (0-1) on call site, description and plan structure to be
 * matched. */
export const EXECUTION_MATCH_MIN = 0.55;
/** Share of both runs' executions that must pair (see `ExecutionAlignment.agreement`) for the two runs
 * to count as one job. Below it no stage pairs: stages as generic as a `count` or a `collect` repeat
 * across unrelated jobs, and only the surrounding executions tell the jobs apart. */
export const MIN_EXECUTION_AGREEMENT = 0.5;
/** Detail similarity (Jaccard over a stage's name and normalized node text) two stages of different
 * structure need to pair as `aligned`. */
export const ALIGNED_MIN_SIMILARITY = 0.6;
/** Score of a pair made by position alone: no plan evidence backs it. */
export const POSITIONAL_SCORE = 0.5;
/** Execution similarities cached at most (distinct signatures in one run times those in the other). */
const MAX_CACHED_SIMILARITIES = 1_000_000;
/** Leftover stage pairs scored in one execution pair; above it the `aligned` pass is skipped. */
const MAX_STAGE_SIMILARITY_CELLS = 250_000;
/** Whether replanned run time counts in the numerator of `runtimeCoverage` (and so toward the `ok`
 * gate). When false it counts in the denominator only. */
export const REPLANNED_COUNTS_TOWARD_COVERAGE = true;

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

type Figures = Record<PairDeltaMetric, number | null>;

function stageFigures(stage: Stage): Figures {
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

function deltasOf(b: Figures, c: Figures): Record<PairDeltaMetric, StageDelta> {
  const deltas = {} as Record<PairDeltaMetric, StageDelta>;
  for (const metric of PAIR_DELTA_METRICS) {
    const [bv, cv] = [b[metric], c[metric]];
    deltas[metric] = { baseline: bv, candidate: cv, delta: bv != null && cv != null ? cv - bv : null };
  }
  return deltas;
}

/** Each metric summed over several stages' figures; null where no stage recorded it. */
function sumFigures(rows: Figures[]): Figures {
  const total = {} as Figures;
  for (const metric of PAIR_DELTA_METRICS) {
    let sum = 0, present = false;
    for (const row of rows) if (row[metric] != null) { sum += row[metric]!; present = true; }
    total[metric] = present ? sum : null;
  }
  return total;
}

const ascending = (a: number, b: number): number => a - b;

// ---- Per-run index --------------------------------------------------------------------------

// What the aligner knows about one SQL execution (or the pseudo-execution of stages outside any):
// the non-bookkeeping stages it ran and the three things its similarity reads.
interface ExecInfo {
  /** null for the pseudo-execution. */
  id: number | null;
  /** Ascending. */
  stageIds: number[];
  // The three token sets are interned (one integer per distinct string, shared by both runs) and
  // sorted, so a similarity is a merge of integers.
  /** Plan structure: operator and attribute names of the execution's plan (stage keys without a plan). */
  structure: Int32Array;
  /** Call site: user-code frames of the stages' stack traces. */
  frames: Int32Array;
  /** Description tokens. */
  description: Int32Array;
  /** Equal signatures score 1 without a comparison, and a score is cached per signature pair. */
  signature: number;
}

interface RunIndex {
  snap: SessionSnapshot;
  nodesOf: Map<number, PlanNode[]>;
  bookkeeping: Set<number>;
  exactKey: Map<number, string>;
  structuralKey: Map<number, string | null>;
  executions: ExecInfo[];
  pseudo: ExecInfo | null;
}

// Stack frames of the JVM and Spark themselves say nothing about which user code ran.
const FRAMEWORK_FRAME = /^(java|javax|jdk|sun|scala|py4j|org\.apache|io\.delta|io\.netty|com\.sun)\b/;

function userFrames(details: string | undefined): string[] {
  const frames: string[] = [];
  for (const line of (details ?? '').split('\n')) {
    const frame = line.trim().replace(/:\d+\)$/, ')'); // a shifted line number is not a different call site
    if (frame && !FRAMEWORK_FRAME.test(frame)) frames.push(frame);
  }
  return frames;
}

// Directory prefixes carry the run's own paths (a container directory, an application id), so only
// each path's last segment stays in a description.
const descriptionTokens = (text: string, normalizer: DetailNormalizer): string[] =>
  [...new Set(normalizer(text).replace(/\S*\/([^/\s]+)/g, '$1').split(/[^A-Za-z0-9_.$]+/).filter(Boolean))].sort();

// An execution's plan structure: its operator names (a repeated operator counts as often as it
// repeats) and the attribute names its nodes mention, which tell two plans of the same operators
// apart. Neither carries a literal, a path or an id.
function planStructure(root: PlanNode): string[] {
  const tokens: string[] = [];
  const attributes = new Set<string>();
  (function walk(node: PlanNode): void {
    if (!/^(WholeStageCodegen|InputAdapter|ColumnarToRow)\b/.test(node.name ?? '')) {
      tokens.push(normalizeStageName(node.name ?? ''));
      for (const name of attributeNames(node.detail ?? '')) attributes.add(`@${name}`);
    }
    for (const child of node.children ?? []) walk(child);
  })(root);
  return [...tokens, ...attributes].sort();
}

function indexRun(
  snap: SessionSnapshot, normalizer: DetailNormalizer, signatures: Map<string, number>, interned: Map<string, number>,
): RunIndex {
  const intern = (tokens: string[]): Int32Array => {
    const ids = new Int32Array(tokens.length);
    tokens.forEach((t, i) => {
      let id = interned.get(t);
      if (id === undefined) { id = interned.size; interned.set(t, id); }
      ids[i] = id;
    });
    return ids.sort();
  };
  const nodesOf = new Map<number, PlanNode[]>();
  const bookkeeping = new Set<number>();
  const exactKey = new Map<number, string>();
  const structuralKeyOf = new Map<number, string | null>();
  const byExecution = new Map<number | null, number[]>();
  for (const [id, stage] of snap.stages) {
    const nodes = planNodesOfStage(stage, snap.sql);
    nodesOf.set(id, nodes);
    if (isDeltaBookkeepingStage(stage, snap.sql, nodes)) { bookkeeping.add(id); continue; }
    exactKey.set(id, comparisonIdentity(stage, snap, normalizer, nodes));
    structuralKeyOf.set(id, structuralKey(nodes));
    const execId = stage.sqlExecutionId ?? null;
    const ids = byExecution.get(execId);
    if (ids) ids.push(id); else byExecution.set(execId, [id]);
  }
  const info = (execId: number | null, stageIds: number[]): ExecInfo => {
    stageIds.sort(ascending);
    const root = execId === null ? null : snap.sql.get(execId)?.planTree ?? null;
    const structure = root ? planStructure(root)
      : stageIds.map((id) => structuralKeyOf.get(id) ?? `n:${normalizeStageName(snap.stages.get(id)!.name ?? '')}`).sort();
    const frames = [...new Set(stageIds.flatMap((id) => userFrames(snap.stages.get(id)!.details)))].sort();
    const description = execId === null ? [] : descriptionTokens(snap.sql.get(execId)?.description ?? '', normalizer);
    const text = JSON.stringify([structure, frames, description]);
    let signature = signatures.get(text);
    if (signature === undefined) { signature = signatures.size; signatures.set(text, signature); }
    return { id: execId, stageIds, structure: intern(structure), frames: intern(frames), description: intern(description), signature };
  };
  const executions = [...byExecution.keys()].filter((k): k is number => k !== null).sort(ascending)
    .map((execId) => info(execId, byExecution.get(execId)!));
  const pseudoIds = byExecution.get(null);
  return {
    snap, nodesOf, bookkeeping, exactKey, structuralKey: structuralKeyOf, executions,
    pseudo: pseudoIds ? info(null, pseudoIds) : null,
  };
}

// Weights of the three parts of an execution pair's similarity. A part one side lacks (a PySpark
// stack trace has no user frames, a description may be empty) drops out of the mean.
const STRUCTURE_WEIGHT = 4, FRAMES_WEIGHT = 2, DESCRIPTION_WEIGHT = 1;

/** 0-1000 (rounded, so the alignment compares integers). */
function executionSimilarity(a: ExecInfo, b: ExecInfo): number {
  let sum = STRUCTURE_WEIGHT * jaccard(a.structure, b.structure), weight = STRUCTURE_WEIGHT;
  if (a.frames.length > 0 && b.frames.length > 0) { sum += FRAMES_WEIGHT * jaccard(a.frames, b.frames); weight += FRAMES_WEIGHT; }
  if (a.description.length > 0 && b.description.length > 0) {
    sum += DESCRIPTION_WEIGHT * jaccard(a.description, b.description);
    weight += DESCRIPTION_WEIGHT;
  }
  return Math.round((1000 * sum) / weight);
}

// ---- Stage alignment inside one execution pair -----------------------------------------------

interface RawPair { baseId: number; candId: number; quality: StagePair['quality']; score: number }

function alignWithin(
  base: RunIndex, cand: RunIndex, be: ExecInfo, ce: ExecInfo,
  tokens: { base: Map<number, string[]>; cand: Map<number, string[]> }, normalizer: DetailNormalizer,
): { pairs: RawPair[]; leftBase: number[]; leftCand: number[] } {
  const pseudo = be.id === null;
  const freeBase = new Set(be.stageIds), freeCand = new Set(ce.stageIds);
  const pairs: RawPair[] = [];
  const take = (baseId: number, candId: number, quality: RawPair['quality'], score: number) => {
    pairs.push({ baseId, candId, quality, score });
    freeBase.delete(baseId);
    freeCand.delete(candId);
  };
  const tokensOf = (run: RunIndex, cache: Map<number, string[]>, id: number): string[] => {
    let t = cache.get(id);
    if (!t) { const stage = run.snap.stages.get(id)!; t = detailTokens(stage.name, run.nodesOf.get(id)!, normalizer); cache.set(id, t); }
    return t;
  };
  const similarity = (baseId: number, candId: number): number =>
    jaccard(tokensOf(base, tokens.base, baseId), tokensOf(cand, tokens.cand, candId));
  const group = (free: Set<number>, keyOf: (id: number) => string | null): Map<string, number[]> => {
    const groups = new Map<string, number[]>();
    for (const id of [...free].sort(ascending)) {
      const key = keyOf(id);
      if (key === null) continue;
      const ids = groups.get(key);
      if (ids) ids.push(id); else groups.set(key, [id]);
    }
    return groups;
  };
  // Stages sharing a key pair off in id order, as many as both sides have: a self-join's subtree
  // counted three times in one run and twice in the other still pairs two.
  const pairByKey = (
    keyOfBase: (id: number) => string | null, keyOfCand: (id: number) => string | null,
    quality: RawPair['quality'], scoreOf: (baseId: number, candId: number) => number,
  ) => {
    const b = group(freeBase, keyOfBase), c = group(freeCand, keyOfCand);
    for (const key of [...b.keys()].sort()) {
      const candIds = c.get(key);
      if (!candIds) continue;
      const baseIds = b.get(key)!;
      for (let i = 0; i < Math.min(baseIds.length, candIds.length); i++) take(baseIds[i], candIds[i], quality, scoreOf(baseIds[i], candIds[i]));
    }
  };

  // Stages outside any SQL execution have no plan: the stage's own call-site text tells them apart.
  const detailsKey = (run: RunIndex, id: number) => normalizeStageName(normalizer(run.snap.stages.get(id)!.details ?? ''));
  pairByKey(
    (id) => base.exactKey.get(id)! + (pseudo ? `§${detailsKey(base, id)}` : ''),
    (id) => cand.exactKey.get(id)! + (pseudo ? `§${detailsKey(cand, id)}` : ''),
    'exact', () => 1,
  );
  pairByKey((id) => base.structuralKey.get(id) ?? null, (id) => cand.structuralKey.get(id) ?? null, 'structural', similarity);

  // Different structure, similar details: best score first, ties by lower ids.
  const withStructure = (run: RunIndex, free: Set<number>) => [...free].filter((id) => run.structuralKey.get(id) != null).sort(ascending);
  const leftBase = withStructure(base, freeBase), leftCand = withStructure(cand, freeCand);
  if (leftBase.length * leftCand.length <= MAX_STAGE_SIMILARITY_CELLS) {
    const candidates: Array<{ baseId: number; candId: number; score: number }> = [];
    for (const baseId of leftBase) for (const candId of leftCand) {
      const score = similarity(baseId, candId);
      if (score >= ALIGNED_MIN_SIMILARITY) candidates.push({ baseId, candId, score });
    }
    candidates.sort((x, y) => y.score - x.score || x.baseId + x.candId - (y.baseId + y.candId) || x.baseId - y.baseId);
    for (const { baseId, candId, score } of candidates) {
      if (freeBase.has(baseId) && freeCand.has(candId)) take(baseId, candId, 'aligned', score);
    }
  }

  // No plan structure to compare: pair by position among the stages of the same name.
  const byName = (run: RunIndex) => (id: number) =>
    run.structuralKey.get(id) == null ? normalizeStageName(run.snap.stages.get(id)!.name ?? '') : null;
  pairByKey(byName(base), byName(cand), 'aligned', () => POSITIONAL_SCORE);

  return { pairs, leftBase: [...freeBase].sort(ascending), leftCand: [...freeCand].sort(ascending) };
}

/** Pairs the stages of two runs in two levels. SQL executions align first, in submission order, by an
 * order-preserving sequence alignment scored on call site, description and plan structure (the
 * stages outside any execution form one pseudo-execution per run); then the stages of each aligned
 * execution pair align: equal comparison key (`exact`), equal structural key (`structural`), similar
 * details (`aligned`), or position among plan-less stages of one name (`aligned`). Stages an
 * execution pair with different stage counts leaves over are `replanned`; with equal counts they
 * stay `unmatched`. Deterministic, and swapping the runs mirrors the pairs. */
export function alignStages(baseSnap: SessionSnapshot, candSnap: SessionSnapshot, options: AlignOptions = {}): StageAlignment {
  const normalizer = comparisonDetailNormalizer(options.normalizePath);
  const signatures = new Map<string, number>();
  const interned = new Map<string, number>();
  const base = indexRun(baseSnap, normalizer, signatures, interned), cand = indexRun(candSnap, normalizer, signatures, interned);

  // Execution similarity is cached per signature pair, so a loop of identical queries scores once.
  // When the runs hold so many distinct signatures that the cache could not repay its memory, it is off.
  const distinct = (run: RunIndex) => new Set(run.executions.map((e) => e.signature)).size;
  const cached = distinct(base) * distinct(cand) <= MAX_CACHED_SIMILARITIES;
  const cache = new Map<number, number>();
  const similarityOf = (a: ExecInfo, b: ExecInfo): number => {
    if (a.signature === b.signature) return 1000;
    if (!cached) return executionSimilarity(a, b);
    const key = a.signature * signatures.size + b.signature;
    let s = cache.get(key);
    if (s === undefined) { s = executionSimilarity(a, b); cache.set(key, s); }
    return s;
  };
  const sequence = alignSequences(
    base.executions.length, cand.executions.length,
    (i, j) => similarityOf(base.executions[i], cand.executions[j]), Math.round(1000 * EXECUTION_MATCH_MIN),
    (i) => base.executions[i].id!, (j) => cand.executions[j].id!,
  );
  const bothRuns = base.executions.length + cand.executions.length;
  const agreement = base.executions.length > 0 && cand.executions.length > 0 ? (2 * sequence.pairs.length) / bothRuns : null;
  const accepted = agreement === null || agreement >= MIN_EXECUTION_AGREEMENT;

  const executionPairs: Array<[ExecInfo, ExecInfo]> = [];
  if (accepted) {
    for (const [i, j] of sequence.pairs) executionPairs.push([base.executions[i], cand.executions[j]]);
    if (base.pseudo && cand.pseudo) executionPairs.push([base.pseudo, cand.pseudo]);
  }

  const baseFigures = new Map<number, Figures>(), candFigures = new Map<number, Figures>();
  const figures = (cache: Map<number, Figures>, snap: SessionSnapshot, id: number): Figures => {
    let f = cache.get(id);
    if (!f) { f = stageFigures(snap.stages.get(id)!); cache.set(id, f); }
    return f;
  };
  const figuresOf = (side: 'base' | 'cand', ids: number[]): Figures[] =>
    ids.map((id) => side === 'base' ? figures(baseFigures, baseSnap, id) : figures(candFigures, candSnap, id));

  const tokens = { base: new Map<number, string[]>(), cand: new Map<number, string[]>() };
  const pairs: StagePair[] = [];
  const replanned: ReplannedGroup[] = [];
  for (const [be, ce] of executionPairs) {
    const result = alignWithin(base, cand, be, ce, tokens, normalizer);
    for (const { baseId, candId, quality, score } of result.pairs) {
      pairs.push({
        pairId: `b${baseId}-c${candId}`, baseStageIds: [baseId], candStageIds: [candId], quality, score,
        deltas: deltasOf(figures(baseFigures, baseSnap, baseId), figures(candFigures, candSnap, candId)),
      });
    }
    // Different stage counts under one aligned execution: the plan changed, not the work. The
    // pseudo-execution has no plan to re-plan, so its leftovers stay unmatched.
    const leftover = result.leftBase.length + result.leftCand.length > 0;
    if (leftover && be.id !== null && ce.id !== null && be.stageIds.length !== ce.stageIds.length) {
      replanned.push({
        baseExecutionId: be.id, candExecutionId: ce.id, baseStageIds: result.leftBase, candStageIds: result.leftCand,
        deltas: deltasOf(sumFigures(figuresOf('base', result.leftBase)), sumFigures(figuresOf('cand', result.leftCand))),
      });
    }
  }
  pairs.sort((x, y) => x.baseStageIds[0] - y.baseStageIds[0] || x.candStageIds[0] - y.candStageIds[0]);
  replanned.sort((x, y) => x.baseExecutionId - y.baseExecutionId || x.candExecutionId - y.candExecutionId);

  const pairedBase = new Set(pairs.flatMap((p) => p.baseStageIds));
  const pairedCand = new Set(pairs.flatMap((p) => p.candStageIds));
  const replannedBase = new Set(replanned.flatMap((g) => g.baseStageIds));
  const replannedCand = new Set(replanned.flatMap((g) => g.candStageIds));
  const unmatchedOf = (snap: SessionSnapshot, book: Set<number>, paired: Set<number>, replannedIds: Set<number>): number[] =>
    [...snap.stages.keys()].filter((id) => !book.has(id) && !paired.has(id) && !replannedIds.has(id)).sort(ascending);

  // Run time counts every attempt, the same figure the stage-pair deltas and the run totals use.
  let total = 0, matched = 0;
  const tally = (cache: Map<number, Figures>, snap: SessionSnapshot, book: Set<number>, paired: Set<number>, replannedIds: Set<number>) => {
    for (const id of snap.stages.keys()) {
      if (book.has(id)) continue;
      const t = figures(cache, snap, id).executorRunTime ?? 0;
      total += t;
      if (paired.has(id) || (REPLANNED_COUNTS_TOWARD_COVERAGE && replannedIds.has(id))) matched += t;
    }
  };
  tally(baseFigures, baseSnap, base.bookkeeping, pairedBase, replannedBase);
  tally(candFigures, candSnap, cand.bookkeeping, pairedCand, replannedCand);

  return {
    pairs,
    unmatched: {
      baseStageIds: unmatchedOf(baseSnap, base.bookkeeping, pairedBase, replannedBase),
      candStageIds: unmatchedOf(candSnap, cand.bookkeeping, pairedCand, replannedCand),
    },
    replanned,
    bookkeepingStageIds: { baseStageIds: [...base.bookkeeping].sort(ascending), candStageIds: [...cand.bookkeeping].sort(ascending) },
    runtimeCoverage: total > 0 ? matched / total : null,
    executionAlignment: {
      baseExecutions: base.executions.length, candExecutions: cand.executions.length,
      pairedExecutions: sequence.pairs.length, bounded: sequence.bounded, agreement, accepted,
    },
  };
}
