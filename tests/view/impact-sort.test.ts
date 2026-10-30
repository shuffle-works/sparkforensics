import { expect, test } from 'vitest';

import { analyze } from '@sparkforensics/core/analyzer.ts';
import type { Finding, Stage } from '@sparkforensics/core/types.ts';
import { makeApp, makeStage } from '../../packages/core/test/fixtures/stage-app-fixtures.js';
import { byStageAsc, canToggleSort, orderByImpact, stageIdOf } from '../../src/view/impact-sort';
import { installInterpretation } from './_shared/interpretation';
import { findingById } from '../../src/view/interpretation';

function finding(overrides: Record<string, unknown> = {}): Finding {
  return {
    type: 'skew',
    impactBand: 'warning',
    recommendation: 'r',
    ...overrides,
  } as unknown as Finding;
}

function withWallClockLow(low: number): Finding {
  return finding({ impactEstimate: { basis: 'serial', wallClock: { low, high: low }, estimateMethod: 'measured' } });
}

test('stageIdOf returns the finding\'s own stageId when set', () => {
  expect(stageIdOf(finding({ stageId: 7 }))).toBe(7);
});

test('stageIdOf treats stageId 0 as a real, valid id, not a missing one', () => {
  expect(stageIdOf(finding({ stageId: 0 }))).toBe(0);
});

test('stageIdOf falls back to the lowest id in stageIds for a multi-stage sql-scope finding', () => {
  expect(stageIdOf(finding({ stageId: null, stageIds: [12, 3, 8] }))).toBe(3);
});

test('stageIdOf prefers stageId over stageIds when both are somehow present', () => {
  expect(stageIdOf(finding({ stageId: 5, stageIds: [1, 2] }))).toBe(5);
});

test('stageIdOf returns null for an app-level finding with neither stageId nor stageIds', () => {
  expect(stageIdOf(finding({ stageId: null }))).toBeNull();
  expect(stageIdOf(finding({ stageId: null, stageIds: [] }))).toBeNull();
});

const identityFindings = (f: Finding) => [f];

function onStage(type: string, stageId: number, wallClockMs: number, stageTaskMs: number): Finding {
  return finding({
    type,
    stageId,
    impactEstimate: { basis: 'serial', wallClock: { low: wallClockMs, high: wallClockMs }, estimateMethod: 'measured', stageTaskMs },
  });
}

const stageOf = (f: Finding) => f.stageId ?? null;

test('canToggleSort returns true when the stage order differs from the impact order', () => {
  const rows = [onStage('gc', 1, 1, 1_000), onStage('gc', 2, 1, 9_000)];
  const interpreted = installInterpretation(rows);

  expect(orderByImpact(interpreted, rows, identityFindings)).toEqual([rows[1], rows[0]]);
  expect(canToggleSort(interpreted, rows, identityFindings, stageOf, true)).toBe(true);
});

test('canToggleSort returns true for ranked findings with no wall-clock claim, which the impact order still moves', () => {
  const rows = [
    finding({ stageId: 1, impactEstimate: { basis: 'serial', estimateMethod: 'none', stageTaskMs: 1_000 } }),
    finding({ stageId: 2, impactEstimate: { basis: 'serial', estimateMethod: 'none', stageTaskMs: 9_000 } }),
  ];

  expect(canToggleSort(installInterpretation(rows), rows, identityFindings, stageOf, true)).toBe(true);
});

test('canToggleSort returns false when the stage order equals the impact order', () => {
  const rows = [onStage('gc', 1, 1, 9_000), onStage('gc', 2, 1, 1_000)];

  expect(canToggleSort(installInterpretation(rows), rows, identityFindings, stageOf, true)).toBe(false);
});

test('canToggleSort returns false when every row sits on one stage', () => {
  const rows = [onStage('gc', 3, 1, 1_000), onStage('gc', 3, 1, 9_000)];

  expect(canToggleSort(installInterpretation(rows), rows, identityFindings, stageOf, true)).toBe(false);
});

test('canToggleSort returns false when no row has a stage', () => {
  const rows = [finding({ type: 'gc', stageId: null, impactEstimate: { basis: 'serial', estimateMethod: 'none', stageTaskMs: 1_000 } }),
    finding({ type: 'gc', stageId: null, impactEstimate: { basis: 'serial', estimateMethod: 'none', stageTaskMs: 9_000 } })];

  expect(canToggleSort(installInterpretation(rows), rows, identityFindings, stageOf, true)).toBe(false);
});

test('canToggleSort returns true when every row has the same impact but the rows are not in stage order', () => {
  const rows = [onStage('gc', 2, 1, 5_000), onStage('gc', 1, 1, 5_000)];

  expect(canToggleSort(installInterpretation(rows), rows, identityFindings, stageOf, true)).toBe(true);
});

test('canToggleSort returns false when cardOpen is false, even if the orders differ', () => {
  const rows = [onStage('gc', 1, 1, 1_000), onStage('gc', 2, 1, 9_000)];

  expect(canToggleSort(installInterpretation(rows), rows, identityFindings, stageOf, false)).toBe(false);
});

test('canToggleSort returns false when no finding in the rows is ranked, even if cardOpen is true', () => {
  const rows = [finding({ stageId: 2, recommendation: '' }), finding({ stageId: 1, recommendation: '' })];

  expect(canToggleSort(installInterpretation(rows), rows, identityFindings, stageOf, true)).toBe(false);
  expect(canToggleSort(null, [withWallClockLow(100), withWallClockLow(200)], identityFindings, stageOf, true)).toBe(false);
});

