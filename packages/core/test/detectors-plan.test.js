import { describe, it, expect } from 'vitest';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyzer.js';
import { computePlanShapes, normalizeDetail, findCompositeCandidates, planOperatorKind, findDuplicateSubtrees } from '../src/detectors.js';
import { createState, dispatchLine } from '../src/parser-worker.js';
import { formatBytes, pathBasename } from '../src/format-utils.js';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

// Values never feed the fingerprint, so a placeholder value of 1 is fine.
const node = (name, metricNames = [], children = []) => ({
  name, detail: '', metrics: metricNames.map(n => ({ name: n, value: 1, metricType: 'sum' })), children,
});

function makeSqlExec(id, planTree) {
  return { id, description: '', startTime: 0, endTime: 100, stageIds: [], planTree };
}

// Not imported anywhere in this file today; detectors.ts defines these as module-private
// constants, so redefine locally, matching analyzer-finding-identity.test.js's pattern.
const MB = 1024 * 1024;
const GB = 1024 * MB;

// Attributes every node of `tree` to stage `sid`, as resolvePlanTree does from task accumulables.
const inStage = (tree, sid) => {
  const visit = (n) => { n.stageIds = [sid]; n.children.forEach(visit); };
  visit(tree);
  return tree;
};

describe('duplicatePlanSubtree', () => {
  it('flags a repeated 3-node subtree, reconciled to critical here', () => {
    // Fallback impactBand is 'warning'; deriveImpactBand promotes it to 'critical'
    // here because the matched stage's wallClock estimate clears the critical floor.
    const dup = () => inStage(node('SortMergeJoin', ['a'], [node('Sort', ['b']), node('Sort', ['b'])]), 1);
    const planTree = node('Project', [], [dup(), dup()]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const stages = new Map([[1, makeStage({ sqlExecutionId: 1 })]]);
    const catalog = analyze(makeApp(), stages, [], [], new Map(), sql);
    const findings = catalog.filter(b => b.type === 'duplicatePlanSubtree');
    expect(findings).toHaveLength(1);
    expect(findings[0].impactBand).toBe('critical');
    expect(findings[0].stageIds).toEqual([1]);
    expect(findings[0].occurrencesIdentical).toBe(true);
    expect(findings[0].stageShares).toEqual({ 1: 1 });
  });

  it('skips a repeat whose stages together lasted under 0.5% of the run, and keeps a longer one above info', () => {
    const dup = () => inStage(node('SortMergeJoin', ['a'], [node('Sort', ['b']), node('Sort', ['b'])]), 1);
    const sql = new Map([[1, makeSqlExec(1, node('Project', [], [dup(), dup()]))]]);
    const run = makeApp({ endTime: 400_000 });
    const at = (completedAt) => analyze(run, new Map([[1, makeStage({ sqlExecutionId: 1, completedAt })]]), [], [], new Map(), sql)
      .filter(b => b.type === 'duplicatePlanSubtree');
    expect(at(1000)).toHaveLength(0); // 0.25% of the run: the repeat is real, the floor drops it
    const kept = at(8000); // 2%
    expect(kept).toHaveLength(1);
    expect(kept[0].impactBand).not.toBe('info');
  });

  // Same operator shape over different data (another table, another filter) is no repeated
  // work: the finding stays, flagged low-confidence and informational, with no time claimed.
  it('makes repeats whose details differ informational, with no wall-clock claim', () => {
    const dup = (filter) => {
      const tree = inStage(node('Filter', ['a'], [node('ColumnarToRow', ['b'], [node('Scan parquet', ['c'])])]), 1);
      tree.detail = filter;
      return tree;
    };
    const planTree = node('Union', [], [dup('Filter (x = 1)'), dup('Filter (y = 2)')]);
    const stages = new Map([[1, makeStage({ sqlExecutionId: 1 })]]);
    const [finding] = analyze(makeApp(), stages, [], [], new Map(), new Map([[1, makeSqlExec(1, planTree)]]))
      .filter(b => b.type === 'duplicatePlanSubtree');
    expect(finding.occurrencesIdentical).toBe(false);
    expect(finding.impactBand).toBe('info');
    expect(finding.confidence).toBe('low');
    expect(finding.impactEstimate.wallClock).toBeNull();
    expect(finding.recommendation).toContain('may compute different data');
  });

  it('treats repeats that differ only in AQE query-stage numbering as identical', () => {
    const dup = (n) => {
      const leaf = node('ShuffleQueryStage', ['d']);
      leaf.detail = `ShuffleQueryStage ${n}`;
      return inStage(node('Sort', ['a'], [node('AQEShuffleRead', ['b'], [leaf])]), 1);
    };
    const planTree = node('SortMergeJoin', [], [dup(718), dup(720)]);
    const [finding] = analyze(makeApp(), new Map([[1, makeStage({ sqlExecutionId: 1 })]]), [], [], new Map(), new Map([[1, makeSqlExec(1, planTree)]]))
      .filter(b => b.type === 'duplicatePlanSubtree');
    expect(finding.occurrencesIdentical).toBe(true);
  });

  // A stage that also runs operators outside the repeats contributes only its operators' share;
  // WholeStageCodegen wrappers and Exchange write halves don't count as other operators.
  it('claims only the repeated operators\' share of a stage shared with other work', () => {
    const dup = () => inStage(node('Sort', ['a'], [node('Filter', ['b']), node('Filter', ['b'])]), 1);
    const other = inStage(node('HashAggregate', ['e'], [node('Project', ['f'])]), 1);
    const wrapper = inStage(node('WholeStageCodegen (1)', ['duration'], [dup()]), 1);
    const write = inStage(node('Exchange', ['data size'], [dup()]), 1);
    write.exchangeRole = 'write';
    const planTree = node('Union', [], [wrapper, write, other]);
    const [finding] = analyze(makeApp(), new Map([[1, makeStage({ sqlExecutionId: 1 })]]), [], [], new Map(), new Map([[1, makeSqlExec(1, planTree)]]))
      .filter(b => b.type === 'duplicatePlanSubtree');
    // 6 repeated operators of the stage's 8 (the wrapper and the write half excluded).
    expect(finding.stageShares).toEqual({ 1: 0.75 });
  });

  it('claims no time when no operator of the repeats ran in a known stage', () => {
    const dup = () => node('SortMergeJoin', ['a'], [node('Sort', ['b']), node('Sort', ['b'])]);
    const planTree = node('Project', [], [dup(), dup()]);
    const stages = new Map([[1, makeStage({ sqlExecutionId: 1 })]]);
    const [finding] = analyze(makeApp(), stages, [], [], new Map(), new Map([[1, makeSqlExec(1, planTree)]]))
      .filter(b => b.type === 'duplicatePlanSubtree');
    // stageIds still falls back to the execution's stages for linking, but none is attributable.
    expect(finding.stageIds).toEqual([1]);
    expect(finding.impactBand).toBe('info');
    expect(finding.impactEstimate.wallClock).toBeNull();
  });

  it('confidence is low for a match at the bare minimum subtreeSize and occurrences (old logic hardcoded medium here, the weakest evidence the matcher can produce)', () => {
    const dup = () => node('SortMergeJoin', ['a'], [node('Sort', ['b']), node('Sort', ['b'])]); // subtreeSize 3
    const planTree = node('Project', [], [dup(), dup()]); // occurrences 2
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const findings = analyze(makeApp(), new Map(), [], [], new Map(), sql).filter(b => b.type === 'duplicatePlanSubtree');
    expect(findings).toHaveLength(1);
    expect(findings[0].subtreeSize).toBe(3);
    expect(findings[0].value).toBe(2); // occurrences
    expect(findings[0].confidence).toBe('low');
  });

  it('confidence is medium once the match clears the floor but not the high-confidence bar', () => {
    const dup = () => node('Agg', ['a'], [node('L1'), node('L2'), node('L3')]); // subtreeSize 4
    const planTree = node('Project', [], [dup(), dup()]); // occurrences 2
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const findings = analyze(makeApp(), new Map(), [], [], new Map(), sql).filter(b => b.type === 'duplicatePlanSubtree');
    expect(findings).toHaveLength(1);
    expect(findings[0].confidence).toBe('medium');
  });

  it('confidence rises to high once subtreeSize clears 2x minSubtreeSize, even at the minimum occurrences (old logic hardcoded medium here)', () => {
    const dup = () => node('Agg', ['a'], [node('L1'), node('L2'), node('L3'), node('L4'), node('L5')]); // subtreeSize 6
    const planTree = node('Project', [], [dup(), dup()]); // occurrences 2
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const findings = analyze(makeApp(), new Map(), [], [], new Map(), sql).filter(b => b.type === 'duplicatePlanSubtree');
    expect(findings).toHaveLength(1);
    expect(findings[0].subtreeSize).toBe(6);
    expect(findings[0].confidence).toBe('high');
  });

  it('confidence rises to high once occurrences clears minOccurrences+2, even with a small subtree (old logic hardcoded medium here)', () => {
    const dup = () => node('SortMergeJoin', ['a'], [node('Sort', ['b']), node('Sort', ['b'])]); // subtreeSize 3
    const planTree = node('Project', [], [dup(), dup(), dup(), dup()]); // occurrences 4
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const findings = analyze(makeApp(), new Map(), [], [], new Map(), sql).filter(b => b.type === 'duplicatePlanSubtree');
    expect(findings).toHaveLength(1);
    expect(findings[0].value).toBe(4); // occurrences
    expect(findings[0].confidence).toBe('high');
  });

  it('marks an Exchange-rooted repeated subtree as isExchangeRoot, which drives the recommendation text, not the impactBand', () => {
    const dup = () => node('Exchange', ['data size'], [node('Sort', ['b']), node('Sort', ['b'])]);
    const planTree = node('Project', [], [dup(), dup()]);
    const groups = findDuplicateSubtrees(planTree, { minSubtreeSize: 3, minOccurrences: 2 });
    expect(groups).toHaveLength(1);
    expect(groups[0].isExchangeRoot).toBe(true);

    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    // No stages: no wallClock estimate, so impactBand stays the no-coverage 'info'
    // regardless of isExchangeRoot; only the recommendation text differs.
    const catalog = analyze(makeApp(), new Map(), [], [], new Map(), sql);
    const findings = catalog.filter(b => b.type === 'duplicatePlanSubtree');
    expect(findings).toHaveLength(1);
    expect(findings[0].impactBand).toBe('info');
    expect(findings[0].recommendation).toContain('missed exchange reuse');
  });

  it('does not flag a repeated subtree below minSubtreeSize', () => {
    const dup = () => node('Filter', ['a']); // subtree size 1, below threshold of 3
    const planTree = node('Project', [], [dup(), dup()]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const catalog = analyze(makeApp(), new Map(), [], [], new Map(), sql);
    expect(catalog.filter(b => b.type === 'duplicatePlanSubtree')).toHaveLength(0);
  });

  it('emits no finding for a plan with no repetition', () => {
    const planTree = node('Project', [], [node('Scan', ['x']), node('Filter', ['y'])]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const catalog = analyze(makeApp(), new Map(), [], [], new Map(), sql);
    expect(catalog.filter(b => b.type === 'duplicatePlanSubtree')).toHaveLength(0);
  });

  it('guards against a missing planTree without throwing', () => {
    const sql = new Map([[1, makeSqlExec(1, null)]]);
    expect(() => analyze(makeApp(), new Map(), [], [], new Map(), sql)).not.toThrow();
  });

  it('recommendation uses the basename of a path-like root node name, leaving rootName raw', () => {
    const rawName = 'Scan ExistingRDD Delta Table State - hdfs://host/a/b/leaf_dir';
    const dup = () => node(rawName, ['a'], [node('Sort', ['b']), node('Sort', ['b'])]);
    const planTree = node('Project', [], [dup(), dup()]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const catalog = analyze(makeApp(), new Map(), [], [], new Map(), sql);
    const findings = catalog.filter(b => b.type === 'duplicatePlanSubtree');
    expect(findings).toHaveLength(1);
    expect(findings[0].rootName).toBe(rawName);
    expect(findings[0].recommendation).toContain(pathBasename(rawName));
    expect(findings[0].recommendation).not.toContain(rawName);
  });

  it('distinguishes two same-shape duplicate groups that scan different tables (regression: real logs emitted indistinguishable/id-colliding findings for unrelated repeated BroadcastExchange subtrees over different tables)', () => {
    // Same-shape groups scanning different tables stay separate fingerprint groups;
    // the emitted findings need a field reflecting the table or they collide on one id.
    const broadcastOf = (table) => node('BroadcastExchange', [], [
      node('Project', [], [
        node('Filter', [], [
          node(`Scan parquet spark_catalog.warehouse.${table}`, []),
        ]),
      ]),
    ]);
    const planTree = node('Project', [], [
      broadcastOf('packs'), broadcastOf('packs'),
      broadcastOf('packs_inverso'), broadcastOf('packs_inverso'),
    ]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const stages = new Map([[1, makeStage({ id: 1, sqlExecutionId: 1 })]]);
    const catalog = analyze(makeApp(), stages, [], [], new Map(), sql);
    const findings = catalog.filter(b => b.type === 'duplicatePlanSubtree');
    expect(findings).toHaveLength(2);
    // Each finding must carry something that reflects which table it's about.
    expect(findings[0].recommendation).not.toBe(findings[1].recommendation);
    expect(new Set(findings.map((f) => f.id)).size).toBe(findings.length);
  });

  it('keeps both findings distinct when neither duplicate group resolves to a named catalog relation (regression: sampleRelation alone is null for scan-less sources like JDBC/Kafka/LocalRelation, and a shared null would silently drop the second finding via push()\'s id-dedup guardrail)', () => {
    // Leaves not recognized by scanRelationId, so sampleRelation is null for both;
    // groupIndex is the discriminator that must keep them apart.
    const localOf = (label) => node('BroadcastExchange', [], [
      node('Project', [], [
        node('Filter', [], [
          node(`LocalTableScan ${label}`, []),
        ]),
      ]),
    ]);
    const planTree = node('Project', [], [
      localOf('A'), localOf('A'),
      localOf('B'), localOf('B'),
    ]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const stages = new Map([[1, makeStage({ id: 1, sqlExecutionId: 1 })]]);
    const catalog = analyze(makeApp(), stages, [], [], new Map(), sql);
    const findings = catalog.filter(b => b.type === 'duplicatePlanSubtree');
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.sampleRelation == null)).toBe(true);
    // Both findings must survive push()'s id-dedup guardrail, not just one.
    expect(new Set(findings.map((f) => f.id)).size).toBe(findings.length);
  });

  it('computePlanShapes: default opts (no includeDetail) ignores node.detail entirely', () => {
    const a = node('Join', ['rows']);
    a.detail = 'condition A';
    const b = node('Join', ['rows']);
    b.detail = 'condition B';
    const { shapeOf } = computePlanShapes(a);
    const { shapeOf: shapeOfB } = computePlanShapes(b);
    expect(shapeOf.get(a).fingerprint).toBe(shapeOfB.get(b).fingerprint);
  });

  it('computePlanShapes: includeDetail folds only the root\'s own normalized detail', () => {
    const leftChild = node('Scan parquet', ['size of files read']);
    const rightChild = node('Scan parquet', ['size of files read']);
    const a = node('Join', ['rows'], [leftChild, rightChild]);
    a.detail = 'condition A';
    const b = node('Join', ['rows'], [leftChild, rightChild]);
    b.detail = 'condition B';
    const identityNormalize = (d) => d;
    const { shapeOf: sa } = computePlanShapes(a, { includeDetail: true, normalizeDetail: identityNormalize });
    const { shapeOf: sb } = computePlanShapes(b, { includeDetail: true, normalizeDetail: identityNormalize });
    expect(sa.get(a).fingerprint).not.toBe(sb.get(b).fingerprint);
    expect(sa.get(a).fingerprint).toContain('<condition A>');
    expect(sb.get(b).fingerprint).toContain('<condition B>');
  });

  it('computePlanShapes: includeDetail never folds detail into recursive child fingerprints', () => {
    const leftA = node('Scan parquet', ['size of files read']);
    leftA.detail = 'left detail A';
    const leftB = node('Scan parquet', ['size of files read']);
    leftB.detail = 'left detail B';
    const a = node('Join', ['rows'], [leftA]);
    a.detail = 'same condition';
    const b = node('Join', ['rows'], [leftB]);
    b.detail = 'same condition';
    const identityNormalize = (d) => d;
    const { shapeOf: sa } = computePlanShapes(a, { includeDetail: true, normalizeDetail: identityNormalize });
    const { shapeOf: sb } = computePlanShapes(b, { includeDetail: true, normalizeDetail: identityNormalize });
    // Only the root's detail is folded; a child's own detail never enters the fingerprint.
    expect(sa.get(a).fingerprint).toBe(sb.get(b).fingerprint);
  });

  it('computePlanShapes: a read/write Exchange split pair collapses to one logical node, sized and fingerprinted off the write half', () => {
    const scan = node('Scan parquet t');
    const write = node('Exchange', ['data size'], [scan]);
    write.exchangeRole = 'write';
    const read = node('Exchange', [], [write]);
    read.exchangeRole = 'read';
    const root = node('Project', [], [read]);
    const { shapeOf } = computePlanShapes(root);
    // Project, Exchange, Scan -- NOT 4 (the write half must not count separately).
    expect(shapeOf.get(root).size).toBe(3);
    // The Exchange's fingerprint must come from the write half's real "data size"
    // metric, not the read half's always-empty metrics.
    expect(shapeOf.get(read).fingerprint).toContain('data size');
  });

  it('computePlanShapes: fingerprints stay O(own size) on a deep plan, yet still tell apart subtrees that differ only at the leaf', () => {
    const chain = (leafName) => {
      let n = node(leafName, ['number of output rows']);
      for (let i = 0; i < 300; i++) n = node('Project', ['number of output rows'], [n]);
      return n;
    };
    const a = chain('Scan parquet a');
    const b = chain('Scan parquet b');
    const fa = computePlanShapes(a).shapeOf.get(a).fingerprint;
    // Children fold in as fixed-length digests: embedding them whole made the root carry all
    // 300 levels of text.
    expect(fa.length).toBeLessThan(100);
    expect(fa).not.toBe(computePlanShapes(b).shapeOf.get(b).fingerprint);
  });
});

describe('findDuplicateSubtrees: node instance contract', () => {
  it('includes the matched PlanNode instances on each returned group', () => {
    const dup = () => ({
      name: 'SortMergeJoin', detail: '',
      metrics: [{ name: 'a', value: 1 }],
      children: [
        { name: 'Sort', detail: '', metrics: [{ name: 'b', value: 1 }], children: [] },
        { name: 'Sort', detail: '', metrics: [{ name: 'b', value: 1 }], children: [] },
      ],
    });
    const a = dup();
    const b = dup();
    const root = { name: 'Project', detail: '', metrics: [], children: [a, b] };

    const groups = findDuplicateSubtrees(root, { minSubtreeSize: 3, minOccurrences: 2 });

    expect(groups).toHaveLength(1);
    expect(groups[0].nodes).toHaveLength(2);
    expect(groups[0].nodes).toContain(a);
    expect(groups[0].nodes).toContain(b);
  });
});

describe('duplicatePlanSubtree: narrowed stageIds', () => {
  function planNodeWithStages(name, stageIds, children = []) {
    return { name, detail: '', metrics: [{ name: 'm', value: 1 }], children, ...(stageIds ? { stageIds } : {}) };
  }

  it('unions stageIds across all matched instances of the duplicated group', () => {
    const dup = (stageId) => planNodeWithStages('SortMergeJoin', [stageId], [
      planNodeWithStages('Sort', undefined), planNodeWithStages('Sort', undefined),
    ]);
    const a = dup(10);
    const b = dup(11);
    const planTree = planNodeWithStages('Project', undefined, [a, b]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const stages = new Map([
      [10, makeStage({ id: 10, sqlExecutionId: 1 })], [11, makeStage({ id: 11, sqlExecutionId: 1 })],
      [12, makeStage({ id: 12, sqlExecutionId: 1 })], // unrelated stage in the same execution
    ]);

    const findings = analyze(makeApp(), stages, [], [], new Map(), sql).filter((f) => f.type === 'duplicatePlanSubtree');

    expect(findings).toHaveLength(1);
    expect(findings[0].stageIds).toEqual([10, 11]);
  });

  it('unions stageIds from a descendant node, not just the matched subtree root', () => {
    // Passthrough roots often carry no stageIds; coverage lives on a node deeper in
    // the same occurrence, so the union must walk the full matched subtree.
    const dup = (stageId) => planNodeWithStages('SortMergeJoin', undefined, [
      planNodeWithStages('Sort', [stageId]), planNodeWithStages('Sort', undefined),
    ]);
    const a = dup(10);
    const b = dup(11);
    const planTree = planNodeWithStages('Project', undefined, [a, b]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const stages = new Map([
      [10, makeStage({ id: 10, sqlExecutionId: 1 })], [11, makeStage({ id: 11, sqlExecutionId: 1 })],
      [12, makeStage({ id: 12, sqlExecutionId: 1 })], // unrelated stage in the same execution
    ]);

    const findings = analyze(makeApp(), stages, [], [], new Map(), sql).filter((f) => f.type === 'duplicatePlanSubtree');

    expect(findings).toHaveLength(1);
    expect(findings[0].stageIds).toEqual([10, 11]);
  });

  it('falls back to execution-wide stageIds when no matched instance has coverage', () => {
    const dup = () => planNodeWithStages('SortMergeJoin', undefined, [
      planNodeWithStages('Sort', undefined), planNodeWithStages('Sort', undefined),
    ]);
    const planTree = planNodeWithStages('Project', undefined, [dup(), dup()]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const stages = new Map([[10, makeStage({ id: 10, sqlExecutionId: 1 })], [11, makeStage({ id: 11, sqlExecutionId: 1 })]]);

    const findings = analyze(makeApp(), stages, [], [], new Map(), sql).filter((f) => f.type === 'duplicatePlanSubtree');

    expect(findings[0].stageIds.sort()).toEqual([10, 11]);
  });
});

describe('smallFiles', () => {
  const metric = (name, value) => ({ name, value, metricType: 'sum' });
  const readNode = (fileCount, avgBytes) => ({
    name: 'Scan parquet', detail: '', children: [],
    metrics: [metric('number of files read', fileCount), metric('size of files read', fileCount * avgBytes)],
  });
  const writeNode = (fileCount, avgBytes) => ({
    name: 'Execute InsertIntoHadoopFsRelationCommand', detail: '', children: [],
    metrics: [metric('number of written files', fileCount), metric('written output', fileCount * avgBytes)],
  });

  function run(planNode) {
    const sql = new Map([[1, makeSqlExec(1, planNode)]]);
    const catalog = analyze(makeApp(), new Map(), [], [], new Map(), sql);
    return catalog.filter(b => b.type === 'smallFiles');
  }

  it('does not flag file count exactly at the 100-file boundary', () => {
    expect(run(readNode(100, 1024 * 1024))).toHaveLength(0);
  });

  it('does not flag average size exactly at the 3 MiB boundary', () => {
    expect(run(readNode(150, 3 * 1024 * 1024))).toHaveLength(0);
  });

  it('flags many small read files', () => {
    const findings = run(readNode(150, 1024 * 1024));
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe('read');
    expect(findings[0].fileCount).toBe(150);
  });

  it('flags many small written files', () => {
    const findings = run(writeNode(200, 2 * 1024 * 1024));
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe('write');
  });

  it('does not flag a large average file size', () => {
    expect(run(readNode(500, 10 * 1024 * 1024))).toHaveLength(0);
  });

  it('recommendation uses the basename of a path-like scan node name, leaving nodeName raw', () => {
    const rawName = 'Scan parquet - hdfs://host/a/b/leaf_dir';
    const planNode = {
      name: rawName, detail: '', children: [],
      metrics: [metric('number of files read', 150), metric('size of files read', 150 * 1024 * 1024)],
    };
    const findings = run(planNode);
    expect(findings).toHaveLength(1);
    expect(findings[0].nodeName).toBe(rawName);
    expect(findings[0].recommendation).toContain(pathBasename(rawName));
    expect(findings[0].recommendation).not.toContain(rawName);
  });
});

describe('smallFiles: narrowed stageIds', () => {
  it('uses the flagged node\'s own stageIds when it has coverage', () => {
    const readNode = {
      name: 'FileSourceScan', detail: '', stageIds: [4],
      metrics: [
        { name: 'number of files read', value: 500 },
        { name: 'size of files read', value: 500 * 1024 * 1024 }, // avg ~1MB, under the 3MB threshold
      ],
      children: [],
    };
    const planTree = { name: 'Project', detail: '', metrics: [], children: [readNode] };
    const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree }]]);
    const stages = new Map([[4, { id: 4, sqlExecutionId: 1 }], [5, { id: 5, sqlExecutionId: 1 }]]);

    const findings = analyze(makeApp(), stages, [], [], new Map(), sql).filter((f) => f.type === 'smallFiles');

    expect(findings[0].stageIds).toEqual([4]);
  });

  it('falls back to execution-wide stageIds when the node has no coverage', () => {
    const readNode = {
      name: 'FileSourceScan', detail: '',
      metrics: [
        { name: 'number of files read', value: 500 },
        { name: 'size of files read', value: 500 * 1024 * 1024 },
      ],
      children: [],
    };
    const planTree = { name: 'Project', detail: '', metrics: [], children: [readNode] };
    const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree }]]);
    const stages = new Map([[4, { id: 4, sqlExecutionId: 1 }]]);

    const findings = analyze(makeApp(), stages, [], [], new Map(), sql).filter((f) => f.type === 'smallFiles');

    expect(findings[0].stageIds).toEqual([4]);
  });
});

