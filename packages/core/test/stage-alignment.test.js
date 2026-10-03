import { describe, it, expect } from 'vitest';
import {
  alignStages, comparisonDetailNormalizer, comparisonIdentity, compileNormalizePatterns,
  isDeltaBookkeepingStage, NORMALIZE_PATH_TOKEN, MAX_NORMALIZE_PATTERN_LENGTH, MAX_NORMALIZE_PATTERNS,
} from '../src/stage-alignment.js';
import { stageIdentity, compareRuns } from '../src/run-comparison.js';

// ---- Synthetic snapshots. Every name, path and id below is invented. ----

const node = (name, detail, stageIds, children = []) => ({ name, detail, metrics: [], children, stageIds });

// One SQL execution (id 1) per snapshot; `plans` maps a stage id to the plan nodes it ran.
function snapshotOf(stageSpecs, app = { name: 'job' }) {
  const stages = new Map();
  const sql = new Map();
  for (const spec of stageSpecs) {
    const { id, name = `Stage ${id}`, nodes = null, sqlExecutionId = nodes ? 1 : null, ...figures } = spec;
    stages.set(id, { id, name, sqlExecutionId, executorRunTime: 100, ...figures });
    if (nodes) {
      const existing = sql.get(sqlExecutionId)?.planTree;
      const children = [...(existing?.children ?? []), ...nodes];
      sql.set(sqlExecutionId, { planTree: { name: 'Root', detail: '', metrics: [], children } });
    }
  }
  return { app, stages, sql, jobs: new Map(), catalog: [], executors: { added: [], removed: [] } };
}

const pairsOf = (alignment) => alignment.pairs.map((p) => [p.baseStageIds[0], p.candStageIds[0]]);
const normalize = comparisonDetailNormalizer();

describe('comparison normalizer patches', () => {
  it('rewrites a random staging directory segment but keeps an ordinary directory name', () => {
    expect(normalize('Location: InMemoryFileIndex[hdfs://ns/staging/aB3xYz/out.parquet]'))
      .toBe(normalize('Location: InMemoryFileIndex[hdfs://ns/staging/Qr7mTn/out.parquet]'));
    expect(normalize('/warehouse/orders/x')).not.toBe(normalize('/warehouse/returns/x'));
    expect(normalize('/warehouse/orders/x')).toBe(normalize('/warehouse/orders/x'));
  });

  it('also rewrites a real 6-8 character directory that mixes letters and digits (documented limit)', () => {
    // `/output01/` looks like a staging directory to the heuristic, so two runs that differ only
    // in such a segment pair. An all-lowercase or all-caps name survives.
    expect(normalize('/data/output01/x')).toBe(normalize('/data/output02/x'));
    expect(normalize('/data/outputs/x')).not.toBe(normalize('/data/outputz/x'));
    expect(normalize('/data/OUTPUTS/x')).not.toBe(normalize('/data/OUTPUTZ/x'));
  });

  it('rewrites dates and timestamps', () => {
    expect(normalize("isnotnull(d#1) AND (d#1 <= 2026-01-15)")).toBe(normalize("isnotnull(d#1) AND (d#1 <= 2026-02-03)"));
    expect(normalize("ts <= 2026-01-15 10:11:12.123")).toBe(normalize("ts <= 2026-02-03 01:02:03"));
  });

  it('collapses IN lists and INSET lists of any length', () => {
    expect(normalize('d IN (2026-01-01,2026-01-02)')).toBe(normalize('d IN (2026-01-01,2026-01-02,2026-01-03)'));
    expect(normalize('x IN (a,b)')).toBe(normalize('x IN (a,b,c,d)'));
    expect(normalize('(d#1 INSET 2026-01-01, 2026-01-02)')).toBe(normalize('(d#1 INSET 2026-01-01, 2026-01-02, 2026-01-03)'));
  });

  it('rewrites file counts in a file index', () => {
    expect(normalize('Location: DeltaLogFileIndex(4 paths)[a]')).toBe(normalize('Location: DeltaLogFileIndex(8 paths)[a]'));
    expect(normalize('InMemoryFileIndex(12 paths)')).toBe(normalize('InMemoryFileIndex(3 paths)'));
  });

  it('treats a column list as an unordered bag', () => {
    expect(normalize('Expand [[a, b, 0], [a, null, 1]], [a, gid]')).toBe(normalize('Expand [[b, a, 0], [null, a, 1]], [gid, a]'));
  });

  it('ignores the order of entries in a bracketed list only', () => {
    expect(normalize('Project [a#1, b#2, c#3]')).toBe(normalize('Project [c#3, a#1, b#2]'));
    expect(normalize('Project [a#1, b#2]')).not.toBe(normalize('Project [a#1, b#3]'));
  });

  it('keeps comparison and arithmetic operators and parentheses in the key', () => {
    expect(normalize('Filter (x#1 > 5)')).not.toBe(normalize('Filter (x#1 < 5)'));
    expect(normalize('Filter (x#1 > 5)')).not.toBe(normalize('Filter (x#1 >= 5)'));
    expect(normalize('Project [(a#1 + b#2) AS c#3]')).not.toBe(normalize('Project [(a#1 - b#2) AS c#3]'));
    expect(normalize('Filter ((a#1 > 1) AND (b#2 < 2))')).not.toBe(normalize('Filter (a#1 > 1) AND ((b#2 < 2))'));
  });

  it('keeps distinct details distinct: no blanket numeric, path or quoted-literal stripping', () => {
    expect(normalize('Filter (amount#1 > 5)')).not.toBe(normalize('Filter (amount#1 > 7)'));
    expect(normalize("Filter (region#1 = 'north')")).not.toBe(normalize("Filter (region#1 = 'south')"));
    expect(normalize('Location: [hdfs://ns/a/b/in.parquet]')).not.toBe(normalize('Location: [hdfs://ns/a/c/in.parquet]'));
  });
});

