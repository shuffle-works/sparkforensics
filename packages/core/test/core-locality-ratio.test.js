import { describe, it, expect } from 'vitest';
import { computeCoreLocalityRatio } from '../src/core-locality-ratio.js';

describe('computeCoreLocalityRatio', () => {
  it('returns ratio 0 for an all-local run', () => {
    const stages = [{ id: 1, localityStats: [{ locality: 'PROCESS_LOCAL', count: 100 }] }];
    const r = computeCoreLocalityRatio(stages);
    expect(r.totalTasks).toBe(100);
    expect(r.nonLocalTasks).toBe(0);
    expect(r.ratio).toBe(0);
  });

  it('returns ratio 1 for an all-remote run', () => {
    const stages = [{ id: 1, localityStats: [{ locality: 'ANY', count: 50 }] }];
    const r = computeCoreLocalityRatio(stages);
    expect(r.totalTasks).toBe(50);
    expect(r.nonLocalTasks).toBe(50);
    expect(r.ratio).toBe(1);
  });

  it('sums RACK_LOCAL + ANY into the numerator; NO_PREF stays denominator-only', () => {
    const stages = [{
      id: 1,
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 40 },
        { locality: 'NODE_LOCAL', count: 20 },
        { locality: 'NO_PREF', count: 30 },
        { locality: 'RACK_LOCAL', count: 6 },
        { locality: 'ANY', count: 4 },
      ],
    }];
    const r = computeCoreLocalityRatio(stages);
    expect(r.totalTasks).toBe(100);
    expect(r.nonLocalTasks).toBe(10);
    expect(r.ratio).toBe(0.1);
  });

  it('a stage entirely NO_PREF (shuffle-heavy, no real locality problem) contributes 0 to the numerator', () => {
    const stages = [{ id: 1, localityStats: [{ locality: 'NO_PREF', count: 100 }] }];
    const r = computeCoreLocalityRatio(stages);
    expect(r.totalTasks).toBe(100);
    expect(r.nonLocalTasks).toBe(0);
    expect(r.ratio).toBe(0);
  });

  it('returns the EMPTY sentinel for an empty stages array', () => {
    const r = computeCoreLocalityRatio([]);
    expect(r).toEqual({ totalTasks: null, nonLocalTasks: null, ratio: null, topStages: [] });
  });

  it('returns the EMPTY sentinel when no stage carries localityStats', () => {
    const r = computeCoreLocalityRatio([{ id: 1 }, { id: 2, localityStats: [] }]);
    expect(r).toEqual({ totalTasks: null, nonLocalTasks: null, ratio: null, topStages: [] });
  });

  it('does not throw when stages is not an array', () => {
    expect(() => computeCoreLocalityRatio(undefined)).not.toThrow();
    expect(computeCoreLocalityRatio(undefined).topStages).toEqual([]);
  });

  it('ranks topStages by nonLocalTasks descending, capped at topN (default 5)', () => {
    const stages = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      localityStats: [{ locality: 'ANY', count: (i + 1) * 10 }],
    }));
    const r = computeCoreLocalityRatio(stages);
    expect(r.topStages).toHaveLength(5);
    expect(r.topStages.map((s) => s.stageId)).toEqual([7, 6, 5, 4, 3]);
  });

  it('excludes stages below minTasksPerStage from topStages; the boundary (== minTasksPerStage) is included', () => {
    const stages = [
      { id: 1, localityStats: [{ locality: 'ANY', count: 9 }] },
      { id: 2, localityStats: [{ locality: 'ANY', count: 10 }] },
      { id: 3, localityStats: [{ locality: 'ANY', count: 50 }] },
    ];
    const r = computeCoreLocalityRatio(stages);
    expect(r.topStages.map((s) => s.stageId)).toEqual([3, 2]);
    expect(r.totalTasks).toBe(69);
    expect(r.nonLocalTasks).toBe(69);
  });

  it('honors custom minTasksPerStage and topN options', () => {
    const stages = [
      { id: 1, localityStats: [{ locality: 'ANY', count: 5 }] },
      { id: 2, localityStats: [{ locality: 'ANY', count: 4 }] },
      { id: 3, localityStats: [{ locality: 'ANY', count: 20 }] },
      { id: 4, localityStats: [{ locality: 'ANY', count: 15 }] },
    ];
    const r = computeCoreLocalityRatio(stages, { minTasksPerStage: 5, topN: 2 });
    expect(r.topStages.map((s) => s.stageId)).toEqual([3, 4]);
    expect(r.totalTasks).toBe(44);
    expect(r.nonLocalTasks).toBe(44);
  });

  it('topStages entries carry stageId, nonLocalTasks, taskCount, and ratio', () => {
    const stages = [{
      id: 1,
      localityStats: [{ locality: 'PROCESS_LOCAL', count: 8 }, { locality: 'ANY', count: 2 }],
    }];
    const r = computeCoreLocalityRatio(stages);
    expect(r.topStages).toEqual([{ stageId: 1, nonLocalTasks: 2, taskCount: 10, ratio: 0.2 }]);
  });
});