test('canToggleSort returns false for one row or none', () => {
  const row = onStage('gc', 1, 1, 9_000);
  const interpreted = installInterpretation([row]);

  expect(canToggleSort(interpreted, [row], identityFindings, stageOf, true)).toBe(false);
  expect(canToggleSort(interpreted, [], identityFindings, stageOf, true)).toBe(false);
});

test('orderByImpact lists rows in verdict step order when stage task time and wall-clock savings disagree', () => {
  const catalog = [
    onStage('spill', 1, 90_000, 1_000_000),
    onStage('skew', 2, 5_000, 9_000_000),
    onStage('gc', 3, 40_000, 4_000_000),
  ];
  const interpreted = installInterpretation(catalog);
  const verdictOrder = interpreted.data.verdict.steps.map((step) => findingById(interpreted, step.leadId));

  expect(verdictOrder).toEqual([catalog[1], catalog[2], catalog[0]]);
  expect(orderByImpact(interpreted, catalog, identityFindings)).toEqual(verdictOrder);
});

test('orderByImpact places an idle-allocation finding by its idle core time among stage findings', () => {
  const idle = finding({
    type: 'utilization',
    impactEstimate: { basis: 'resourceOnly', estimateMethod: 'measured', idleCoreTimeMs: { low: 5_000_000, high: 5_000_000 } },
  });
  const [heavy, light] = [onStage('gc', 1, 1, 9_000_000), onStage('gc', 2, 1, 1_000_000)];
  const catalog = [light, idle, heavy];
  const interpreted = installInterpretation(catalog);

  expect(orderByImpact(interpreted, catalog, identityFindings)).toEqual([heavy, idle, light]);
});

test('an analyzed run ranks its idle allocation before a stage finding with less task time', () => {
  // 40 cores held for 100 minutes, busy only for the spilling stage's 6 core-hours: about 60 idle core-hours.
  const MIN = 60_000;
  const app = makeApp({ startTime: 0, endTime: 100 * MIN, resources: { executor: { cores: 4 } } });
  const stage = makeStage({
    submittedAt: 0, completedAt: 90 * MIN, executorRunTime: 360 * MIN,
    shuffleReadBytes: 100e9, memoryBytesSpilled: 50e9, diskBytesSpilled: 20e9,
    executorStats: [{ executorId: '1', taskCount: 100, totalDuration: 360 * MIN }],
  });
  const added = Array.from({ length: 10 }, (_, i) => ({ kind: 'added' as const, executorId: String(i + 1), host: 'h', timestamp: 0, totalCores: 4, resourceProfileId: 0 }));
  const aggregates = { busyCoreMs: 360 * MIN, coreHistogram: [], peakConcurrentCores: 4, perStage: {} };
  const catalog = analyze(app, new Map([[1, stage as Stage]]), added, [], new Map(), new Map(), aggregates);
  expect(catalog.find((f) => f.type === 'utilization')?.impactBand).toBe('warning');
  expect(catalog.find((f) => f.type === 'spill')?.impactBand).not.toBe('info');
  const interpreted = installInterpretation(catalog);
  const steps = interpreted.data.verdict.steps.map((step) => findingById(interpreted, step.leadId)!.type);

  expect(steps.slice(0, 2)).toEqual(['utilization', 'spill']);
  expect(orderByImpact(interpreted, catalog, identityFindings).map((f) => f.type).slice(0, 2)).toEqual(['utilization', 'spill']);
});

test('orderByImpact places a row at its best-ranked finding', () => {
  const [low, mid, high] = [onStage('gc', 1, 1, 1_000), onStage('gc', 2, 1, 2_000), onStage('gc', 3, 1, 3_000)];
  const rows = [{ findings: [low] }, { findings: [mid, high] }];
  const interpreted = installInterpretation([low, mid, high]);

  expect(orderByImpact(interpreted, rows, (row) => row.findings)).toEqual([rows[1], rows[0]]);
});

test('orderByImpact ranks a finding with no stage after one with stage task time, and an unrankable one last', () => {
  const noStage = finding({ type: 'gc' });
  const unrankable = finding({ type: 'gc', stageId: 4, recommendation: '' });
  const ranked = onStage('gc', 2, 1, 1_000);
  const interpreted = installInterpretation([unrankable, noStage, ranked]);

  expect(orderByImpact(interpreted, [unrankable, noStage, ranked], identityFindings)).toEqual([ranked, noStage, unrankable]);
});

test('orderByImpact keeps the given order without an interpretation', () => {
  const items = [onStage('gc', 1, 1, 1_000), onStage('gc', 2, 1, 2_000)];

  expect(orderByImpact(null, items, identityFindings)).toEqual(items);
});

const stageIdAccessor = (id: number | null) => id;

test('byStageAsc orders items by ascending stage number', () => {
  const items = [9, 2, 5];
  const sorted = [...items].sort(byStageAsc(stageIdAccessor));
  expect(sorted).toEqual([2, 5, 9]);
});

test('byStageAsc sinks a null (no-stage) item to the bottom, below any real stage number', () => {
  const items: (number | null)[] = [null, 3];
  const sorted = [...items].sort(byStageAsc(stageIdAccessor));
  expect(sorted).toEqual([3, null]);
});

test('byStageAsc treats two null-stage items as a tie (comparator returns 0)', () => {
  expect(byStageAsc(stageIdAccessor)(null, null)).toBe(0);
});

test('byStageAsc treats two equal stage numbers as a tie, preserving original order (stable sort)', () => {
  const items = [{ id: 4, tag: 'first' }, { id: 4, tag: 'second' }];
  const sorted = [...items].sort(byStageAsc((item) => item.id));
  expect(sorted.map((i) => i.tag)).toEqual(['first', 'second']);
});
