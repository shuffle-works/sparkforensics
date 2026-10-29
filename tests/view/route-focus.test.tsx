// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Finding } from '@sparkforensics/core/types.ts';

import { ExportApp } from '@/export/ExportApp';
import { store } from '@/store/store';
import { runFindingKeys } from '@/view/finding-anchor';
import { triageTargetFor, type TriageTarget } from '@/view/triage-target';
import type { WidgetRegistration } from '@/view/TriageNavigationContext';
import { examples, exampleRuns, loadExampleRun } from './_shared/detector-examples';
import { isHidden } from './_shared/evidence-panel';

// The same swaps vite.export.config.ts makes (LIVE_ONLY_STUBS): the runs are the HTML export's.
vi.mock('@/store/useIngest', () => import('@/export/live-only-stubs/useIngest'));
vi.mock('@/view/useRecentFiles', () => import('@/export/live-only-stubs/useRecentFiles'));
vi.mock('@/view/EvidenceExport', () => import('@/export/live-only-stubs/EvidenceExport'));
vi.mock('@/view/core-usage-histogram-data', () => import('@/export/live-only-stubs/core-usage-histogram-data'));

// What the dashboard's route machinery hands out, tapped from outside: the verdict's route handler,
// every widget registration and every row anchor. Production code is untouched.
const tap = vi.hoisted(() => ({
  route: null as ((target: TriageTarget) => void) | null,
  widgets: [] as { widgetId: string; registration: WidgetRegistration }[],
  anchors: new Map<string, HTMLElement>(),
}));

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

vi.mock('@/view/TriageNavigationContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/view/TriageNavigationContext')>();
  const { useCallback, useRef } = await import('react');
  return {
    ...actual,
    TriageNavigationProvider: (props: ComponentProps<typeof actual.TriageNavigationProvider>) => {
      const latest = useRef(props);
      latest.current = props;
      const registerWidget = useCallback<typeof props.registerWidget>((widgetId, registration) => {
        const entry = { widgetId, registration };
        tap.widgets.push(entry);
        const unregister = latest.current.registerWidget(widgetId, registration);
        return () => {
          tap.widgets.splice(tap.widgets.indexOf(entry), 1);
          unregister();
        };
      }, []);
      const registerFindingAnchor = useCallback<typeof props.registerFindingAnchor>((key, element) => {
        tap.anchors.set(key, element);
        const unregister = latest.current.registerFindingAnchor(key, element);
        return () => {
          if (tap.anchors.get(key) === element) tap.anchors.delete(key);
          unregister();
        };
      }, []);
      return <actual.TriageNavigationProvider {...props} registerWidget={registerWidget} registerFindingAnchor={registerFindingAnchor} />;
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

/** Where a route to `finding` lands: its row, else the card or panel registered for it (the panel
 * scoped to it before the widget's full card), as the dashboard resolves it. */
function landingOf(finding: Finding, widgetId: string): HTMLElement | undefined {
  const { catalog, configFindings } = store.getState();
  const anchor = tap.anchors.get(runFindingKeys([...catalog, ...(configFindings ?? [])])(finding));
  if (anchor) return anchor;
  const registrations = tap.widgets.filter((entry) => entry.widgetId === widgetId).map((entry) => entry.registration);
  return (registrations.find((candidate) => candidate.holds?.(finding)) ?? registrations.find((candidate) => !candidate.holds))?.wrapperElement;
}

// A route must land on something a person can see and use: the focused element is visible and is
// in the row, panel or card of the finding it was asked for. A route to a panel that was hidden,
// unmounted or never built fails here whatever mechanism hid it.
test.each(
  exampleRuns().flatMap((log) => (['basic', 'advanced'] as const).map((density) => [log, density] as const)),
)('%s (%s): a route to each example finding lands on a visible element of that finding', async (log, density) => {
  window.history.replaceState({}, '', '/?impact=critical,warning,info');
  expect(loadExampleRun(log)).toBeNull();
  store.setState({ widgetDensity: density });
  render(<ExportApp />);
  await screen.findByRole('tab', { name: 'Findings' });

  const { catalog, configFindings } = store.getState();
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
    const landing = landingOf(finding, target.widgetId);
    if (isHidden(focused, document.body)) failures.push(`${finding.type} ${finding.id}: the focused element is hidden`);
    else if (!landing?.contains(focused)) failures.push(`${finding.type} ${finding.id}: the focused element is outside the finding's row, panel and card`);
  }
  expect(routed).toBeGreaterThan(0);
  expect(failures).toEqual([]);
}, 120_000);
