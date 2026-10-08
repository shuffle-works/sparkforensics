import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyzer.js';
import { collectRun } from '../src/cli/collect-run.js';
import { outputRowsOf, ownOutputRows, parseNestedLoopJoin } from '../src/nested-loop-join.js';
import { makeApp, makeStage } from './fixtures/stage-app-fixtures.js';

// A 3000 x 3000 `a < b` join and a 3000 x 3000 cross join, generated on Spark 3.5.9 in local mode
// (spark.sql.autoBroadcastJoinThreshold=-1 for the cross join) and trimmed to the two executions.
const SPIKE_LOG = fileURLToPath(new URL('./fixtures/nested-loop-join-spark-3.5.9.ndjson', import.meta.url));

const rows = (value) => [{ name: 'number of output rows', value, metricType: 'sum', executorSide: true }];
const plan = (name, detail, metrics, children = [], stageIds = [1]) => ({ id: `${name}-${detail}`, name, detail, metrics, children, stageIds });
const range = (value) => plan('Range', 'Range (0, 3000, step=1, splits=4)', rows(value));

// BNLJ over a streamed Range and a BroadcastExchange (read half over its write half).
function bnlj({ out, left, right, detail = 'BroadcastNestedLoopJoin BuildRight, Inner, (a#2L < b#6L)' }) {
  const broadcastWrite = plan('BroadcastExchange', '', rows(right), [range(right)]);
  const broadcastRead = plan('BroadcastExchange', 'BroadcastExchange IdentityBroadcastMode', [], [broadcastWrite]);
  return plan('BroadcastNestedLoopJoin', detail, rows(out), [plan('Project', 'Project [id#0L AS a#2L]', [], [range(left)]), broadcastRead]);
}

function findingsFor(planTree, stageOverrides = {}, runMs = 10_000) {
  const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree }]]);
  const stages = new Map([[1, makeStage({ sqlExecutionId: 1, completedAt: runMs, taskActiveMs: runMs, ...stageOverrides })]]);
  return analyze(makeApp({ endTime: runMs }), stages, [], [], new Map(), sql).filter((f) => f.type === 'nestedLoopJoin');
}

describe('parseNestedLoopJoin', () => {
  it('reads the join type and condition of a BroadcastNestedLoopJoin, without expression ids', () => {
    expect(parseNestedLoopJoin({ name: 'BroadcastNestedLoopJoin', detail: 'BroadcastNestedLoopJoin BuildRight, LeftOuter, ((a#2L + b#6L) > 100)' }))
      .toEqual({ operator: 'BroadcastNestedLoopJoin', joinType: 'LeftOuter', condition: '((a + b) > 100)' });
  });

  it('reads a conditionless BroadcastNestedLoopJoin as a cross join without condition', () => {
    expect(parseNestedLoopJoin({ name: 'BroadcastNestedLoopJoin', detail: 'BroadcastNestedLoopJoin BuildLeft, Cross' }))
      .toEqual({ operator: 'BroadcastNestedLoopJoin', joinType: 'Cross', condition: null });
  });

  it('reads a CartesianProduct with and without a condition', () => {
    expect(parseNestedLoopJoin({ name: 'CartesianProduct', detail: 'CartesianProduct' }))
      .toEqual({ operator: 'CartesianProduct', joinType: 'Inner', condition: null });
    expect(parseNestedLoopJoin({ name: 'CartesianProduct', detail: 'CartesianProduct ((a#2L = b#6L) OR (a#2L < 3))' }))
      .toEqual({ operator: 'CartesianProduct', joinType: 'Inner', condition: '((a = b) OR (a < 3))' });
  });

  it('ignores every other operator', () => {
    expect(parseNestedLoopJoin({ name: 'SortMergeJoin', detail: 'SortMergeJoin [a#2L], [b#6L], Inner' })).toBeNull();
  });
});

describe('outputRowsOf', () => {
  it('walks row-preserving operators down to the nearest row metric', () => {
    const tree = plan('WholeStageCodegen (1)', '', [], [plan('Project', '', [], [range(3000)])]);
    expect(outputRowsOf(tree)).toBe(3000);
    expect(ownOutputRows(tree)).toBeNull();
  });

  it('gives up at an operator that can change the row count and reports no rows', () => {
    expect(outputRowsOf(plan('Expand', '', [], [range(3000)]))).toBeNull();
    expect(outputRowsOf(plan('Union', '', [], [range(1), range(2)]))).toBeNull();
  });
});

