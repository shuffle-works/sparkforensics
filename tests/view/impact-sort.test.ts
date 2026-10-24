import { expect, test } from 'vitest';

import type { Finding } from '@sparkforensics/core/types.ts';
import { byStageAsc, canToggleSort, orderByImpact, stageIdOf } from '../../src/view/impact-sort';
import { installInterpretation } from './_shared/interpretation';

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

test('canToggleSort returns false when cardOpen is false, regardless of findings or rowCount', () => {
  const f = withWallClockLow(100);
  expect(canToggleSort(installInterpretation([f]), [f], 2, false)).toBe(false);
});

test('canToggleSort returns false when no finding in the list is ranked, even if cardOpen is true', () => {
  const f = finding({ recommendation: '' });
  expect(canToggleSort(installInterpretation([f]), [f], 2, true)).toBe(false);
  expect(canToggleSort(null, [withWallClockLow(100)], 2, true)).toBe(false);
});

test('canToggleSort returns false when rowCount is 1 or less, even if cardOpen is true and a finding is ranked', () => {
  const f = withWallClockLow(100);
  const interpreted = installInterpretation([f]);
  expect(canToggleSort(interpreted, [f], 1, true)).toBe(false);
  expect(canToggleSort(interpreted, [f], 0, true)).toBe(false);
});

test('canToggleSort returns true for ranked findings with no wall-clock claim, which the impact order still moves', () => {
  const findings = [
    finding({ stageId: 1, impactEstimate: { basis: 'serial', estimateMethod: 'none', stageTaskMs: 1_000 } }),
    finding({ stageId: 2, impactEstimate: { basis: 'serial', estimateMethod: 'none', stageTaskMs: 9_000 } }),
  ];
  const interpreted = installInterpretation(findings);

  expect(orderByImpact(interpreted, findings, (f) => [f])).toEqual([findings[1], findings[0]]);
  expect(canToggleSort(interpreted, findings, 2, true)).toBe(true);
});

const identityFindings = (f: Finding) => [f];

function onStage(type: string, stageId: number, wallClockMs: number, stageTaskMs: number): Finding {
  return finding({
    type,
    stageId,
    impactEstimate: { basis: 'serial', wallClock: { low: wallClockMs, high: wallClockMs }, estimateMethod: 'measured', stageTaskMs },
  });
}

test('orderByImpact lists rows in verdict step order when stage task time and wall-clock savings disagree', () => {
  const catalog = [
    onStage('spill', 1, 90_000, 1_000_000),
    onStage('skew', 2, 5_000, 9_000_000),
    onStage('gc', 3, 40_000, 4_000_000),
  ];
  const interpreted = installInterpretation(catalog);
  const verdictOrder = interpreted.data.verdict.steps.map((step) => interpreted.findings[step.leadIndex]);

  expect(verdictOrder).toEqual([catalog[1], catalog[2], catalog[0]]);
  expect(orderByImpact(interpreted, catalog, identityFindings)).toEqual(verdictOrder);
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
