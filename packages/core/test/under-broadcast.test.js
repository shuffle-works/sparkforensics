import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyzer.js';
import { coreFindingGenericRecommendation } from '../src/finding-generic-recommendation.ts';
import { makeApp } from './fixtures/stage-app-fixtures.js';

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

// A shuffle exchange read half over the write half that carries the metrics, as the parser builds it.
const shuffle = (bytes, id) => ({
  name: 'Exchange', detail: 'Exchange hashpartitioning(k#1L, 200)', id: `r${id}`, exchangeRole: 'read', metrics: [],
  children: [{ name: 'Exchange', detail: '', id: `w${id}`, exchangeRole: 'write', metrics: [{ name: 'data size', value: bytes, metricType: 'size' }], children: [] }],
});
// A join side as AQE prints it: Sort over a materialized query stage over the exchange.
const side = (bytes, id) => ({
  name: 'Sort', detail: '', metrics: [], children: [{ name: 'ShuffleQueryStage', detail: '', metrics: [], children: [shuffle(bytes, id)] }],
});
const join = (joinType, leftBytes, rightBytes) => ({
  name: 'SortMergeJoin', detail: `SortMergeJoin [a#1L], [b#2L], ${joinType}`, metrics: [],
  children: [side(leftBytes, 'L'), side(rightBytes, 'R')],
});
const aqe = (child) => ({ name: 'AdaptiveSparkPlan', detail: '', metrics: [], children: [child] });

function findingsOf(type, planTree, { config, modifiedConfigs, sparkVersion = '3.5.3', thresholds } = {}) {
  const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree, modifiedConfigs }]]);
  return analyze(makeApp({ config, sparkVersion }), new Map(), [], [], new Map(), sql, null, { thresholds })
    .filter((f) => f.type === type);
}
const under = (planTree, opts) => findingsOf('underBroadcast', planTree, opts);

describe('underBroadcast: join type decides which side can be broadcast', () => {
  // Spark's canBuildBroadcastLeft / canBuildBroadcastRight (JoinSelectionHelper, apache/spark v3.5.0).
  const small = 5 * MiB;
  const large = 20 * GiB;

  it.each([
    ['Inner', 'left'], ['Cross', 'left'], ['RightOuter', 'left'],
  ])('%s join with a small left side broadcasts the left', (joinType, buildSide) => {
    const [f] = under(join(joinType, small, large));
    expect(f.buildSide).toBe(buildSide);
    expect(f.joinType).toBe(joinType);
    expect(f.value).toBe(small);
  });

  it.each(['Inner', 'Cross', 'LeftOuter', 'LeftSemi', 'LeftAnti', 'ExistenceJoin(exists#9)'])(
    '%s join with a small right side broadcasts the right', (joinType) => {
      const [f] = under(join(joinType, large, small));
      expect(f.buildSide).toBe('right');
      expect(f.value).toBe(small);
    },
  );

  it.each(['LeftOuter', 'LeftSemi', 'LeftAnti', 'ExistenceJoin(exists#9)'])(
    '%s join with only a small left side has no side to build from', (joinType) => {
      expect(under(join(joinType, small, large))).toHaveLength(0);
    },
  );

  it('RightOuter join with only a small right side has no side to build from', () => {
    expect(under(join('RightOuter', large, small))).toHaveLength(0);
  });

  it('FullOuter join never fires, whichever side is small', () => {
    expect(under(join('FullOuter', small, large))).toHaveLength(0);
    expect(under(join('FullOuter', large, small))).toHaveLength(0);
  });

  it('an Inner join builds from the smaller of its two sides', () => {
    expect(under(join('Inner', small, small * 2))[0].buildSide).toBe('left');
    expect(under(join('Inner', small * 2, small))[0].buildSide).toBe('right');
  });

  it('a LeftOuter join with a large right side is judged by the right side, not the smaller left', () => {
    expect(under(join('LeftOuter', small, large))).toHaveLength(0);
  });

  it('skips a join whose type the detail does not name', () => {
    const plan = join('Inner', small, large);
    plan.detail = 'SortMergeJoin';
    expect(under(plan)).toHaveLength(0);
  });

  it('skips a join whose only buildable side is the larger one, since broadcasting it saves nothing', () => {
    expect(under(join('LeftOuter', 2 * MiB, 500 * MiB), { config: { 'spark.sql.autoBroadcastJoinThreshold': '1g' } })).toHaveLength(0);
  });

  it('reports the build side as the smaller side and the other as the larger', () => {
    const [f] = under(join('LeftOuter', 500 * MiB, 2 * MiB), { config: { 'spark.sql.autoBroadcastJoinThreshold': '1g' } });
    expect(f.buildSide).toBe('right');
    expect(f.buildSideBytes).toBe(2 * MiB);
    expect(f.value).toBe(2 * MiB);
    expect(f.largerSideBytes).toBe(500 * MiB);
    expect(coreFindingGenericRecommendation(f)).toContain('admits the right side');
  });

  it('names the join type and side in the recommendation', () => {
    const [f] = under(join('LeftSemi', large, small));
    expect(f.recommendation).toContain('right input to this LeftSemi Sort Merge Join');
  });
});