describe('caller-supplied normalize patterns', () => {
  it('replaces every match with a fixed token, and only the matched substring', () => {
    const n = comparisonDetailNormalizer(compileNormalizePatterns(['sandbox/[a-z0-9]+/run']));
    // Caller patterns run on the raw text; the token in the output proves both matches were replaced.
    const out = n('Location: [/sandbox/baseline/run1, /sandbox/c07b/run2] Write');
    expect(out.match(new RegExp(NORMALIZE_PATH_TOKEN, 'g'))).toHaveLength(2);
    expect(out).toMatch(/\bWrite\b/);
    expect(out).not.toContain('baseline');
    expect(n('Location: [/sandbox/baseline/run1, /sandbox/c07b/run2] Write'))
      .toBe(n('Location: [/sandbox/c07b/run1, /sandbox/baseline/run2] Write'));
  });

  it('rejects an invalid, over-long, empty-matching or too many patterns with a clear message', () => {
    expect(() => compileNormalizePatterns(['(unclosed'])).toThrow(/"\(unclosed" is not a valid regular expression/);
    expect(() => compileNormalizePatterns(['x'.repeat(MAX_NORMALIZE_PATTERN_LENGTH + 1)])).toThrow(/limit is/);
    expect(() => compileNormalizePatterns(['a*'])).toThrow(/matches the empty string/);
    expect(() => compileNormalizePatterns([''])).toThrow(/non-empty/);
    expect(() => compileNormalizePatterns(Array.from({ length: MAX_NORMALIZE_PATTERNS + 1 }, () => 'x'))).toThrow(/At most/);
    expect(compileNormalizePatterns(undefined)).toEqual([]);
  });
});