describe('smallFiles: real-fixture metric-name integration', () => {
  const fixturePath = fileURLToPath(new URL('../../../examples/private-log-06', import.meta.url));

  async function collectMatchingLines(filePath, substrings) {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    const lines = [];
    for await (const line of rl) {
      if (substrings.some(s => line.includes(s))) lines.push(line);
    }
    return lines;
  }

  it.skipIf(!existsSync(fixturePath))(
    'analyze() consumes real plan-node metric names without throwing, and at least one node carries the exact names this detector looks for (private-log-06: gitignored, local-only)',
    async () => {
      const lines = await collectMatchingLines(fixturePath, [
        '"org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart"',
        '"org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates"',
        '"org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd"',
      ]);
      const state = createState();
      const sql = new Map();
      for (const line of lines) {
        dispatchLine(line, state, (m) => {
          if (m.type === 'sql') sql.set(m.data.id, { ...m.data });
          if (m.type === 'sqlPlan') {
            const exec = sql.get(m.data.executionId);
            if (exec) exec.planTree = m.data.planTree;
          }
        });
      }
      expect(sql.size).toBeGreaterThan(0);
      expect(() => analyze(makeApp(), new Map(), [], [], new Map(), sql)).not.toThrow();

      function hasFileMetric(node) {
        const names = (node.metrics ?? []).map(m => m.name);
        if (names.includes('number of files read') || names.includes('number of written files')) return true;
        return (node.children ?? []).some(hasFileMetric);
      }
      const anyMatch = [...sql.values()].some(e => e.planTree && hasFileMetric(e.planTree));
      expect(anyMatch).toBe(true);
    },
    30000,
  );
});

