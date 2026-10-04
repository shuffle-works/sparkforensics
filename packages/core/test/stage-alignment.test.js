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
      sql.set(sqlExecutionId, { id: sqlExecutionId, description: 'save at X.java:0', planTree: { name: 'Root', detail: '', metrics: [], children } });
    }
  }
  return { app, stages, sql, jobs: new Map(), catalog: [], executors: { added: [], removed: [] } };
}

// Several SQL executions in submission order. `executions`: [{ id, description, stages: [spec] }]; each
// stage's plan nodes sit under that execution's own plan root.
function snapshotOfExecutions(executions, app = { name: 'job' }) {
  const stages = new Map();
  const sql = new Map();
  for (const { id, description = 'save at X.java:0', stages: specs } of executions) {
    const children = [];
    for (const spec of specs) {
      const { id: stageId, name = `Stage ${stageId}`, nodes = [], ...figures } = spec;
      stages.set(stageId, { id: stageId, name, sqlExecutionId: id, executorRunTime: 100, ...figures });
      children.push(...nodes);
    }
    sql.set(id, { id, description, planTree: { name: 'Root', detail: '', metrics: [], children } });
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

  it('does not normalize the order of a column list', () => {
    expect(normalize('Expand [[a, b, 0], [a, null, 1]], [a, gid]')).not.toBe(normalize('Expand [[b, a, 0], [null, a, 1]], [gid, a]'));
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
    expect(alignStages(base, cand).pairs.map((p) => p.quality)).toEqual(['structural']);
    const aligned = alignStages(base, cand, { normalizePath: compileNormalizePatterns(['/sandbox/session-9/[a-z0-9]+/']) });
    expect(pairsOf(aligned)).toEqual([[1, 2]]);
    expect(aligned.pairs[0].quality).toBe('exact');
  });

  it('reports the stages a re-plan leaves over as one replanned group, not as unmatched', () => {
    // SortMergeJoin with two exchange stages in one run, BroadcastHashJoin and no exchange stage in the other.
    const base = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [scan(1, 'a#1'), node('Exchange', 'hashpartitioning(k#1, 200)', [1])], executorRunTime: 10 },
      { id: 2, name: 'Exchange 2', nodes: [scan(2, 'b#2'), node('Exchange', 'hashpartitioning(k#2, 200)', [2])], executorRunTime: 20, shuffleWriteBytes: 7 },
      { id: 3, name: 'save at X.java:0', nodes: [node('SortMergeJoin', '[k#1], [k#2], Inner', [3]), node('Project', 'k#1, v#3', [3])], executorRunTime: 30 },
    ]);
    const cand = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [scan(1, 'a#1'), node('Exchange', 'hashpartitioning(k#1, 200)', [1])], executorRunTime: 10 },
      { id: 2, name: 'save at X.java:0', nodes: [node('BroadcastHashJoin', '[k#1], [k#2], Inner, BuildRight', [2]), node('Project', 'k#1, v#3', [2])], executorRunTime: 12 },
    ]);
    const result = alignStages(base, cand);
    // The shared exchange pairs exactly, the join stage pairs across its two implementations, and the
    // second exchange stage, which the broadcast join made unnecessary, is the leftover.
    expect(result.pairs.map((p) => [p.baseStageIds[0], p.candStageIds[0], p.quality])).toEqual([[1, 1, 'exact'], [3, 2, 'aligned']]);
    expect(result.unmatched).toEqual({ baseStageIds: [], candStageIds: [] });
    expect(result.replanned).toHaveLength(1);
    const [group] = result.replanned;
    expect([group.baseExecutionId, group.candExecutionId]).toEqual([1, 1]);
    expect([group.baseStageIds, group.candStageIds]).toEqual([[2], []]);
    expect(group.deltas.executorRunTime).toEqual({ baseline: 20, candidate: null, delta: null });
    expect(group.deltas.shuffleWriteBytes).toEqual({ baseline: 7, candidate: null, delta: null });
    // Paired plus replanned run time over the total of both runs.
    expect(result.runtimeCoverage).toBe(1);
  });

  it('leaves stages unmatched when an aligned execution pair has equal stage counts', () => {
    const base = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [node('Exchange', 'hashpartitioning(k#1, 200)', [1])] },
      { id: 2, name: 'save at X.java:0', nodes: [node('SortMergeJoin', '[k#1], [k#2], Inner', [2])] },
    ]);
    const cand = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [node('Exchange', 'hashpartitioning(k#1, 200)', [1])] },
      { id: 2, name: 'collect at Y.java:0', nodes: [node('Window', 'row_number() over (partition by z#9)', [2])] },
    ]);
    for (const snap of [base, cand]) snap.sql.get(1).description = 'save at X.java:0';
    const result = alignStages(base, cand);
    expect(pairsOf(result)).toEqual([[1, 1]]);
    expect(result.replanned).toEqual([]);
    expect(result.unmatched).toEqual({ baseStageIds: [2], candStageIds: [2] });
  });

  it('does not report a replanned group for the stages outside any SQL execution', () => {
    const base = snapshotOf([{ id: 1, name: 'map at a.py:1' }, { id: 2, name: 'reduce at a.py:9' }]);
    const cand = snapshotOf([{ id: 1, name: 'map at a.py:1' }]);
    const result = alignStages(base, cand);
    expect(pairsOf(result)).toEqual([[1, 1]]);
    expect(result.replanned).toEqual([]);
    expect(result.unmatched).toEqual({ baseStageIds: [2], candStageIds: [] });
  });
});

