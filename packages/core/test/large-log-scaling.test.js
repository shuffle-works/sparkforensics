import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyzer.ts';
import { maxOf, minOf } from '../src/array-extremes.ts';
import { apiMergeWrites } from '../src/api-merge-writes.ts';
import { computeCoreTimeSeries, coreCountHistogram } from '../src/core-time-series.ts';
import { createState, recordBlockUpdate, removeExecutor } from '../src/event-handlers.ts';
import { parseSparkPlanInfoTree } from '../src/event-schemas.ts';
import { computeRunAggregates } from '../src/run-aggregates.ts';
import { computeRunMetrics } from '../src/run-metrics.ts';
import { indexStagesBySqlExecution, stageIdsForSqlExec } from '../src/sql-stages.ts';
import { computeTaskActiveMs, FIELDS } from '../src/stage-quantiles.ts';
import { makeApp, makeStage } from './fixtures/stage-app-fixtures.js';

// Seeded generator so the randomized comparisons are reproducible.
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const GIB = 1024 ** 3;

function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

// Times the work prepare(size) returns at n and at 2n and asserts the time grows
// about linearly: a quadratic site quadruples. Taking the best of a few runs and
// allowing a small absolute floor keeps a slow or loaded machine from failing it.
// Returns the value of the last run at 2n so the caller can check correctness.
function expectNearLinear(prepare, n) {
  const best = (size) => {
    let fastest = Infinity, value;
    for (let run = 0; run < 3; run++) {
      const result = timed(prepare(size));
      fastest = Math.min(fastest, result.ms);
      value = result.value;
    }
    return { value, ms: fastest };
  };
  const small = best(n);
  const large = best(2 * n);
  expect(large.ms).toBeLessThan(3.5 * small.ms + 50);
  return large.value;
}

describe('analyze() on a log with very many stages', () => {
  it('keeps one finding per flagged stage and unique ids, in linear time', () => {
    const count = 40_000;
    const findings = expectNearLinear((size) => {
      const stages = new Map();
      for (let id = 0; id < size; id++) stages.set(id, makeStage({ id, shuffleReadBytes: 2 * GIB }));
      return () => analyze(makeApp(), stages, [], [], new Map());
    }, count / 2);
    const shuffle = findings.filter((f) => f.type === 'shuffle');
    expect(shuffle).toHaveLength(count);
    expect(new Set(shuffle.map((f) => f.id)).size).toBe(count);
  }, 60_000);
});

describe('maxOf / minOf', () => {
  it('handle empty, small and spread-breaking lists', () => {
    expect(maxOf([])).toBeNull();
    expect(minOf([])).toBeNull();
    expect(maxOf([3, -1, 7, 2])).toBe(7);
    expect(minOf([3, -1, 7, 2])).toBe(-1);
    const big = new Float64Array(500_000).map((_, i) => (i * 7919) % 500_000);
    expect(maxOf(big)).toBe(499_999);
    expect(minOf(big)).toBe(0);
  });
});

describe('computeRunMetrics on a log with 200k stages', () => {
  it('does not throw and reports the run-wide peaks', () => {
    const stages = new Map();
    for (let id = 0; id < 200_000; id++) {
      stages.set(id, makeStage({ id, name: `stage ${id % 50}`, peakExecutionMemoryMax: 100 + id }));
    }
    const appModel = { app: makeApp(), stages, sql: new Map(), jobs: new Map(), executors: { added: [], removed: [] } };
    const metrics = computeRunMetrics(appModel);
    expect(metrics.data.peakExecutionMemoryBytes).toBe(100 + 199_999);
  }, 60_000);
});

describe('stage index by SQL execution', () => {
  it('lists the same stage ids as a scan per execution, in stage order', () => {
    const next = rng(7);
    const stages = new Map();
    for (let id = 0; id < 500; id++) {
      const sqlExecutionId = next() < 0.2 ? null : Math.floor(next() * 40);
      stages.set(id, { id, sqlExecutionId });
    }
    const index = indexStagesBySqlExecution(stages);
    for (let execution = 0; execution < 45; execution++) {
      expect(index.get(execution) ?? []).toEqual(stageIdsForSqlExec(execution, stages));
    }
  });
});