describe('broadcast sizing', () => {
  function sizeNode(name, children = [], value) {
    return {
      name, detail: '', children,
      metrics: value != null ? [{ name: 'data size', value, metricType: 'size' }] : [],
    };
  }
  function run(planNode) {
    const sql = new Map([[1, makeSqlExec(1, planNode)]]);
    const catalog = analyze(makeApp(), new Map(), [], [], new Map(), sql);
    return catalog.filter(b => b.type === 'underBroadcast' || b.type === 'overBroadcast');
  }

  it('flags a SortMergeJoin whose smaller side is well under the broadcast threshold', () => {
    const join = sizeNode('SortMergeJoin', [
      sizeNode('Exchange', [], 5 * 1024 * 1024),            // 5 MiB: under the 10 MiB unconditional tier
      sizeNode('Exchange', [], 200 * 1024 * 1024 * 1024),   // 200 GiB
    ]);
    const findings = run(join);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('underBroadcast');
    expect(findings[0].impactBand).toBe('info');
  });

  it('flags a BroadcastExchange over 1 GiB as overBroadcast', () => {
    const bx = sizeNode('BroadcastExchange', [], 2 * 1024 * 1024 * 1024);
    const findings = run(bx);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('overBroadcast');
    expect(findings[0].impactBand).toBe('warning');
  });

  it('emits no finding when neither condition is met', () => {
    const join = sizeNode('SortMergeJoin', [
      sizeNode('Exchange', [], 2 * 1024 * 1024 * 1024), // 2 GiB
      sizeNode('Exchange', [], 3 * 1024 * 1024 * 1024), // 3 GiB: balanced, no tier fires
    ]);
    expect(run(join)).toHaveLength(0);
  });

  it('underBroadcast: includes the smaller/larger side byte figures', () => {
    const join = sizeNode('SortMergeJoin', [
      sizeNode('Exchange', [], 5 * 1024 * 1024),
      sizeNode('Exchange', [], 200 * 1024 * 1024 * 1024),
    ]);
    const [finding] = run(join);
    expect(finding.recommendation).toContain(formatBytes(finding.value));
    expect(finding.recommendation).toContain(formatBytes(finding.largerSideBytes));
  });

  it('overBroadcast: includes the broadcast byte figure', () => {
    const bx = sizeNode('BroadcastExchange', [], 2 * 1024 * 1024 * 1024);
    const [finding] = run(bx);
    expect(finding.recommendation).toContain(formatBytes(finding.value));
  });
});