describe('alignStages: executions align first', () => {
  const loop = (count, first = 1) => Array.from({ length: count }, (_, i) => ({
    id: i, stages: [{ id: first + i, name: 'collect at X.java:0', nodes: [scan(first + i, 'Location: [/data/in]')] }],
  }));
  const scan = (stageId, detail) => node('Scan parquet', detail, [stageId]);

  it('pairs 14 iterations of a loop that ran 14 times in one run and 15 in the other', () => {
    const base = snapshotOfExecutions(loop(14)), cand = snapshotOfExecutions(loop(15));
    const result = alignStages(base, cand);
    expect(result.pairs).toHaveLength(14);
    expect(pairsOf(result)).toEqual(Array.from({ length: 14 }, (_, i) => [i + 1, i + 1]));
    expect(result.pairs.every((p) => p.quality === 'exact')).toBe(true);
    // The extra run's last iteration is the one left over.
    expect(result.unmatched).toEqual({ baseStageIds: [], candStageIds: [15] });
    expect(result.executionAlignment).toMatchObject({ baseExecutions: 14, candExecutions: 15, pairedExecutions: 14, bounded: false, accepted: true });
    expect(result.runtimeCoverage).toBeCloseTo(2800 / 2900);
  });

  it('mirrors that alignment when the runs swap', () => {
    const forward = alignStages(snapshotOfExecutions(loop(14)), snapshotOfExecutions(loop(15)));
    const backward = alignStages(snapshotOfExecutions(loop(15)), snapshotOfExecutions(loop(14)));
    expect(pairsOf(backward)).toEqual(pairsOf(forward));
    expect(backward.unmatched).toEqual({ baseStageIds: [15], candStageIds: [] });
  });

  it('keeps pairing across an execution one run has and the other lacks', () => {
    const q = (id, stageId, col) => ({ id, description: `save at job.py:${id}`, stages: [{ id: stageId, nodes: [node('Filter', `${col}#1 > 1`, [stageId])] }] });
    const base = snapshotOfExecutions([q(0, 1, 'a'), q(1, 2, 'b'), q(2, 3, 'c')]);
    const cand = snapshotOfExecutions([q(0, 1, 'a'), q(2, 2, 'c')]);
    const result = alignStages(base, cand);
    expect(pairsOf(result)).toEqual([[1, 1], [3, 2]]);
    expect(result.unmatched).toEqual({ baseStageIds: [2], candStageIds: [] });
  });

  it('scores executions on call site, description and plan structure, not on description alone', () => {
    // Two executions share a generic description; only their plans tell them apart.
    const e = (id, stageId, op) => ({ id, description: 'save at NativeMethodAccessorImpl.java:0', stages: [{ id: stageId, nodes: [node(op, `${op.toLowerCase()}#1`, [stageId])] }] });
    const base = snapshotOfExecutions([e(0, 1, 'Sort'), e(1, 2, 'Window')]);
    const cand = snapshotOfExecutions([e(0, 1, 'Window'), e(1, 2, 'Sort')]);
    // Order-preserving: the two matches cross, so at most one of them can pair.
    expect(alignStages(base, cand).pairs).toHaveLength(1);
  });

  it('pairs no stage when the runs share too little SQL work to be one job', () => {
    const generic = (stageId, extra) => ({ id: stageId, name: 'count at NativeMethodAccessorImpl.java:0', nodes: [node('HashAggregate', 'keys=[], functions=[count(1)]', [stageId]), ...extra] });
    const lonely = (id, stageId, tag) => ({ id, description: `save at ${tag}.py:1`, stages: [{ id: stageId, nodes: [node('Project', `${tag}_col#1`, [stageId])] }] });
    const shared = { id: 5, description: 'count at NativeMethodAccessorImpl.java:0', stages: [generic(9, [])] };
    const base = snapshotOfExecutions([lonely(0, 1, 'a'), lonely(1, 2, 'b'), lonely(2, 3, 'c'), shared]);
    const cand = snapshotOfExecutions([lonely(0, 1, 'x'), lonely(1, 2, 'y'), lonely(2, 3, 'z'), { ...shared, stages: [generic(9, [])] }]);
    const result = alignStages(base, cand);
    expect(result.executionAlignment).toMatchObject({ pairedExecutions: 1, agreement: 0.25, accepted: false });
    expect(result.pairs).toEqual([]);
    expect(result.runtimeCoverage).toBe(0);
  });

  it('reports the bounded form when the alignment table is too large to run in full', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ id: i, description: `save at q${i % 7}.py:0`, stages: [{ id: i, name: `s${i % 7}`, nodes: [node('Filter', `c${i % 7}#1 > 1`, [i])] }] }));
    const result = alignStages(snapshotOfExecutions(many(1100)), snapshotOfExecutions(many(1100)));
    expect(result.executionAlignment).toMatchObject({ baseExecutions: 1100, pairedExecutions: 1100, bounded: true, accepted: true });
    expect(pairsOf(result).every(([b, c]) => b === c)).toBe(true);
  });
});

