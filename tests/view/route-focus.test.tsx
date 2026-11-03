// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import { ExportApp } from '@/export/ExportApp';
import { selectAppModel, selectCatalog, selectConfigFindings, store } from '@/store/store';
import { buildBoardLayout, resolveRoute } from '@/view/board-layout';
import { emptySelection } from '@/view/finding-filter';
import { IMPACT_BANDS } from '@sparkforensics/core/format-utils.ts';
import { interpretationOf } from '@/view/interpretation';
import { triageTargetFor, type TriageTarget } from '@/view/triage-target';
import { examples, exampleRuns, loadExampleRun } from './_shared/detector-examples';
import { isHidden } from './_shared/evidence-panel';

// The same swaps vite.export.config.ts makes (LIVE_ONLY_STUBS): the runs are the HTML export's.
vi.mock('@/store/useIngest', () => import('@/export/live-only-stubs/useIngest'));
vi.mock('@/view/useRecentFiles', () => import('@/export/live-only-stubs/useRecentFiles'));
vi.mock('@/view/EvidenceExport', () => import('@/export/live-only-stubs/EvidenceExport'));
vi.mock('@/view/core-usage-histogram-data', () => import('@/export/live-only-stubs/core-usage-histogram-data'));

// The verdict's route handler, tapped from outside: the same entry every route from the board takes.
const tap = vi.hoisted(() => ({ route: null as ((target: TriageTarget) => void) | null }));

vi.mock('@/view/widgets/RunVerdict', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/view/widgets/RunVerdict')>();
  return {
    ...actual,
    RunVerdict: (props: ComponentProps<typeof actual.RunVerdict>) => {
      tap.route = props.onRoute;
      return <actual.RunVerdict {...props} />;
    },
  };
});

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  tap.route = null;
  store.getState().resetModel();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  store.setState({ widgetDensity: 'basic' });
  window.history.replaceState({}, '', '/');
});

// A route must land on something a person can see and use: the focused element is visible and is
// in the card the layout resolved the route to. A route to a panel that was hidden, unmounted or
// never built fails here whatever mechanism hid it. No timers are faked: the route lands in the
// commit that mounts its row.
test.each(
  exampleRuns().flatMap((log) => (['basic', 'advanced'] as const).map((density) => [log, density] as const)),
)('%s (%s): a route to each example finding lands on a visible element of that finding', async (log, density) => {
  window.history.replaceState({}, '', '/?impact=critical,warning,info');
  expect(loadExampleRun(log)).toBeNull();
  store.setState({ widgetDensity: density });
  render(<ExportApp />);
  await screen.findByRole('tab', { name: 'Findings' });

  const state = store.getState();
  const appModel = selectAppModel(state);
  const catalog = selectCatalog(state);
  const configFindings = selectConfigFindings(state);
  const interpretation = state.run ? interpretationOf(state.run) : null;
  const layout = buildBoardLayout({ interpretation, appModel, catalog, configFindings, selection: { ...emptySelection(), impactBands: new Set(IMPACT_BANDS) }, density });
  const found = Object.values(examples).flatMap((example) => {
    if (!example || `${example.source}/${example.log}` !== log) return [];
    const finding = [...catalog, ...configFindings].find((candidate) => candidate.id === example.finding.id);
    return finding ? [finding] : [];
  });
  expect(found.length).toBeGreaterThan(0);

  const failures: string[] = [];
  let routed = 0;
  for (const finding of found) {
    const target = triageTargetFor(finding);
    if (!target) continue;
    routed += 1;
    const resolved = resolveRoute(target, layout);
    if (!resolved) {
      failures.push(`${finding.type} ${finding.id}: the layout has no place for the route`);
      continue;
    }
    // Start every route from nothing focused, so the focus below is the route's.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => tap.route!(target));
    try {
      await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    } catch {
      failures.push(`${finding.type} ${finding.id}: the route focused nothing`);
      continue;
    }
    const focused = document.activeElement as HTMLElement;
    const card = resolved.cardKey ? screen.getByTestId(`widget-grid-item-${resolved.cardKey}`) : null;
    if (isHidden(focused, document.body)) failures.push(`${finding.type} ${finding.id}: the focused element is hidden`);
    else if (card && !card.contains(focused)) failures.push(`${finding.type} ${finding.id}: the focused element is outside the finding's card`);
  }
  expect(routed).toBeGreaterThan(0);
  expect(failures).toEqual([]);
}, 30_000);