describe('coreCountHistogram', () => {
  it('matches the sweep-line histogram of computeCoreTimeSeries, including tied times', () => {
    const next = rng(11);
    for (let round = 0; round < 20; round++) {
      const intervals = [];
      for (let i = 0; i < 300; i++) {
        const launch = Math.floor(next() * 400);
        intervals.push({ launch, finish: launch + 1 + Math.floor(next() * 60) });
      }
      const expected = computeCoreTimeSeries(intervals, { bucketBy: 'coreCount' }).histogram;
      const actual = coreCountHistogram(
        Float64Array.from(intervals, (i) => i.launch),
        Float64Array.from(intervals, (i) => i.finish),
      );
      expect(actual).toEqual(expected);
    }
  });

  it('is empty for no tasks', () => {
    expect(coreCountHistogram(new Float64Array(0), new Float64Array(0))).toEqual([]);
  });
});

function packTasks(tasks) {
  const arr = new Float64Array(tasks.length * FIELDS.STRIDE);
  tasks.forEach(({ launch, finish }, i) => {
    arr[i * FIELDS.STRIDE + FIELDS.LAUNCH_TIME] = launch;
    arr[i * FIELDS.STRIDE + FIELDS.FINISH_TIME] = finish;
    arr[i * FIELDS.STRIDE + FIELDS.DURATION] = finish - launch;
  });
  return arr;
}

// The union length by merging sorted intervals, the definition computeTaskActiveMs documents.
function unionMs(tasks) {
  const intervals = tasks.filter((t) => t.launch > 0 && t.finish > t.launch).sort((a, b) => a.launch - b.launch);
  let total = 0, start = -Infinity, end = -Infinity;
  for (const { launch, finish } of intervals) {
    if (launch > end) {
      if (end > start) total += end - start;
      start = launch;
      end = finish;
    } else if (finish > end) end = finish;
  }
  return end > start ? total + end - start : total;
}

describe('per-task aggregation without an object per task', () => {
  it('computeTaskActiveMs equals the merged-interval union, gaps and zero launches included', () => {
    const next = rng(23);
    for (let round = 0; round < 20; round++) {
      const tasks = [];
      for (let i = 0; i < 200; i++) {
        const launch = Math.floor(next() * 1000);
        tasks.push({ launch, finish: launch + Math.floor(next() * 40) });
      }
      expect(computeTaskActiveMs(packTasks(tasks))).toBe(unionMs(tasks));
    }
  });

  it('computeRunAggregates matches the interval-list histogram and per-stage sums', () => {
    const next = rng(31);
    const taskStore = new Map();
    const intervals = [];
    for (let stage = 0; stage < 6; stage++) {
      const tasks = [];
      for (let i = 0; i < 100; i++) {
        const launch = Math.floor(next() * 500);
        const task = { launch, finish: launch + Math.floor(next() * 50) };
        tasks.push(task);
        if (task.finish > task.launch) intervals.push(task);
      }
      taskStore.set(stage, packTasks(tasks));
    }
    const result = computeRunAggregates(taskStore);
    const expected = computeCoreTimeSeries(intervals, { bucketBy: 'coreCount' }).histogram;
    expect(result.coreHistogram).toEqual(expected);
    expect(result.peakConcurrentCores).toBe(expected.length - 1);
    expect(result.busyCoreMs).toBe(expected.reduce((sum, ms, k) => sum + k * ms, 0));
    expect(result.perStage[0].taskCount).toBe(100);
  });
});

