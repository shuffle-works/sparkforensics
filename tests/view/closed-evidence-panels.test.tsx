// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import { ExportApp } from '@/export/ExportApp';
import { store } from '@/store/store';
import { REGISTRY, type WidgetProps } from '@/view/detector-registry';
import { useInlineEvidence } from '@/view/InlineEvidenceContext';
import { exampleRuns, loadExampleRun } from './_shared/detector-examples';

// The same swaps vite.export.config.ts makes (LIVE_ONLY_STUBS): the runs are the HTML export's.
vi.mock('@/store/useIngest', () => import('@/export/live-only-stubs/useIngest'));
vi.mock('@/view/useRecentFiles', () => import('@/export/live-only-stubs/useRecentFiles'));
vi.mock('@/view/EvidenceExport', () => import('@/export/live-only-stubs/EvidenceExport'));
vi.mock('@/view/core-usage-histogram-data', () => import('@/export/live-only-stubs/core-usage-histogram-data'));

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const originalComponents = Object.entries(REGISTRY).map(([type, entry]) => [type, entry.component] as const);
// The types whose widget rendered inside an evidence panel.
let panelRenders: string[] = [];

beforeEach(() => {
  panelRenders = [];
  store.getState().resetModel();
  // A counting double for every widget: it renders nothing, so only the decision to mount counts.
  for (const [type] of originalComponents) {
    REGISTRY[type].component = function CountingWidget(_props: WidgetProps) {
      if (useInlineEvidence()) panelRenders.push(type);
      return null;
    };
  }
});
afterEach(() => {
  cleanup();
  for (const [type, component] of originalComponents) REGISTRY[type].component = component;
  store.setState({ widgetDensity: 'basic' });
  window.history.replaceState({}, '', '/');
});

// Evidence is built only for a panel someone opened. A widget mounted under a Findings row or a
// verdict step with every panel closed means a probe or a flag decided from rendered output.
test.each(
  exampleRuns().flatMap((log) => (['basic', 'advanced'] as const).map((density) => [log, density] as const)),
)('%s (%s): with every evidence panel closed no widget renders under the rows', async (log, density) => {
  window.history.replaceState({}, '', '/?impact=critical,warning,info');
  expect(loadExampleRun(log)).toBeNull();
  store.setState({ widgetDensity: density });
  render(<ExportApp />);
  await screen.findByRole('tab', { name: 'Findings' });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // The run has verdict steps or board rows to look under, so an empty dashboard cannot pass.
  expect(document.querySelectorAll('[data-testid="run-verdict"] li, [data-testid="fix-these-first-row"]').length).toBeGreaterThan(0);
  expect(screen.queryAllByRole('button', { name: 'Hide evidence' })).toEqual([]);
  expect(panelRenders).toEqual([]);
}, 60_000);