describe('alignStages: stages inside an aligned execution pair', () => {
  it('pairs two of three identical self-join subtrees against two', () => {
    const sub = (ids) => ids.map((id) => ({ id, name: 'Exchange', nodes: [node('Exchange', 'hashpartitioning(k#1, 200)', [id])] }));
    const result = alignStages(snapshotOf(sub([1, 2, 3])), snapshotOf(sub([1, 2])));
    expect(pairsOf(result)).toEqual([[1, 1], [2, 2]]);
    expect(result.pairs.every((p) => p.quality === 'exact')).toBe(true);
    // The count differs under one aligned execution, so the third subtree is replanned.
    expect(result.replanned.map((g) => [g.baseStageIds, g.candStageIds])).toEqual([[[3], []]]);
  });

  it('pairs a stage whose grouping columns come in another order as structural', () => {
    const agg = (cols, gid) => node('Expand', `[[${cols.join(', ')}, ${gid}]], [${cols.join(', ')}, gid#${gid}]`, [1]);
    const base = snapshotOf([{ id: 1, name: 'Exchange 1', nodes: [agg(['region#1', 'sku#2'], 5)] }]);
    const cand = snapshotOf([{ id: 1, name: 'Exchange 1', nodes: [agg(['sku#7', 'region#9'], 8)] }]);
    const [pair] = alignStages(base, cand).pairs;
    expect(pair.quality).toBe('structural');
    expect(pair.score).toBeGreaterThan(0.5);
  });

  it('keeps stages that differ in operator or attribute names apart in the structural key', () => {
    const base = snapshotOf([{ id: 1, nodes: [node('Filter', 'region#1 = x', [1])] }]);
    const cand = snapshotOf([{ id: 1, nodes: [node('Project', 'sku#1', [1])] }]);
    expect(alignStages(base, cand).pairs).toEqual([]);
  });

  it('pairs stages of different structure as aligned when their details are similar enough', () => {
    const base = snapshotOf([{ id: 1, name: 'save at X.java:0', nodes: [node('Filter', 'amount#1 > 5 AND region#2 = north AND kind#3 = a', [1])] }]);
    const cand = snapshotOf([{ id: 1, name: 'save at X.java:0', nodes: [node('Filter', 'amount#1 > 5 AND region#2 = north AND kind#3 = a AND day#4 = d', [1])] }]);
    const [pair] = alignStages(base, cand).pairs;
    expect(pair.quality).toBe('aligned');
    expect(pair.score).toBeGreaterThanOrEqual(0.6);
    // Details below the threshold do not pair.
    const far = snapshotOf([{ id: 1, name: 'save at X.java:0', nodes: [node('Filter', 'other#1 < 9 AND stuff#2 = y', [1])] }]);
    expect(alignStages(base, far).pairs).toEqual([]);
  });

  it('pairs stages without attributed plan nodes by position inside their execution, by name', () => {
    const noNodes = (ids, name) => ids.map((id) => ({ id, name, nodes: [] }));
    const base = snapshotOfExecutions([{ id: 0, stages: [...noNodes([1, 2], 'save at X.java:0'), { id: 3, name: 'collect at Y.java:0' }] }]);
    const cand = snapshotOfExecutions([{ id: 0, stages: [...noNodes([5, 6], 'save at X.java:0'), { id: 7, name: 'collect at Y.java:0' }] }]);
    const result = alignStages(base, cand);
    expect(pairsOf(result)).toEqual([[1, 5], [2, 6], [3, 7]]);
    // Same name and the same whole-plan fallback key: exact. A different plan on one side: positional.
    expect(result.pairs.map((p) => p.quality)).toEqual(['exact', 'exact', 'exact']);
    cand.sql.get(0).planTree.children.push(node('Extra', 'x', [99]));
    const positional = alignStages(base, cand).pairs;
    expect(positional.map((p) => p.quality)).toEqual(['aligned', 'aligned', 'aligned']);
    expect(positional.every((p) => p.score === 0.5)).toBe(true);
  });

  it('does not pair a plan-less stage with a different name', () => {
    const base = snapshotOf([{ id: 1, name: 'save at X.java:0' }]);
    const cand = snapshotOf([{ id: 1, name: 'collect at Y.java:0' }]);
    expect(alignStages(base, cand).pairs).toEqual([]);
  });

  it('separates stages outside any SQL execution by their call-site text', () => {
    const rdd = (id, details) => ({ id, name: 'map at job.py:1', details, sqlExecutionId: null });
    const base = snapshotOf([rdd(1, 'job.py:10 in load'), rdd(2, 'job.py:20 in join')]);
    const cand = snapshotOf([rdd(1, 'job.py:20 in join'), rdd(2, 'job.py:10 in load')]);
    expect(pairsOf(alignStages(base, cand))).toEqual([[1, 2], [2, 1]]);
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
      { id: 1, name: 'Exchange 1', nodes: [node('Filter', 'a', [1]), node('Scan parquet', 'in', [1]), node('Exchange', 'x', [1]), node('Sort', 's', [1])], executorRunTime: 100 },
      { id: 2, name: 'Heavy 1', nodes: [node('Filter', 'only_base#1 > 3', [2])], executorRunTime: 700 },
    ]);
    const cand = snapshotOf([
      { id: 1, name: 'Exchange 1', nodes: [node('Filter', 'a', [1]), node('Scan parquet', 'in', [1]), node('Exchange', 'x', [1]), node('Sort', 's', [1])], executorRunTime: 100 },
      { id: 2, name: 'Heavy 1', nodes: [node('Project', 'other_col#4', [2])], executorRunTime: 100 },
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