describe('underBroadcast: sides without a size of their own', () => {
  it('uses the build side alone when the other side is another join\'s output', () => {
    const nested = { name: 'SortMergeJoin', detail: 'SortMergeJoin [a#1L], [c#3L], Inner', metrics: [], children: [side(GiB, 'A'), side(GiB, 'B')] };
    const plan = { ...join('Inner', 0, 5 * MiB), children: [nested, side(5 * MiB, 'R')] };
    const [f] = under(plan);
    expect(f.buildSide).toBe('right');
    expect(f.largerSideBytes).toBeUndefined();
  });

  it('does not sum the shuffles below a nested join into that side\'s size', () => {
    const nested = { name: 'SortMergeJoin', detail: 'SortMergeJoin [a#1L], [c#3L], Inner', metrics: [], children: [side(40 * GiB, 'A'), side(40 * GiB, 'B')] };
    const plan = { ...join('Inner', 0, 0), children: [nested, side(50 * MiB, 'R')] };
    // 50 MiB is over the 10 MiB threshold and has no measured partner to justify a higher one.
    expect(under(plan)).toHaveLength(0);
  });

  it('skips a side that is a reused exchange', () => {
    const reused = { name: 'Sort', detail: '', metrics: [], children: [{ name: 'ReusedExchange', detail: '', metrics: [], children: [] }] };
    const plan = { ...join('Inner', 0, 0), children: [reused, reused] };
    expect(under(plan)).toHaveLength(0);
  });

  it('does not take a BroadcastExchange for a shuffle side', () => {
    const bx = { name: 'BroadcastExchange', detail: '', metrics: [{ name: 'data size', value: 5 * MiB, metricType: 'size' }], children: [] };
    const plan = { ...join('Inner', 0, 0), children: [{ name: 'Sort', detail: '', metrics: [], children: [bx] }, side(20 * GiB, 'R')] };
    expect(under(plan)).toHaveLength(0);
  });
});

