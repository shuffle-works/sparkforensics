// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { findingActionLabel, findingName } from '@sparkforensics/core/view-model';
import { DocsWidgetApp } from '@/docs-widget/DocsWidgetApp';
import { followHostTheme, hostTheme, reportHeight } from '@/docs-widget/host';
import { loadExportPayload } from '@/export/hydrate-store';
import { store } from '@/store/store';
import { eligibleFindings, findingAt } from '@/view/interpretation';
import { evidencePlacement } from '@/view/evidence-placement';
import { verdictEvidenceOwners } from '@/view/verdict-evidence';
import { computeActiveWidgets } from '@/view/widgets/Alerts';
import { keptRows, showsEvidence } from './_shared/evidence-panel';

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
  // The widget's content check decides what the page shows. A step or row states its finding, so it
  // offers the evidence control, opened, exactly when the check keeps a row beyond it; a finding shown
  // by its card alone needs the check to keep a row, or the page would show nothing. Either way the
  // panel has evidence under its title, and no control routes away from the page.
  const { appModel, interpretation, widgetDensity } = store.getState();
  const isLine = eligibleFindings(interpretation).includes(finding)
    || interpretation!.data.verdict.steps.some((step) => findingAt(interpretation!, step.leadIndex) === finding);
  // A type the dashboard mounts no card for (the always-mounted reference tile) has no panel here either.
  const hasWidget = computeActiveWidgets(catalog, configFindings, interpretation!.data.detectors, appModel, widgetDensity)
    .some((widget) => widget.type === finding.type);
  const kept = hasWidget ? keptRows(finding.type, [finding], isLine ? [example.finding.id] : [], { density: widgetDensity, appModel }) : [];
  expect(screen.queryByRole('button', { name: /show evidence/i })).toBeNull();
  const controls = screen.queryAllByRole('button', { name: /hide evidence/i });
  let panel: HTMLElement | null = container;
  if (isLine) {
    expect(controls).toHaveLength(kept.length > 0 ? 1 : 0);
    if (kept.length === 0) return;
    panel = container.querySelector<HTMLElement>(`[id="${controls[0].getAttribute('aria-controls')}"]`);
    expect(panel).not.toBeNull();
  } else {
    expect(kept.length).toBeGreaterThan(0);
    expect(controls).toHaveLength(0);
  }
  await within(panel!).findByRole('heading', { level: 3 }, { timeout: 10_000 });
  expect(showsEvidence(panel!)).toBe(true);
});

// The page shows an example only where the dashboard places its finding: a verdict step, a Findings
// row or a card. A placement of none would leave the page with an empty frame.
test.each(Object.entries(examples))('%s: the dashboard places its example finding', (_type, example) => {
  expect(loadExportPayload(runs[`${example.source}/${example.log}`])).toBeNull();
  const { appModel, catalog, configFindings, interpretation, widgetDensity } = store.getState();
  const finding = [...catalog, ...configFindings].find((f) => f.id === example.finding.id)!;
  const widgets = computeActiveWidgets(catalog, configFindings, interpretation!.data.detectors, appModel, widgetDensity);

  const placement = evidencePlacement(interpretation!, finding, new Set(widgets.map((widget) => widget.widgetId)));

  expect(placement.kind).not.toBe('none');
});

// The always-mounted Core Locality tile has no card on the Findings board, so a verdict step it
// leads has no panel: the dashboard routes to the tile, and the page, with nowhere to route, offers
// no control at all.
test('a step led by a finding with no board card offers no evidence control', async () => {
  const example = examples.coreLocality;
  expect(loadExportPayload(runs[`${example.source}/${example.log}`])).toBeNull();
  const { appModel, catalog, configFindings, interpretation, widgetDensity } = store.getState();
  const finding = [...catalog, ...configFindings].find((f) => f.id === example.finding.id)!;
  const available = new Set(
    computeActiveWidgets(catalog, configFindings, interpretation!.data.detectors, appModel, widgetDensity).map((widget) => widget.widgetId),
  );
  const placement = evidencePlacement(interpretation!, finding, available);
  expect(placement).toMatchObject({ kind: 'step', widgetId: null });
  if (placement.kind !== 'step') return;
  expect(verdictEvidenceOwners(interpretation!, available).has(placement.index)).toBe(false);

  render(<DocsWidgetApp findingId={example.finding.id} />);

  expect(await screen.findByTestId('next-step', {}, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /evidence/i })).toBeNull();
});

test('says so when the run has no such finding', () => {
  loadExportPayload(runs[Object.keys(runs)[0]]);
  render(<DocsWidgetApp findingId="missing" />);
  expect(screen.getByRole('alert')).toHaveTextContent('no finding missing');
});

const THEME = 'sparkforensics:docs-theme';
const HEIGHT_TYPE = 'sparkforensics:docs-widget-height';

// Makes the docs page the window's parent; its postMessage is a spy.
function frameInside() {
  const parent = { postMessage: vi.fn() } as unknown as Window;
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent);
  return parent;
}

function sendToFrame(data: unknown, init: { source: Window | null; origin?: string }) {
  window.dispatchEvent(new MessageEvent('message', { data, origin: init.origin ?? window.location.origin, source: init.source }));
}

test('has no host theme when the URL names none', () => {
  expect(hostTheme()).toBeNull();
});

test('reads the first theme from the theme query parameter', () => {
  window.history.replaceState(null, '', '/?type=skew&theme=dark');
  expect(hostTheme()).toBe('dark');
  window.history.replaceState(null, '', '/?theme=sepia');
  expect(hostTheme()).toBeNull();
  window.history.replaceState(null, '', '/');
});

test('applies the theme in each message from the docs page', () => {
  const parent = frameInside();
  const apply = vi.fn();
  followHostTheme(apply);

  sendToFrame({ type: THEME, theme: 'light' }, { source: parent });
  expect(apply).toHaveBeenCalledExactlyOnceWith('light');
  sendToFrame({ type: THEME, theme: 'dark' }, { source: parent });
  expect(apply).toHaveBeenLastCalledWith('dark');
});

test('ignores theme messages from another window or origin, and malformed ones', () => {
  const parent = frameInside();
  const apply = vi.fn();
  followHostTheme(apply);

  sendToFrame({ type: THEME, theme: 'dark' }, { source: window });
  sendToFrame({ type: THEME, theme: 'dark' }, { source: null });
  sendToFrame({ type: THEME, theme: 'dark' }, { source: parent, origin: 'https://example.invalid' });
  sendToFrame({ type: THEME, theme: 'sepia' }, { source: parent });
  sendToFrame({ type: 'sparkforensics:docs-escape' }, { source: parent });
  sendToFrame(null, { source: parent });

  expect(apply).not.toHaveBeenCalled();
});

test('posts the content height to the docs page now and on every resize', () => {
  const parent = frameInside();
  const element = document.createElement('div');
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ height: 412.2 } as DOMRect);
  ResizeObserverStub.instances = [];

  reportHeight(element);
  expect(parent.postMessage).toHaveBeenLastCalledWith({ type: HEIGHT_TYPE, height: 413 }, window.location.origin);

  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ height: 600 } as DOMRect);
  ResizeObserverStub.instances[0].callback();
  expect(parent.postMessage).toHaveBeenLastCalledWith({ type: HEIGHT_TYPE, height: 600 }, window.location.origin);
});