describe('API merge overlap detection', () => {
  function mergeRuns(spans) {
    // One run of consecutive execution ids per span; the id gap between runs splits them.
    const sql = new Map();
    spans.forEach(([lo, hi], g) => {
      const base = g * 10;
      sql.set(base, { id: base, description: 'MERGE operation - writing new files', startTime: lo });
      sql.set(base + 1, { id: base + 1, description: 'MERGE operation - scanning', startTime: hi });
    });
    return sql;
  }

  it('flags exactly the runs whose start-time spans share a point with another run', () => {
    const next = rng(5);
    for (let round = 0; round < 30; round++) {
      const spans = [];
      for (let g = 0; g < 25; g++) {
        const lo = Math.floor(next() * 400);
        spans.push([lo, lo + Math.floor(next() * 12)]);
      }
      const writes = apiMergeWrites(mergeRuns(spans));
      expect(writes).toHaveLength(spans.length);
      spans.forEach(([lo, hi], g) => {
        const overlaps = spans.some(([olo, ohi], j) => j !== g && olo <= hi && lo <= ohi);
        expect(writes[g].raw.includes('overlaps another merge in time')).toBe(overlaps);
      });
    }
  });

  it('scales to tens of thousands of runs', () => {
    const value = expectNearLinear((size) => {
      const sql = mergeRuns(Array.from({ length: size }, (_, g) => [g * 10, g * 10 + 5]));
      return () => apiMergeWrites(sql);
    }, 30_000);
    expect(value).toHaveLength(60_000);
    expect(value.every((w) => !w.raw.includes('overlaps'))).toBe(true);
  }, 60_000);
});

describe('executor removal drops its cached blocks', () => {
  function blockUpdate(rddId, partition, executor, memory, resident = true) {
    return {
      Event: 'SparkListenerBlockUpdated',
      'Block Updated Info': {
        'Block ID': `rdd_${rddId}_${partition}`,
        'Block Manager ID': { 'Executor ID': executor },
        'Storage Level': { 'Use Memory': resident, 'Use Disk': false, Replication: resident ? 1 : 0 },
        'Memory Size': memory,
        'Disk Size': 0,
      },
    };
  }
  const removal = (executorId) => ({ Event: 'SparkListenerExecutorRemoved', Timestamp: 1, 'Executor ID': executorId });

  it('keeps blocks of other executors, including ids that end in the removed id', () => {
    const state = createState();
    recordBlockUpdate(blockUpdate(1, 0, '1', 10), state);
    recordBlockUpdate(blockUpdate(1, 1, '11', 20), state);
    recordBlockUpdate(blockUpdate(2, 0, '1', 40), state);
    recordBlockUpdate(blockUpdate(2, 0, '2', 80), state);
    removeExecutor(removal('1'), state);
    expect([...state.rddBlocks.get(1).blocks.keys()]).toEqual(['1@11']);
    expect(state.rddBlocks.get(1).memorySize).toBe(20);
    expect([...state.rddBlocks.get(2).blocks.keys()]).toEqual(['0@2']);
    expect(state.rddBlocks.get(2).memorySize).toBe(80);
    expect(state.rddBlocks.get(2).replicasByPartition.get(0)).toBe(1);
    // A block evicted before its executor leaves is not dropped twice.
    recordBlockUpdate(blockUpdate(1, 1, '11', 0, false), state);
    removeExecutor(removal('11'), state);
    expect(state.rddBlocks.get(1).memorySize).toBe(0);
  });

  it('removes thousands of executors without rescanning every block', () => {
    const state = expectNearLinear((executors) => {
      const state = createState();
      for (let e = 0; e < executors; e++) {
        for (let p = 0; p < 50; p++) recordBlockUpdate(blockUpdate(p % 20, e * 50 + p, String(e), 1), state);
      }
      return () => {
        for (let e = 0; e < executors; e++) removeExecutor(removal(String(e)), state);
        return state;
      };
    }, 2000);
    for (const rdd of state.rddBlocks.values()) expect(rdd.blocks.size).toBe(0);
    expect(state.rddBlockKeysByExecutor.size).toBe(0);
  }, 60_000);
});

describe('parseSparkPlanInfoTree on a very wide node', () => {
  it('expands a 200k-child node in order, in linear time', () => {
    const width = 200_000;
    const leaf = (i) => ({ nodeName: `Scan ${i}`, simpleString: '', children: [], metadata: {}, metrics: [] });
    const tree = expectNearLinear((size) => {
      const raw = { ...leaf('root'), nodeName: 'Union', children: Array.from({ length: size }, (_, i) => leaf(i)) };
      return () => parseSparkPlanInfoTree(raw);
    }, width / 2);
    expect(tree.children).toHaveLength(width);
    expect(tree.children[0].nodeName).toBe('Scan 0');
    expect(tree.children[width - 1].nodeName).toBe(`Scan ${width - 1}`);
  }, 60_000);
});