describe('underBroadcast: effective broadcast threshold', () => {
  const small = 5 * MiB;
  const large = 20 * GiB;
  const plan = (bytes = small) => aqe(join('Inner', bytes, large));

  it('judges against the 10 MiB default when nothing is logged', () => {
    const [f] = under(plan());
    expect(f.broadcastThreshold).toBe('notLimiting');
    expect(f.remediation).toEqual([]);
  });

  it('judges against the logged static threshold without AQE', () => {
    const [f] = under(join('Inner', small, large), { config: { 'spark.sql.autoBroadcastJoinThreshold': '1m' } });
    expect(f.broadcastThreshold).toBe('limits');
    expect(f.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.autoBroadcastJoinThreshold', direction: 'increase', suggested: null }]);
  });

  it('uses the adaptive threshold when AQE ran and it is set, and names that key', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '1m', 'spark.sql.adaptive.autoBroadcastJoinThreshold': '64m' };
    const [f] = under(plan(), { config });
    expect(f.broadcastThreshold).toBe('notLimiting');
  });

  it('falls back to the static threshold under AQE when the adaptive one is unset, and names the static key', () => {
    const [f] = under(plan(), { config: { 'spark.sql.autoBroadcastJoinThreshold': '1m' } });
    expect(f.broadcastThreshold).toBe('limits');
    expect(f.remediation[0].key).toBe('spark.sql.autoBroadcastJoinThreshold');
  });

  it('names the adaptive key when it is the one below the side', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '64m', 'spark.sql.adaptive.autoBroadcastJoinThreshold': '1m' };
    const [f] = under(plan(), { config });
    expect(f.broadcastThreshold).toBe('limits');
    expect(f.remediation[0].key).toBe('spark.sql.adaptive.autoBroadcastJoinThreshold');
    expect(f.recommendation).toContain('spark.sql.adaptive.autoBroadcastJoinThreshold');
    expect(coreFindingGenericRecommendation(f)).toContain('raising spark.sql.adaptive.autoBroadcastJoinThreshold');
  });

  it('ignores the adaptive threshold when the plan is not adaptive', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '1m', 'spark.sql.adaptive.autoBroadcastJoinThreshold': '64m' };
    expect(under(join('Inner', small, large), { config })[0].broadcastThreshold).toBe('limits');
  });

  it('takes a per-query override over the logged value', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '1m' };
    const [f] = under(plan(), { config, modifiedConfigs: { 'spark.sql.autoBroadcastJoinThreshold': '100m' } });
    expect(f.broadcastThreshold).toBe('notLimiting');
  });

  it('takes a per-query adaptive override over the logged static value', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '100m' };
    const [f] = under(plan(), { config, modifiedConfigs: { 'spark.sql.adaptive.autoBroadcastJoinThreshold': '1m' } });
    expect(f.broadcastThreshold).toBe('limits');
  });

  it('treats a threshold equal to the side as admitting it (Spark compares with <=)', () => {
    const [f] = under(plan(), { config: { 'spark.sql.autoBroadcastJoinThreshold': String(small) } });
    expect(f.broadcastThreshold).toBe('notLimiting');
  });

  it('reports disabled auto-broadcast, and still advises raising the key', () => {
    const [f] = under(plan(), { config: { 'spark.sql.autoBroadcastJoinThreshold': '-1' } });
    expect(f.broadcastThreshold).toBe('disabled');
    expect(f.remediation).toHaveLength(1);
  });

  it('fires on a side the threshold admits even when the other side is not far larger', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '200m' };
    const [f] = under(aqe(join('Inner', 150 * MiB, 300 * MiB)), { config });
    expect(f.broadcastThreshold).toBe('notLimiting');
  });

  it('does not fire on a side over the threshold unless the other side is far larger', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '1m' };
    expect(under(aqe(join('Inner', 50 * MiB, 300 * MiB)), { config })).toHaveLength(0);
    expect(under(aqe(join('Inner', 50 * MiB, 20 * GiB)), { config })).toHaveLength(1);
  });
});

describe('underBroadcast: size floor and over-broadcast ceiling', () => {
  it('skips a smaller side too small for a broadcast to save anything measurable', () => {
    expect(under(join('Inner', 39_200, 120_000_000))).toHaveLength(0);
    expect(under(join('Inner', 0, 20 * GiB))).toHaveLength(0);
    expect(under(join('Inner', 2 * MiB, 120 * MiB))).toHaveLength(1);
  });

  it('honors a tuned floor', () => {
    const plan = join('Inner', 2 * MiB, 120 * MiB);
    expect(under(plan, { thresholds: { broadcastSizing: { minSmallerSideBytes: 4 * MiB } } })).toHaveLength(0);
  });

  it('never suggests broadcasting a side the over-broadcast finding would flag', () => {
    // A 3 GiB side is over the 1 GiB limit, so even a threshold that admits it does not make it a suggestion.
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '8g' };
    expect(under(join('Inner', 3 * GiB, 2048 * GiB), { config })).toHaveLength(0);
    expect(under(join('Inner', 1.5 * GiB, 2048 * GiB), { config })).toHaveLength(0);
  });

  it('still suggests a side just under the over-broadcast limit', () => {
    expect(under(join('Inner', 900 * MiB, 2048 * GiB))).toHaveLength(1);
  });

  it('honors a tuned over-broadcast limit as the ceiling', () => {
    const plan = join('Inner', 900 * MiB, 2048 * GiB);
    expect(under(plan, { thresholds: { broadcastSizing: { overBroadcastBytes: 512 * MiB } } })).toHaveLength(0);
  });
});