describe('alignStages: a pair of runs differing in one volatile token still pairs', () => {
  const scan = (stageId, detail) => node('Scan parquet', detail, [stageId]);

  it('pairs a write stage whose output directory is random per run', () => {
    const base = snapshotOf([{ id: 3, name: 'save at X.java:0', nodes: [node('Execute InsertIntoHadoopFsRelationCommand', 'hdfs://ns/staging/aB3xYz/out.parquet, Overwrite', [3])] }]);
    const cand = snapshotOf([{ id: 9, name: 'save at X.java:0', nodes: [node('Execute InsertIntoHadoopFsRelationCommand', 'hdfs://ns/staging/Qr7mTn/out.parquet, Overwrite', [9])] }]);
    expect(stageIdentity(base.stages.get(3), base)).not.toBe(stageIdentity(cand.stages.get(9), cand)); // the exact key splits them
    expect(pairsOf(alignStages(base, cand))).toEqual([[3, 9]]);
  });

  it.each([
    ['a run date in a predicate', 'Filter (event_date#1 <= 2026-01-15)', 'Filter (event_date#1 <= 2026-01-16)'],
    ['an INSET date list that gains an element', 'Filter d#1 INSET 2026-01-01, 2026-01-02)', 'Filter d#1 INSET 2026-01-01, 2026-01-02, 2026-01-03)'],
    ['Delta log file counts', 'FileScan parquet [a#1] Location: PreparedDeltaFileIndex(4 paths)[x]', 'FileScan parquet [a#1] Location: PreparedDeltaFileIndex(8 paths)[x]'],
    ['grouping columns in another order', 'Expand [[a#1, b#2, 0], [a#1, null, 1]], [a#1, b#2, gid#3]', 'Expand [[b#2, a#1, 0], [null, a#1, 1]], [b#2, a#1, gid#3]'],
  ])('pairs stages differing only in %s', (_label, baseDetail, candDetail) => {
    const base = snapshotOf([{ id: 1, name: 'Exchange 1', nodes: [node('Filter', baseDetail, [1])] }]);
    const cand = snapshotOf([{ id: 5, name: 'Exchange 2', nodes: [node('Filter', candDetail, [5])] }]);
    expect(stageIdentity(base.stages.get(1), base)).not.toBe(stageIdentity(cand.stages.get(5), cand));
    const result = alignStages(base, cand);
    expect(pairsOf(result)).toEqual([[1, 5]]);
    expect(result.pairs[0]).toMatchObject({ quality: 'exact', score: 1 });
    expect(result.runtimeCoverage).toBe(1);
  });

  it('does not fuse distinct stages of one run that differ in a numeric literal', () => {
    const base = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [node('Filter', 'amount#1 > 5', [1])] },
      { id: 2, name: 'Exchange 2', nodes: [node('Filter', 'amount#1 > 7', [2])] },
    ]);
    const normalizer = comparisonDetailNormalizer();
    expect(comparisonIdentity(base.stages.get(1), base, normalizer)).not.toBe(comparisonIdentity(base.stages.get(2), base, normalizer));
  });

  it('applies a caller pattern to a path the built-in patches do not recognise', () => {
    const detail = (variant) => `Location: [/sandbox/session-9/${variant}/batch-4/out]`;
    const base = snapshotOf([{ id: 1, name: 'save at X.java:0', nodes: [scan(1, detail('baseline'))] }]);
    const cand = snapshotOf([{ id: 2, name: 'save at X.java:0', nodes: [scan(2, detail('c07b'))] }]);
    expect(alignStages(base, cand).pairs).toHaveLength(0);
    const aligned = alignStages(base, cand, { normalizePath: compileNormalizePatterns(['/sandbox/session-9/[a-z0-9]+/']) });
    expect(pairsOf(aligned)).toEqual([[1, 2]]);
  });

  it('leaves a re-planned stage unpaired and reports no replanned group', () => {
    // SortMergeJoin in one run, BroadcastHashJoin (no exchange stage) in the other.
    const base = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [node('Exchange', 'hashpartitioning(k#1, 200)', [1])] },
      { id: 2, name: 'Exchange 2', nodes: [node('Exchange', 'hashpartitioning(j#2, 200)', [2])] },
      { id: 3, name: 'save at X.java:0', nodes: [node('SortMergeJoin', '[k#1], [k#2], Inner', [3])] },
    ]);
    const cand = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [node('Exchange', 'hashpartitioning(k#1, 200)', [1])] },
      { id: 2, name: 'save at X.java:0', nodes: [node('BroadcastHashJoin', '[k#1], [k#2], Inner, BuildRight', [2])] },
    ]);
    const result = alignStages(base, cand);
    expect(pairsOf(result)).toEqual([[1, 1]]);
    expect(result.unmatched).toEqual({ baseStageIds: [2, 3], candStageIds: [2] });
    expect(result.replanned).toEqual([]);
  });

  it('leaves a loop run 14 times against 15 times unpaired (equal-count rule)', () => {
    const loop = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: 'collect at X.java:0', nodes: [scan(i + 1, 'Location: [/data/in]')] }));
    const result = alignStages(snapshotOf(loop(14)), snapshotOf(loop(15)));
    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched.baseStageIds).toHaveLength(14);
    expect(result.unmatched.candStageIds).toHaveLength(15);
    expect(result.runtimeCoverage).toBe(0);
  });
});