describe('broadcastSizing: narrowed stageIds', () => {
  function sizeNode(name, children = [], value, stageIds) {
    return {
      name, detail: '', children,
      metrics: value != null ? [{ name: 'data size', value, metricType: 'size' }] : [],
      ...(stageIds ? { stageIds } : {}),
    };
  }

  it('overBroadcast unions in only the flagged BroadcastExchange node\'s immediate child\'s stageIds (the node\'s own metrics never appear on a TaskEnd, so it never has stageIds of its own in real data)', () => {
    const child = sizeNode('Project', [], undefined, [20]);
    const bx = sizeNode('BroadcastExchange', [child], 2 * 1024 * 1024 * 1024);
    const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree: bx }]]);
    const stages = new Map([[20, { id: 20, sqlExecutionId: 1 }], [21, { id: 21, sqlExecutionId: 1 }]]);

    const findings = analyze(makeApp(), stages, [], [], new Map(), sql).filter((f) => f.type === 'overBroadcast');

    expect(findings[0].stageIds).toEqual([20]);
  });

  it('underBroadcast unions stageIds from wherever sumBoundarySize actually found the data-size metric on each side, however deep', () => {
    const deepLeft = sizeNode('Exchange', [sizeNode('Filter', [], 5 * 1024 * 1024, [30])]); // metric one level down
    const shallowRight = sizeNode('Exchange', [], 200 * 1024 * 1024 * 1024, [31]); // metric on the immediate child
    const join = sizeNode('SortMergeJoin', [deepLeft, shallowRight]);
    const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree: join }]]);
    const stages = new Map([[30, { id: 30, sqlExecutionId: 1 }], [31, { id: 31, sqlExecutionId: 1 }], [32, { id: 32, sqlExecutionId: 1 }]]);

    const findings = analyze(makeApp(), stages, [], [], new Map(), sql).filter((f) => f.type === 'underBroadcast');

    expect(findings[0].stageIds.sort()).toEqual([30, 31]);
  });

  it('falls back to execution-wide stageIds when no contributing node has coverage', () => {
    const bx = sizeNode('BroadcastExchange', [], 2 * 1024 * 1024 * 1024);
    const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree: bx }]]);
    const stages = new Map([[20, { id: 20, sqlExecutionId: 1 }]]);

    const findings = analyze(makeApp(), stages, [], [], new Map(), sql).filter((f) => f.type === 'overBroadcast');

    expect(findings[0].stageIds).toEqual([20]);
  });

  it('underBroadcast still finds the data-size metric two levels down (Exchange -> Filter -> Project), not just depth 1', () => {
    // No real-log fixture triggers this finding, so this synthetic case is the only
    // coverage that boundarySizeContributors' recursion matches sumBoundarySize's depth.
    const deepLeft = sizeNode('Exchange', [
      sizeNode('Filter', [sizeNode('Project', [], 5 * 1024 * 1024, [30])]),
    ]); // metric two levels down
    const shallowRight = sizeNode('Exchange', [], 200 * 1024 * 1024 * 1024, [31]); // metric on the immediate child
    const join = sizeNode('SortMergeJoin', [deepLeft, shallowRight]);
    const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree: join }]]);
    const stages = new Map([[30, { id: 30, sqlExecutionId: 1 }], [31, { id: 31, sqlExecutionId: 1 }], [32, { id: 32, sqlExecutionId: 1 }]]);

    const findings = analyze(makeApp(), stages, [], [], new Map(), sql).filter((f) => f.type === 'underBroadcast');

    expect(findings[0].stageIds.sort()).toEqual([30, 31]);
  });
});

