// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest';

import type { Finding } from '@sparkforensics/core/types.ts';
import { selectAppModel, selectCatalog, selectConfigFindings, store } from '@/store/store';
import {
  bandLandmark,
  BOARD_LANDMARK,
  buildBoardLayout,
  EVIDENCE_CARD_KEY,
  evidenceRowKey,
  resolveRoute,
  VERDICT_LANDMARK,
  walkableLines,
  type BoardLayout,
} from '@/view/board-layout';
import { emptySelection, IMPACT_BANDS } from '@/view/finding-filter';
import { interpretationOf } from '@/view/interpretation';
import { triageTargetFor } from '@/view/triage-target';
import { exampleRuns, loadExampleRun } from './_shared/detector-examples';

// The layout and the route resolver are pure: these tests render nothing.

function layoutOfLoadedRun(density: 'basic' | 'advanced', selection = emptySelection()): { layout: BoardLayout; findings: Finding[] } {
  const state = store.getState();
  const appModel = selectAppModel(state);
  const catalog = selectCatalog(state);
  const configFindings = selectConfigFindings(state);
  const interpretation = state.run ? interpretationOf(state.run) : null;
  return { layout: buildBoardLayout({ interpretation, appModel, catalog, configFindings, selection, density }), findings: [...catalog, ...configFindings] };
}

beforeEach(() => store.getState().resetModel());

describe.each(exampleRuns().flatMap((log) => (['basic', 'advanced'] as const).map((density) => [log, density] as const)))('%s (%s)', (log, density) => {
  test('every routeable finding the board lists resolves to a place that exists in the layout', () => {
    expect(loadExampleRun(log)).toBeNull();
    const { layout, findings } = layoutOfLoadedRun(density, { ...emptySelection(), impactBands: new Set(IMPACT_BANDS) });
    let resolved = 0;
    for (const finding of findings) {
      const target = triageTargetFor(finding);
      const route = target ? resolveRoute(target, layout) : null;
      if (!route) continue;
      resolved += 1;
      for (const card of route.openCards) expect(layout.cards.has(card), `${finding.type} opens ${card}`).toBe(true);
      if (route.cardKey) {
        const card = layout.cards.get(route.cardKey)!;
        expect(route.openCards).toContain(route.cardKey);
        // The row that takes focus is one the card lists.
        expect(card.rowKeys).toContain(route.rowKey);
        // A route into a tab's card shows that tab; a step's panel leaves the tab alone.
        expect(route.tab).toBe(card.tab);
      } else {
        expect(layout.lines.map((line) => line.key)).toContain(route.rowKey);
      }
    }
    expect(resolved).toBeGreaterThan(0);
  });

  test('every verdict step and listed row has a line, and nothing is listed twice', () => {
    expect(loadExampleRun(log)).toBeNull();
    const { layout } = layoutOfLoadedRun(density);
    const keys = layout.lines.map((line) => line.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const step of layout.steps) expect(keys).toContain(step.lineKey);
    for (const band of layout.bands) for (const row of band.rows) expect(keys).toContain(row.lineKey);
  });
});

describe('landmarks and evidence', () => {
  test('the verdict and the board are always routeable; a band only when it has content', () => {
    expect(loadExampleRun(exampleRuns()[0])).toBeNull();
    const { layout } = layoutOfLoadedRun('basic');
    expect(resolveRoute({ kind: 'landmark', id: VERDICT_LANDMARK }, layout)).toMatchObject({ tab: null, rowKey: 'landmark:verdict' });
    expect(resolveRoute({ kind: 'landmark', id: BOARD_LANDMARK }, layout)).toMatchObject({ tab: 'findings' });
    const empty = layout.bands.filter((entry) => entry.listed).map((entry) => entry.band);
    for (const band of IMPACT_BANDS) {
      expect(resolveRoute({ kind: 'landmark', id: bandLandmark(band) }, layout) !== null).toBe(empty.includes(band));
    }
  });

  test('an evidence key opens the ledger card in the Full app report', () => {
    const log = exampleRuns().find((candidate) => {
      loadExampleRun(candidate);
      return (selectAppModel(store.getState()).evidenceAvailability?.entries.length ?? 0) > 0;
    });
    expect(log).toBeDefined();
    expect(loadExampleRun(log!)).toBeNull();
    const { layout } = layoutOfLoadedRun('basic');
    const [key] = layout.evidenceKeys;
    expect(resolveRoute({ kind: 'evidence', key }, layout)).toEqual({
      tab: 'full-report',
      openCards: [EVIDENCE_CARD_KEY],
      cardKey: EVIDENCE_CARD_KEY,
      rowKey: evidenceRowKey(key),
    });
  });
});

describe('filter and walk order', () => {
  test('a finding the filter hides has no place in the layout', () => {
    expect(loadExampleRun(exampleRuns()[0])).toBeNull();
    const all = layoutOfLoadedRun('basic');
    const rowFinding = all.layout.bands.flatMap((band) => band.rows).map((row) => (row.kind === 'finding' ? row.finding : row.group.findings[0]))[0];
    if (!rowFinding) return;
    const hiding = { ...emptySelection(), stages: new Set([-1]) };
    const { layout } = layoutOfLoadedRun('basic', hiding);
    expect(layout.bands.filter((band) => band.listed)).toHaveLength(0);
    expect(layout.holders.get(layout.keyOf(rowFinding))?.line ?? null).toBeNull();
  });

  test('j/k walk the steps, then the rows, and a group lists its members only while expanded', () => {
    expect(loadExampleRun(exampleRuns()[0])).toBeNull();
    const { layout } = layoutOfLoadedRun('basic');
    const collapsed = walkableLines(layout, null);
    expect(collapsed.every((key) => !key.startsWith('member:'))).toBe(true);
    const group = layout.bands.flatMap((band) => band.rows).find((row) => row.kind === 'group');
    if (!group) return;
    const expanded = walkableLines(layout, group.lineKey);
    expect(expanded.length).toBe(collapsed.length + group.memberLineKeys.length);
    expect(expanded.indexOf(group.memberLineKeys[0])).toBe(expanded.indexOf(group.lineKey) + 1);
  });
});
