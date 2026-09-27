import { expect, test } from 'vitest';

import type { Finding } from '@sparkforensics/core/types.ts';
import {
  formatTriageCopy,
  rankTriageTargets,
  selectTriageTarget,
  selectTriageTargetForFinding,
} from '../../src/view/triage-target';
import type { InterpretationState } from '@/store/store';
import { installInterpretation } from './_shared/interpretation';

// The ranking comes from the interpretation's savingsRank, so each catalog is interpreted the
// way the live app does before its targets are selected.
const select = (catalog: Finding[]) => selectTriageTarget(installInterpretation(catalog), catalog);
const rank = (catalog: Finding[]) => rankTriageTargets(installInterpretation(catalog), catalog);

function finding(overrides: Record<string, unknown> = {}): Finding {
  return {
    type: 'spill',
    stageId: 7,
    impactBand: 'warning',
    recommendation: 'Reduce memory pressure.',
    ...overrides,
  } as unknown as Finding;
}

function withSavingsMs(overrides: Record<string, unknown> & { type: string }, highMs: number): Finding {
  return finding({
    ...overrides,
    impactEstimate: { basis: 'serial', wallClock: { low: highMs, high: highMs }, estimateMethod: 'measured' },
  });
}

test('prefers larger potential savings over impact band', () => {
  // A critical finding whose occupancy-clipped recoverable time is
  // negligible must not outrank a warning finding with a real, large
  // recoverable-time estimate: impact band describes how anomalous a finding
  // looks, not how much wall-clock time fixing it actually recovers.
  const catalog: Finding[] = [
    withSavingsMs({ type: 'spill', stageId: 7, impactBand: 'warning', recommendation: 'Reduce memory pressure.' }, 500_000),
    withSavingsMs({ type: 'skew', stageId: 12, impactBand: 'critical', recommendation: 'Rebalance partitions.' }, 1),
    withSavingsMs({ type: 'stageShape', stageId: 3, impactBand: 'critical', recommendation: 'Increase parallelism.' }, 50_000),
  ];

  expect(select(catalog)).toMatchObject({ finding: catalog[0], widgetId: 'spill' });
});

test('falls back to impact band, then registry widget order, then catalog order, when no finding has a quantified savings estimate', () => {
  const catalog: Finding[] = [
    finding({ type: 'spill', stageId: 7, impactBand: 'warning', recommendation: 'Reduce memory pressure.' }),
    finding({ type: 'skew', stageId: 12, impactBand: 'critical', recommendation: 'Rebalance partitions.' }),
    finding({ type: 'spill', stageId: 9, impactBand: 'critical', recommendation: 'Reduce spill.' }),
  ];

  // None of the three carry an impactEstimate, so impact band leads: both
  // critical findings outrank the warning listed first, and between them
  // 'spill' (DETECTORS order 10) is ranked ahead of 'task-skew' (order 30).
  expect(rank(catalog).map((target) => target.finding)).toEqual([catalog[2], catalog[1], catalog[0]]);
  expect(select(catalog)).toMatchObject({ finding: catalog[2], widgetId: 'spill' });
});

test('uses alert widget order before reference widgets when impact bands tie', () => {
  const catalog = [
    finding({ type: 'memoryUtilization', stageId: null, impactBand: 'critical', recommendation: 'Review allocation.' }),
    finding({ type: 'spill', stageId: 9, impactBand: 'critical', recommendation: 'Reduce spill.' }),
  ];

  expect(select(catalog)).toMatchObject({ finding: catalog[1], widgetId: 'spill', region: 'action' });
});

test('skips findings without an actionable mapped route', () => {
  const catalog = [
    finding({ recommendation: undefined }),
    finding({ type: 'skew', recommendation: '   ' }),
    finding({ type: 'notMapped', recommendation: 'Handle this.' }),
    finding({ type: 'broadcastSizing', stageId: null, impactBand: 'critical', recommendation: 'Check join size.' }),
    finding({ type: 'spill', impactBand: 'warning', recommendation: '  Reduce spill.  ' }),
  ];

  expect(select(catalog)).toMatchObject({
    finding: catalog[4],
    recommendation: 'Reduce spill.',
    widgetId: 'spill',
  });
});

