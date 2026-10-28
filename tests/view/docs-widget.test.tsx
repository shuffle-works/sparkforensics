// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { findingActionLabel } from '@sparkforensics/core/finding-action-label.ts';
import { findingName } from '@sparkforensics/core/finding-names.ts';
import { DocsWidgetApp } from '@/docs-widget/DocsWidgetApp';
import { HEIGHT_MESSAGE, followHostTheme, hostTheme, reportHeight } from '@/docs-widget/host';
import { loadExportPayload } from '@/export/hydrate-store';
import { store } from '@/store/store';

// The same swaps vite.export.config.ts makes (LIVE_ONLY_STUBS): the example app is built from
// the export graph.
vi.mock('@/store/useIngest', () => import('@/export/live-only-stubs/useIngest'));
vi.mock('@/view/useRecentFiles', () => import('@/export/live-only-stubs/useRecentFiles'));
vi.mock('@/view/EvidenceExport', () => import('@/export/live-only-stubs/EvidenceExport'));
vi.mock('@/view/core-usage-histogram-data', () => import('@/export/live-only-stubs/core-usage-histogram-data'));

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  constructor(public callback: () => void) { ResizeObserverStub.instances.push(this); }
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const devDir = join(import.meta.dirname, '..', '..', 'dev');
const examples: Record<string, { source: string; log: string; finding: { id: string } }> = JSON.parse(
  readFileSync(join(devDir, 'detector-examples.json'), 'utf8'),
);
const runs: Record<string, string> = JSON.parse(readFileSync(join(devDir, 'detector-example-runs.json'), 'utf8'));

beforeEach(() => store.getState().resetModel());
afterEach(() => vi.restoreAllMocks());

// Every docs page frames this app for its type: the page must show the finding the example names.
test.each(Object.entries(examples))('%s: shows its example finding from the committed run', async (_type, example) => {
  expect(loadExportPayload(runs[`${example.source}/${example.log}`])).toBeNull();
  const { catalog, configFindings } = store.getState();
  const finding = [...catalog, ...configFindings].find((f) => f.id === example.finding.id)!;
  expect(finding).toBeDefined();

  const { container } = render(<DocsWidgetApp findingId={example.finding.id} />);

  // A step or a row is titled by its action label; a type the board shows only as a card, by its name.
  const titles = [findingActionLabel(finding), findingName(finding.type)].map((t) => t.toLowerCase());
  const shown = await screen.findAllByText((text) => titles.includes(text.trim().toLowerCase()), {}, { timeout: 10_000 });
  expect(shown.length).toBeGreaterThan(0);
  expect(screen.queryByRole('alert')).toBeNull();
  // The step labels tie a step to the rest of the dashboard, which the page does not show.
  expect(container.querySelector('[data-step-code]')).toBeNull();
  // A run-time saving is large enough to weigh.
  const wallClock = finding.impactEstimate?.wallClock;
  if (wallClock) expect(wallClock.high).toBeGreaterThanOrEqual(30_000);
});

test('says so when the run has no such finding', () => {
  loadExportPayload(runs[Object.keys(runs)[0]]);
  render(<DocsWidgetApp findingId="missing" />);
  expect(screen.getByRole('alert')).toHaveTextContent('no finding missing');
});

// Makes `root` the docs page's <html> element and returns the page, whose postMessage is a spy.
function frameInside(root: HTMLElement) {
  const parent = { document: { documentElement: root }, postMessage: vi.fn() };
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
  return parent;
}

test('has no host theme when nothing frames it', () => {
  expect(hostTheme()).toBeNull();
});

test('reads the docs page theme from its data-theme attribute', () => {
  const root = document.createElement('html');
  root.dataset.theme = 'dark';
  frameInside(root);
  expect(hostTheme()).toBe('dark');
  root.dataset.theme = 'sepia';
  expect(hostTheme()).toBeNull();
});

test('applies the docs page theme each time it changes', async () => {
  const root = document.createElement('html');
  frameInside(root);
  const apply = vi.fn();
  followHostTheme(apply);

  root.dataset.theme = 'light';
  await vi.waitFor(() => expect(apply).toHaveBeenCalledWith('light'));
});

test('posts the content height to the docs page now and on every resize', () => {
  const parent = frameInside(document.createElement('html'));
  const element = document.createElement('div');
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ height: 412.2 } as DOMRect);
  ResizeObserverStub.instances = [];

  reportHeight(element);
  expect(parent.postMessage).toHaveBeenLastCalledWith({ type: HEIGHT_MESSAGE, height: 413 }, window.location.origin);

  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ height: 600 } as DOMRect);
  ResizeObserverStub.instances[0].callback();
  expect(parent.postMessage).toHaveBeenLastCalledWith({ type: HEIGHT_MESSAGE, height: 600 }, window.location.origin);
});