describe('alignStages: pairing properties', () => {
  const build = (ids) => snapshotOf(ids.map((id, i) => ({ id, name: `Exchange ${i}`, nodes: [node('Filter', `col#${i} > 1`, [id])], executorRunTime: 10 * (i + 1) })));

  it('pairs a run with itself, every stage with itself, at full runtime coverage', () => {
    const run = build([4, 5, 6]);
    const result = alignStages(run, run);
    expect(pairsOf(result)).toEqual([[4, 4], [5, 5], [6, 6]]);
    expect(result.pairs.every((p) => p.quality === 'exact' && p.score === 1)).toBe(true);
    expect(result.runtimeCoverage).toBe(1);
    expect(result.unmatched).toEqual({ baseStageIds: [], candStageIds: [] });
    expect(result.replanned).toEqual([]);
  });

  it('is symmetric: swapping baseline and candidate mirrors the pairs', () => {
    const a = build([1, 2, 3]);
    const b = snapshotOf([
      { id: 10, name: 'Exchange 2', nodes: [node('Filter', 'col#2 > 1', [10])] },
      { id: 11, name: 'Exchange 0', nodes: [node('Filter', 'col#0 > 1', [11])] },
      { id: 12, name: 'Extra', nodes: [node('Filter', 'other', [12])] },
    ]);
    const forward = alignStages(a, b), backward = alignStages(b, a);
    expect(pairsOf(backward).map(([x, y]) => [y, x]).sort((p, q) => p[0] - q[0])).toEqual(pairsOf(forward));
    expect(forward.unmatched.candStageIds).toEqual(backward.unmatched.baseStageIds);
    expect(forward.runtimeCoverage).toBeCloseTo(backward.runtimeCoverage);
  });

  it('is deterministic: two runs of the matcher give identical output', () => {
    const a = build([1, 2, 3]), b = build([7, 8, 9]);
    expect(JSON.stringify(alignStages(a, b))).toBe(JSON.stringify(alignStages(a, b)));
  });

  it('gives a pair a stable pairId from its stage ids', () => {
    expect(alignStages(build([1]), build([7])).pairs[0].pairId).toBe('b1-c7');
  });

  it('reports the share of executor run time in paired stages and lists unmatched stages', () => {
    const base = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [node('Filter', 'a', [1])], executorRunTime: 100 },
      { id: 2, name: 'Heavy 1', nodes: [node('Filter', 'only-base', [2])], executorRunTime: 700 },
    ]);
    const cand = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [node('Filter', 'a', [1])], executorRunTime: 100 },
      { id: 2, name: 'Heavy 1', nodes: [node('Filter', 'only-cand', [2])], executorRunTime: 100 },
    ]);
    const result = alignStages(base, cand);
    expect(result.unmatched).toEqual({ baseStageIds: [2], candStageIds: [2] });
    expect(result.runtimeCoverage).toBeCloseTo(200 / 1000);
  });

  it('reports null runtime coverage when no stage recorded run time', () => {
    const run = snapshotOf([{ id: 1, nodes: [node('Filter', 'a', [1])], executorRunTime: undefined }]);
    expect(alignStages(run, run).runtimeCoverage).toBeNull();
    expect(alignStages(snapshotOf([]), snapshotOf([])).runtimeCoverage).toBeNull();
  });
});

describe('alignStages: pair deltas count every attempt', () => {
  const figures = (over) => ({
    executorRunTime: 100, executorCpuTime: 2_000_000, memoryBytesSpilled: 10, diskBytesSpilled: 5,
    inputBytes: 1000, outputBytes: 500, shuffleReadBytes: 40, shuffleWriteBytes: 30, ...over,
  });
  const attempt = (over) => ({
    taskCount: 1, failedTasks: 1, wastedAttempts: 0, jvmGCTime: 0, outputRecords: null, peakExecutionMemoryMax: 0,
    ...figures({}), durationMs: 10, ...over,
  });

  it('includes a failed earlier attempt and late attempt work in the executorRunTime delta', () => {
    const base = snapshotOf([{ id: 1, ...figures({}) }]);
    const cand = snapshotOf([{
      id: 1, ...figures({ executorRunTime: 60 }),
      earlierAttempts: attempt({ executorRunTime: 40 }),
      lateAttemptWork: attempt({ executorRunTime: 7 }),
    }]);
    const [pair] = alignStages(base, cand).pairs;
    // 60 (latest attempt) + 40 (failed earlier attempt) + 7 (late tasks) = 107, against 100.
    expect(pair.deltas.executorRunTime).toEqual({ baseline: 100, candidate: 107, delta: 7 });
    expect(pair.deltas.shuffleReadBytes).toEqual({ baseline: 40, candidate: 120, delta: 80 });
    // The stage record itself is untouched: detectors still read the latest attempt.
    expect(cand.stages.get(1).executorRunTime).toBe(60);
  });

  it('reports CPU time in ms and null where no stage recorded it', () => {
    const base = snapshotOf([{ id: 1, ...figures({ executorCpuTime: 3_000_000 }) }]);
    const cand = snapshotOf([{ id: 1, ...figures({ executorCpuTime: 0 }) }]);
    expect(alignStages(base, cand).pairs[0].deltas.executorCpuTime).toEqual({ baseline: 3, candidate: null, delta: null });
  });

  it('returns every delta metric', () => {
    const run = snapshotOf([{ id: 1, ...figures({}) }]);
    expect(Object.keys(alignStages(run, run).pairs[0].deltas)).toEqual([
      'executorRunTime', 'executorCpuTime', 'memoryBytesSpilled', 'diskBytesSpilled',
      'inputBytes', 'outputBytes', 'shuffleReadBytes', 'shuffleWriteBytes',
    ]);
  });

  it('feeds the run total and the pair the same figure for one run', () => {
    const run = snapshotOf([{ id: 1, ...figures({ executorRunTime: 60 }), earlierAttempts: attempt({ executorRunTime: 40 }) }]);
    const result = compareRuns({ label: 'b', snapshot: run }, { label: 'c', snapshot: run });
    expect(result.stagePairs[0].deltas.executorRunTime.baseline)
      .toBe(result.metrics.find((m) => m.key === 'executorRunTime').baseline);
  });
});