describe('nestedLoopJoin detector on a hand-built plan', () => {
  it('flags a non-equi BroadcastNestedLoopJoin whose output dwarfs both inputs, with the condition and the stage time', () => {
    const [f] = findingsFor(bnlj({ out: 4_498_500, left: 3000, right: 3000 }));
    expect(f).toMatchObject({
      type: 'nestedLoopJoin', executionId: 1, stageIds: [1], metric: 'outputRows', value: 4_498_500,
      nodeName: 'BroadcastNestedLoopJoin', joinType: 'Inner', condition: '(a < b)', leftRows: 3000, rightRows: 3000,
    });
    expect(f.recommendation).toContain('(a < b)');
    expect(f.recommendation).toContain('equi-join key');
    expect(f.recommendation).toContain('bucket the range');
    expect(f.remediation).toEqual([{ kind: 'code', hint: expect.stringContaining('equi-join key') }]);
    // The stage that runs the join takes the whole run: graded critical.
    expect(f.impactBand).toBe('critical');
    expect(f.impactEstimate.estimateMethod).toBe('modeled');
  });

  it('grades the finding by the stage time, so a join in a short stage stays info', () => {
    const [f] = findingsFor(bnlj({ out: 4_498_500, left: 3000, right: 3000 }), { completedAt: 20, taskActiveMs: 20 });
    expect(f.impactBand).toBe('info');
  });

  it('asks to confirm a cross join with no condition', () => {
    const [f] = findingsFor(bnlj({ out: 4_500_000, left: 3000, right: 1500, detail: 'BroadcastNestedLoopJoin BuildRight, Cross' }));
    expect(f.condition).toBeNull();
    expect(f.joinType).toBe('Cross');
    expect(f.recommendation).toContain('Confirm the cross join is intended');
  });

  it('flags a CartesianProduct on its output size alone, since its input counts include re-reads', () => {
    const tree = plan('CartesianProduct', 'CartesianProduct', rows(9_000_000), [range(12_000), range(12_000)]);
    const [f] = findingsFor(tree);
    expect(f).toMatchObject({ nodeName: 'CartesianProduct', value: 9_000_000, leftRows: null, rightRows: null, condition: null });
  });

  it('does not flag a join whose output stays near its inputs', () => {
    expect(findingsFor(bnlj({ out: 3_000_000, left: 2_500_000, right: 3000, detail: 'BroadcastNestedLoopJoin BuildRight, LeftOuter, (a#2L < b#6L)' }))).toEqual([]);
  });

  it('does not flag a small output, however large the expansion', () => {
    expect(findingsFor(bnlj({ out: 900_000, left: 3, right: 3 }))).toEqual([]);
  });

  it('does not flag a join with no executor-side row counts', () => {
    expect(findingsFor(plan('BroadcastNestedLoopJoin', 'BroadcastNestedLoopJoin BuildRight, Inner, (a#2L < b#6L)', [], [range(3000), range(3000)]))).toEqual([]);
    const noInput = bnlj({ out: 4_498_500, left: 3000, right: 3000 });
    noInput.children[0] = plan('Project', '', [], [plan('Expand', '', [], [range(3000)])]);
    expect(findingsFor(noInput)).toEqual([]);
  });

  it('does not flag an equi join planned as a sort-merge join', () => {
    expect(findingsFor(plan('SortMergeJoin', 'SortMergeJoin [a#2L], [b#6L], Inner', rows(3000), [range(3000), range(3000)]))).toEqual([]);
  });
});

describe('nestedLoopJoin detector on a generated Spark 3.5.9 log', () => {
  it('flags the 3000 x 3000 a < b join and the cross join, and not the equi join', async () => {
    const { appModel } = await collectRun(SPIKE_LOG);
    const findings = analyze(
      appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed,
      appModel.jobs, appModel.sql, appModel.runAggregates,
    ).filter((f) => f.type === 'nestedLoopJoin');
    expect(findings.map((f) => [f.nodeName, f.value, f.condition]).sort())
      .toEqual([
        ['BroadcastNestedLoopJoin', 4_498_500, '(a < b)'],
        ['CartesianProduct', 9_000_000, null],
      ]);
    const nested = findings.find((f) => f.nodeName === 'BroadcastNestedLoopJoin');
    expect(nested).toMatchObject({ leftRows: 3000, rightRows: 3000, stageIds: [1], executionId: 0 });
  });
});