describe('duplicatePlanSubtree: planNodeIds and the Exchange split', () => {
  function idNode(name, id, metricNames = [], children = [], extra = {}) {
    return { id, name, detail: '', metrics: metricNames.map(n => ({ name: n, value: 1, metricType: 'sum' })), children, ...extra };
  }

  it('captures planNodeIds covering the whole matched subtree', () => {
    const dup = (suffix) => idNode('SortMergeJoin', `j${suffix}`, ['a'], [
      idNode('Sort', `s1${suffix}`, ['b']), idNode('Sort', `s2${suffix}`, ['b']),
    ]);
    const planTree = idNode('Project', 'root', [], [dup('A'), dup('B')]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const stages = new Map([[1, makeStage({ sqlExecutionId: 1 })]]);
    const catalog = analyze(makeApp(), stages, [], [], new Map(), sql);
    const findings = catalog.filter(b => b.type === 'duplicatePlanSubtree');
    expect(findings).toHaveLength(1);
    expect(findings[0].planNodeIds.sort()).toEqual(['jA', 's1A', 's2A', 'jB', 's1B', 's2B'].sort());
  });

  it('treats a write/read Exchange pair as one indivisible unit: no spurious nested duplicate at the write half', () => {
    const dup = (suffix) => {
      const write = idNode('Exchange', `w${suffix}`, ['data size'], [idNode('Scan parquet t', `scan${suffix}`)], { exchangeRole: 'write' });
      const read = idNode('Exchange', `r${suffix}`, [], [write], { exchangeRole: 'read' });
      return idNode('SortMergeJoin', `j${suffix}`, ['a'], [read, idNode('Sort', `sort${suffix}`)]);
    };
    const planTree = idNode('Project', 'root', [], [dup('A'), dup('B')]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const stages = new Map([[1, makeStage({ sqlExecutionId: 1 })]]);
    const catalog = analyze(makeApp(), stages, [], [], new Map(), sql);
    const findings = catalog.filter(b => b.type === 'duplicatePlanSubtree');
    // Exactly one group (the SortMergeJoin subtree), not two (no separate
    // group rooted at the write half nested inside it).
    expect(findings).toHaveLength(1);
    expect(findings[0].rootName).toBe('SortMergeJoin');
  });
});

describe('smallFiles: planNodeIds', () => {
  function idNode(name, id, metricNames = [], children = []) {
    return { id, name, detail: '', metrics: metricNames.map(n => ({ name: n, value: 1, metricType: 'sum' })), children };
  }

  it('captures the single hit node id', () => {
    const scan = idNode('Scan parquet t', 'scan1', ['number of files read', 'size of files read']);
    scan.metrics = [{ name: 'number of files read', value: 500, metricType: 'sum' }, { name: 'size of files read', value: 500 * MB, metricType: 'sum' }];
    const planTree = idNode('Project', 'root', [], [scan]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const stages = new Map([[1, makeStage({ sqlExecutionId: 1 })]]);
    const catalog = analyze(makeApp(), stages, [], [], new Map(), sql);
    const findings = catalog.filter(b => b.type === 'smallFiles');
    expect(findings).toHaveLength(1);
    expect(findings[0].planNodeIds).toEqual(['scan1']);
  });
});

describe('overBroadcast/underBroadcast: classifier + planNodeIds', () => {
  function idNode(name, id, metricNames = [], children = [], extra = {}) {
    return { id, name, detail: '', metrics: metricNames.map(n => ({ name: n, value: 1, metricType: 'sum' })), children, ...extra };
  }

  it('overBroadcast fires off the write half (data size lives there) and captures its id', () => {
    const write = idNode('BroadcastExchange', 'bx-write', ['data size'], [], { exchangeRole: 'write' });
    write.metrics = [{ name: 'data size', value: 2 * GB, metricType: 'sum' }];
    const read = idNode('BroadcastExchange', 'bx-read', [], [write], { exchangeRole: 'read' });
    const planTree = idNode('Project', 'root', [], [read]);
    const sql = new Map([[1, makeSqlExec(1, planTree)]]);
    const stages = new Map([[1, makeStage({ sqlExecutionId: 1 })]]);
    const catalog = analyze(makeApp(), stages, [], [], new Map(), sql);
    const findings = catalog.filter(b => b.type === 'overBroadcast');
    expect(findings).toHaveLength(1);
    expect(findings[0].planNodeIds).toEqual(['bx-write']);
  });
});

describe('normalizeDetail', () => {
  // An equality operand starts at the first letter of its identifier run, whatever precedes it:
  // a dot (`).col`), a digit (`1abc`), or nothing identifier-like at all.
  it('canonicalizes equality operands wherever their identifier starts', () => {
    expect(normalizeDetail('f(x)).zeta.c = alpha(y)')).toBe('f(x)).alpha = zeta.c(y)');
    expect(normalizeDetail('1zeta = alpha')).toBe('1alpha = zeta');
    expect(normalizeDetail('(t2.b = t1.a) AND (a1b = a0)')).toBe('(t1.a = t2.b) AND (a0 = a1b)');
    expect(normalizeDetail('notAnEquality(abc) >= xyz')).toBe('notAnEquality(abc) >= xyz');
  });

  it('strips per-analysis expression ids (id#123L -> id)', () => {
    expect(normalizeDetail('SortMergeJoin [id#123L], [id#456], Inner'))
      .toBe(normalizeDetail('SortMergeJoin [id#789L], [id#12], Inner'));
  });

  it('strips plan_id= and whole-stage-codegen stage numbers', () => {
    const a = normalizeDetail('BroadcastHashJoin [a#1], [b#2], Inner, BuildRight, plan_id=5');
    const b = normalizeDetail('BroadcastHashJoin [a#3], [b#4], Inner, BuildRight, plan_id=99');
    expect(a).toBe(b);
    const c = normalizeDetail('WholeStageCodegen [codegen id : 3]');
    const d = normalizeDetail('WholeStageCodegen [codegen id : 17]');
    expect(c).toBe(d);
  });

  it('normalizes BuildLeft/BuildRight broadcast-side tokens (AQE can flip them)', () => {
    const buildLeft = normalizeDetail('BroadcastHashJoin [a#1], [b#2], Inner, BuildLeft');
    const buildRight = normalizeDetail('BroadcastHashJoin [a#1], [b#2], Inner, BuildRight');
    expect(buildLeft).toBe(buildRight);
  });

  it('canonicalizes commutative equality operand order (A.x = B.y == B.y = A.x)', () => {
    expect(normalizeDetail('Condition (A.x = B.y)')).toBe(normalizeDetail('Condition (B.y = A.x)'));
  });

  it('preserves literal values and join type in the anchor detail (not stripped)', () => {
    const inner = normalizeDetail("SortMergeJoin [id#1], [id#2], Inner, (status#3 = 'active')");
    const left = normalizeDetail("SortMergeJoin [id#1], [id#2], LeftOuter, (status#3 = 'active')");
    expect(inner).not.toBe(left);
    expect(inner).toContain("'active'");
  });
});

describe('planOperatorKind', () => {
  it('identifies join nodes by name', () => {
    expect(planOperatorKind('SortMergeJoin')).toBe('join');
    expect(planOperatorKind('BroadcastHashJoin')).toBe('join');
    expect(planOperatorKind('ShuffledHashJoin')).toBe('join');
  });
  it('identifies Union nodes by exact name', () => {
    expect(planOperatorKind('Union')).toBe('union');
  });
  it('returns null for non-join/union nodes', () => {
    expect(planOperatorKind('Scan parquet')).toBeNull();
    expect(planOperatorKind('Filter')).toBeNull();
  });
});

describe('findCompositeCandidates', () => {
  function makeScan(relation, bytes) {
    return {
      name: `Scan parquet spark_catalog.${relation}`,
      detail: `FileScan parquet spark_catalog.${relation}[c#1] Location: PreparedDeltaFileIndex[hdfs://cluster/wh/${relation.replace(/\./g, '/')}]`,
      metrics: [{ name: 'size of files read', value: bytes, metricType: 'sum' }],
      children: [],
    };
  }

  it('emits one candidate per join/union node, with merged leaf-relation bytes', () => {
    const a = makeScan('mx.a', 100);
    const b = makeScan('mx.b', 200);
    const join = { name: 'SortMergeJoin', detail: '[id#1], [id#2], Inner', metrics: [], children: [a, b] };
    const candidates = findCompositeCandidates(join);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].operator).toBe('join');
    expect(candidates[0].node).toBe(join);
    expect([...candidates[0].leafRelationBytes.entries()]).toEqual(
      expect.arrayContaining([['delta:mx.a', 100], ['delta:mx.b', 200]]),
    );
    expect(candidates[0].ancestorNodes).toEqual([]);
  });

  it('produces candidates in post-order and records strict ancestor chain for nested joins', () => {
    const a = makeScan('mx.a', 100);
    const b = makeScan('mx.b', 200);
    const c = makeScan('mx.c', 50);
    const innerJoin = { name: 'SortMergeJoin', detail: '[id#1], [id#2], Inner', metrics: [], children: [a, b] };
    const outerJoin = { name: 'BroadcastHashJoin', detail: '[id#3], [id#4], Inner, BuildRight', metrics: [], children: [innerJoin, c] };
    const candidates = findCompositeCandidates(outerJoin);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].node).toBe(innerJoin); // post-order: descendant before ancestor
    expect(candidates[1].node).toBe(outerJoin);
    expect(candidates[0].ancestorNodes).toEqual([outerJoin]);
    expect(candidates[1].ancestorNodes).toEqual([]);
  });

  it('two structurally identical joins (same condition) produce the same fingerprint', () => {
    const j1 = { name: 'SortMergeJoin', detail: '[id#1], [id#2], Inner', metrics: [], children: [makeScan('mx.a', 1), makeScan('mx.b', 1)] };
    const j2 = { name: 'SortMergeJoin', detail: '[id#9], [id#8], Inner', metrics: [], children: [makeScan('mx.a', 1), makeScan('mx.b', 1)] };
    const [c1] = findCompositeCandidates(j1);
    const [c2] = findCompositeCandidates(j2);
    expect(c1.fingerprint).toBe(c2.fingerprint);
  });

  it('two joins with a different join type produce different fingerprints', () => {
    const j1 = { name: 'SortMergeJoin', detail: '[id#1], [id#2], Inner', metrics: [], children: [makeScan('mx.a', 1), makeScan('mx.b', 1)] };
    const j2 = { name: 'SortMergeJoin', detail: '[id#1], [id#2], LeftOuter', metrics: [], children: [makeScan('mx.a', 1), makeScan('mx.b', 1)] };
    const [c1] = findCompositeCandidates(j1);
    const [c2] = findCompositeCandidates(j2);
    expect(c1.fingerprint).not.toBe(c2.fingerprint);
  });
});