describe('Delta bookkeeping stages', () => {
  const logScan = (stageId, files = 4) => node('Scan parquet ', `FileScan parquet [commitInfo#1,add#2] Location: DeltaLogFileIndex(${files} paths)[hdfs://ns/t/_delta_log]`, [stageId]);
  const tableScan = (stageId) => node('Scan parquet spark_catalog.db.sales', 'FileScan parquet spark_catalog.db.sales[a#1] Location: PreparedDeltaFileIndex(2 paths)[x]', [stageId]);

  it('flags a stage whose scans only read the Delta log', () => {
    const run = snapshotOf([{ id: 1, nodes: [logScan(1), node('Filter', 'isnotnull(add#2)', [1])] }]);
    expect(isDeltaBookkeepingStage(run.stages.get(1), run.sql)).toBe(true);
  });

  it('does not flag a stage that also reads a real table, has no scan, or has no attributed nodes', () => {
    const run = snapshotOf([
      { id: 1, nodes: [logScan(1), tableScan(1)] },
      { id: 2, nodes: [node('Filter', 'x', [2])] },
      { id: 3 },
      { id: 4, nodes: [tableScan(4)] },
    ]);
    for (const id of [1, 2, 3, 4]) expect(isDeltaBookkeepingStage(run.stages.get(id), run.sql)).toBe(false);
  });

  it('keeps bookkeeping stages out of the pairs, the unmatched lists and the coverage', () => {
    const base = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [node('Filter', 'real', [1])], executorRunTime: 98 },
      { id: 2, name: 'Scan 2', nodes: [logScan(2, 4)], executorRunTime: 2 },
    ]);
    const cand = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [node('Filter', 'real', [1])], executorRunTime: 98 },
      { id: 2, name: 'Scan 2', nodes: [logScan(2, 8)], executorRunTime: 2 },
      { id: 3, name: 'Scan 3', nodes: [logScan(3, 8)], executorRunTime: 5 },
    ]);
    const result = alignStages(base, cand);
    expect(pairsOf(result)).toEqual([[1, 1]]);
    expect(result.bookkeepingStageIds).toEqual({ baseStageIds: [2], candStageIds: [2, 3] });
    expect(result.unmatched).toEqual({ baseStageIds: [], candStageIds: [] });
    expect(result.runtimeCoverage).toBe(1);
  });
});

describe('over-merge: comparisonIdentity does not fuse stages that stageIdentity separates', () => {
  it('keeps a stage that differs in a join key distinct, and never fuses two stages of one run', () => {
    const run = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [node('SortMergeJoin', '[id#1], [id#2], Inner', [1])] },
      { id: 2, name: 'Exchange 2', nodes: [node('SortMergeJoin', '[name#7], [name#8], Inner', [2])] },
    ]);
    const normalizer = comparisonDetailNormalizer();
    const keys = new Set([1, 2].map((id) => comparisonIdentity(run.stages.get(id), run, normalizer)));
    expect(keys.size).toBe(2);
  });
});
