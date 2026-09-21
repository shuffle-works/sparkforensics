import { expect, test } from 'vitest';

import type { Finding } from '@sparkforensics/core/types.ts';
import { byImpactDesc, byStageAsc, canToggleSort, stageIdOf, sumWallClockLow } from '../../src/view/impact-sort';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    type: 'skew',
    impactBand: 'warning',
    recommendation: 'r',
    ...overrides,
  };
}

function withWallClockLow(low: number): Finding {
  return finding({ impactEstimate: { basis: 'serial', wallClock: { low, high: low }, estimateMethod: 'measured' } });
}

// ── sumWallClockLow ─────────────────────────────────────────────────────────

test('sumWallClockLow returns null for an empty finding list', () => {
  expect(sumWallClockLow([])).toBeNull();
});

test('sumWallClockLow returns null when no finding in the list carries a wallClock estimate', () => {
  expect(sumWallClockLow([finding(), finding({ type: 'gc' })])).toBeNull();
});

test('sumWallClockLow sums only the low bound of each finding carrying a wallClock estimate', () => {
  const findings = [withWallClockLow(100), withWallClockLow(250)];
  expect(sumWallClockLow(findings)).toBe(350);
});

test('sumWallClockLow ignores findings with no wallClock estimate mixed into the list, rather than returning null', () => {
  const findings = [withWallClockLow(100), finding({ type: 'gc' }), withWallClockLow(50)];
  expect(sumWallClockLow(findings)).toBe(150);
});

test('sumWallClockLow uses the low (guaranteed-floor) bound, not high, even when they differ', () => {
  const f = finding({ impactEstimate: { basis: 'contended', wallClock: { low: 10, high: 9000 }, estimateMethod: 'measured' } });
  expect(sumWallClockLow([f])).toBe(10);
});

// ── stageIdOf ────────────────────────────────────────────────────────────────

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

// ── canToggleSort ────────────────────────────────────────────────────────────

test('canToggleSort returns false when cardOpen is false, regardless of findings or rowCount', () => {
  const f = withWallClockLow(100);
  expect(canToggleSort([f], 2, false)).toBe(false);
});

test('canToggleSort returns false when there is no sortable impact, even if cardOpen is true', () => {
  const f = finding({ type: 'gc' });
  expect(canToggleSort([f], 2, true)).toBe(false);
});

test('canToggleSort returns false when rowCount is 1 or less, even if cardOpen is true and there is sortable impact', () => {
  const f = withWallClockLow(100);
  expect(canToggleSort([f], 1, true)).toBe(false);
  expect(canToggleSort([f], 0, true)).toBe(false);
});

test('canToggleSort returns true when cardOpen is true, there is sortable impact, and rowCount > 1', () => {
  const f = withWallClockLow(100);
  expect(canToggleSort([f], 2, true)).toBe(true);
});

// ── byImpactDesc ─────────────────────────────────────────────────────────────

const identityFindings = (f: Finding) => [f];

test('byImpactDesc orders items with a higher summed wallClock.low first', () => {
  const items = [withWallClockLow(100), withWallClockLow(5000)];
  const sorted = [...items].sort(byImpactDesc(identityFindings));
  expect(sorted).toEqual([items[1], items[0]]);
});

test('byImpactDesc sinks a no-estimate item to the bottom, below one with any estimate', () => {
  const noEstimate = finding({ type: 'gc' });
  const withEstimate = withWallClockLow(1);
  const sorted = [...[noEstimate, withEstimate]].sort(byImpactDesc(identityFindings));
  expect(sorted).toEqual([withEstimate, noEstimate]);
});

test('byImpactDesc treats two no-estimate items as a tie (comparator returns 0)', () => {
  const a = finding({ type: 'gc' });
  const b = finding({ type: 'spill' });
  expect(byImpactDesc(identityFindings)(a, b)).toBe(0);
});

test('byImpactDesc is a stable no-op for two equal-impact items, preserving the caller\'s original order', () => {
  const a = withWallClockLow(500);
  const b = withWallClockLow(500);
  const sorted = [a, b].sort(byImpactDesc(identityFindings));
  expect(sorted).toEqual([a, b]);
});

// ── byStageAsc ───────────────────────────────────────────────────────────────

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