describe('overBroadcast: effective broadcast threshold', () => {
  const broadcast = (bytes) => ({
    name: 'BroadcastHashJoin', detail: 'BroadcastHashJoin [a#1L], [b#2L], Inner, BuildRight', metrics: [],
    children: [side(20 * GiB, 'L'), { name: 'BroadcastExchange', detail: '', id: 'bx', metrics: [{ name: 'data size', value: bytes, metricType: 'size' }], children: [] }],
  });

  it('judges an AQE runtime broadcast against the adaptive threshold, not as hint-forced', () => {
    const config = { 'spark.sql.adaptive.autoBroadcastJoinThreshold': '2g' };
    const [f] = findingsOf('overBroadcast', aqe(broadcast(1.5 * GiB)), { config });
    expect(f.broadcastThreshold).toBe('limits');
    expect(f.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.adaptive.autoBroadcastJoinThreshold', direction: 'decrease', suggested: null }]);
    expect(f.recommendation).toContain('misconfigured spark.sql.adaptive.autoBroadcastJoinThreshold');
    expect(coreFindingGenericRecommendation(f)).toContain('misconfigured spark.sql.adaptive.autoBroadcastJoinThreshold');
  });

  it('names the static key when it admitted a broadcast planned up front under AQE', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '4g', 'spark.sql.adaptive.autoBroadcastJoinThreshold': '10m' };
    const [f] = findingsOf('overBroadcast', aqe(broadcast(1.5 * GiB)), { config });
    expect(f.broadcastThreshold).toBe('limits');
    expect(f.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.autoBroadcastJoinThreshold', direction: 'decrease', suggested: null }]);
    expect(f.recommendation).toContain('misconfigured spark.sql.autoBroadcastJoinThreshold.');
  });

  it('does not call auto-broadcast disabled under AQE while the static threshold admits the broadcast', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '4g', 'spark.sql.adaptive.autoBroadcastJoinThreshold': '-1' };
    const [f] = findingsOf('overBroadcast', aqe(broadcast(1.5 * GiB)), { config });
    expect(f.broadcastThreshold).toBe('limits');
    expect(f.remediation.map((r) => r.key)).toEqual(['spark.sql.autoBroadcastJoinThreshold']);
  });

  it('calls it hint-forced under AQE only when both thresholds are below the broadcast', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '20m', 'spark.sql.adaptive.autoBroadcastJoinThreshold': '10m' };
    const [f] = findingsOf('overBroadcast', aqe(broadcast(1.5 * GiB)), { config });
    expect(f.broadcastThreshold).toBe('notLimiting');
    expect(f.remediation).toEqual([]);
    expect(f.recommendation).toContain('spark.sql.autoBroadcastJoinThreshold (21 MB) and spark.sql.adaptive.autoBroadcastJoinThreshold (10 MB) are below it');
  });

  it('calls auto-broadcast disabled under AQE only when both thresholds are disabled', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '-1', 'spark.sql.adaptive.autoBroadcastJoinThreshold': '-1' };
    const [f] = findingsOf('overBroadcast', aqe(broadcast(1.5 * GiB)), { config });
    expect(f.broadcastThreshold).toBe('disabled');
    expect(f.remediation).toEqual([]);
  });

  it('names both keys when both admitted the broadcast', () => {
    const config = { 'spark.sql.autoBroadcastJoinThreshold': '4g', 'spark.sql.adaptive.autoBroadcastJoinThreshold': '2g' };
    const [f] = findingsOf('overBroadcast', aqe(broadcast(1.5 * GiB)), { config });
    expect(f.remediation.map((r) => r.key)).toEqual(['spark.sql.autoBroadcastJoinThreshold', 'spark.sql.adaptive.autoBroadcastJoinThreshold']);
    expect(coreFindingGenericRecommendation(f)).toContain('misconfigured spark.sql.autoBroadcastJoinThreshold or spark.sql.adaptive.autoBroadcastJoinThreshold');
  });

  it('keeps the static threshold for a plan that is not adaptive', () => {
    const config = { 'spark.sql.adaptive.autoBroadcastJoinThreshold': '2g' };
    const [f] = findingsOf('overBroadcast', broadcast(1.5 * GiB), { config });
    expect(f.broadcastThreshold).toBe('notLimiting');
  });
});