test('routes the emitted broadcast subtypes rather than the detector-only type', () => {
  const under = finding({ type: 'underBroadcast', stageId: null, impactBand: 'info', recommendation: 'Use a broadcast join.' });
  const over = finding({ type: 'overBroadcast', stageId: null, impactBand: 'warning', recommendation: 'Avoid a large broadcast.' });

  expect(select([under])).toMatchObject({ widgetId: 'under-broadcast', findingLabel: 'missed broadcast join' });
  expect(select([over])).toMatchObject({ widgetId: 'over-broadcast', findingLabel: 'oversized broadcast join' });
});

test('does not infer a stage from SQL stageIds and formats numeric stages only', () => {
  const sqlFinding = finding({
    type: 'smallFiles',
    stageId: null,
    executionId: 42,
    stageIds: [5, 6],
    recommendation: 'Compact the inputs.',
  });
  const stageFinding = finding({ type: 'spill', stageId: 5, recommendation: 'Reduce spill.' });

  const sqlTarget = select([sqlFinding]);
  const stageTarget = select([stageFinding]);

  expect(sqlTarget).toMatchObject({ stageId: null });
  expect(formatTriageCopy(sqlTarget!).actionLabel).toBe('Start with small files');
  expect(formatTriageCopy(stageTarget!).actionLabel).toBe('Start with spill in Stage 5');
});

test('returns no target when the catalog has no routeable recommendation', () => {
  expect(select([])).toBeNull();
  expect(select([finding({ recommendation: ' ' })])).toBeNull();
});

test('resolves reference-present findings and rejects value-equal non-present ones', () => {
  const first = finding({ type: 'spill', stageId: 4, recommendation: 'Reduce spill.' });
  const second = finding({ ...first });
  const catalog = [first, second];

  expect(selectTriageTargetForFinding(first, catalog)).toMatchObject({ finding: first, widgetId: 'spill' });
  expect(selectTriageTargetForFinding(second, catalog)).toMatchObject({ finding: second, widgetId: 'spill' });
  // Value-equal but not reference-present: reference identity detects staleness.
  expect(selectTriageTargetForFinding(finding({ ...second }), catalog)).toBeNull();
});

test('formats an app-level low-confidence target without raw fallback fields', () => {
  const target = select([finding({
    type: 'memoryUtilization',
    stageId: null,
    impactBand: 'warning',
    recommendation: 'Review executor allocation.',
    confidence: 'low',
    validationRequired: 'Confirm against the Spark UI.',
  })]);

  expect(formatTriageCopy(target!)).toMatchObject({
    actionLabel: 'Start with memory utilization',
    confidence: 'low',
    validationRequired: 'Confirm against the Spark UI.',
  });
});

test('omits high-confidence and non-string validation copy without exposing raw finding fields', () => {
  const target = select([finding({
    type: 'stageShape',
    stageId: 8,
    confidence: 'high',
    validationRequired: true as unknown as string,
    recommendation: 'Increase parallelism.',
  })]);
  const copy = formatTriageCopy(target!);

  expect(copy).toMatchObject({ confidence: null, validationRequired: null });
  for (const value of Object.values(copy)) {
    expect(value ?? '').not.toContain('undefined');
    expect(value ?? '').not.toContain('stageShape');
  }
});

test('orders targets by the interpretation\'s savingsRank, not by re-ranking the findings', () => {
  const catalog = [
    withSavingsMs({ type: 'spill', stageId: 7, recommendation: 'Reduce memory pressure.' }, 500_000),
    withSavingsMs({ type: 'skew', stageId: 12, recommendation: 'Rebalance partitions.' }, 1),
  ];
  const interpreted = installInterpretation(catalog);
  // An interpretation from a core that ranked these the other way round: its order wins.
  const reversed: InterpretationState = {
    ...interpreted,
    data: { ...interpreted.data, savingsRank: [...interpreted.data.savingsRank].reverse() },
  };

  expect(rankTriageTargets(reversed, catalog).map((target) => target.finding)).toEqual([catalog[1], catalog[0]]);
  expect(selectTriageTarget(reversed, catalog)).toMatchObject({ finding: catalog[1] });
});

test('keeps only the given findings and has no target without an interpretation', () => {
  const catalog = [
    finding({ type: 'spill', stageId: 7, impactBand: 'critical', recommendation: 'Reduce spill.' }),
    finding({ type: 'skew', stageId: 12, impactBand: 'warning', recommendation: 'Rebalance partitions.' }),
  ];
  const interpreted = installInterpretation(catalog);

  expect(rankTriageTargets(interpreted, [catalog[1]]).map((target) => target.finding)).toEqual([catalog[1]]);
  expect(selectTriageTarget(null, catalog)).toBeNull();
});
