// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { flushSync } from 'react-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StrictMode } from 'react';

import App from '@/App';
import { emptyAppModel, store } from '@/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { REGISTRY, type WidgetProps } from '@/view/detector-registry';
import { WidgetCard } from '@/view/WidgetCard';
import { useFindingAnchor, useIsRouteFlash } from '@/view/finding-anchor';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';

vi.mock('@sparkforensics/core/recent-files.ts', () => ({
  isSupported: () => false,
  list: vi.fn(() => new Promise(() => {})),
  add: vi.fn(async () => ({})),
  remove: vi.fn(async () => {}),
  getHandle: vi.fn(async () => null),
  ensurePermission: vi.fn(async () => true),
  entryId: (name: string, size: number, lastModified: number) => `${name}::${size}::${lastModified}`,
}));

const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalMatchMedia = window.matchMedia;
const originalSpillComponent = REGISTRY.spill.component;

function stage(id: number) {
  return {
    id,
    name: `stage-${id}`,
    stageType: 'shuffle',
    submittedAt: id * 1_000,
    completedAt: id * 1_000 + 500,
    taskCount: 10,
    failedTasks: 0,
    shuffleReadBytes: 0,
    memoryBytesSpilled: 128 * 1024 * 1024,
    diskBytesSpilled: 0,
    gcPct: 0,
    fetchWaitTime: 0,
    executorRunTime: 500,
    inputBytes: 0,
    outputBytes: 0,
    taskDurationP50: 50,
    taskDurationP95: 250,
    taskDurationMax: 400,
    spillClassification: 'unclassified',
  };
}

function readyAppModel(stageIds: number[] = []): AppModel {
  return {
    ...emptyAppModel(),
    app: { name: 'Test application', startTime: 0, endTime: 60_000 },
    stages: new Map(stageIds.map((id) => [id, stage(id)])) as unknown as AppModel['stages'],
  };
}

function spillFinding(stageId = 1, impactBand: Finding['impactBand'] = 'critical'): Finding {
  return {
    type: 'spill',
    stageId,
    impactBand,
    value: 128 * 1024 * 1024,
    recommendation: `Review spill in Stage ${stageId}.`,
  };
}

function skewFinding(stageId: number, impactBand: Finding['impactBand']): Finding {
  return {
    type: 'skew',
    stageId,
    impactBand,
    metric: 'p95Median',
    value: 5,
    recommendation: `Rebalance Stage ${stageId}.`,
  };
}

function shuffleFinding(stageId: number, impactBand: Finding['impactBand'] = 'critical', value = 100): Finding {
  return {
    type: 'shuffle',
    stageId,
    impactBand,
    value,
    recommendation: `Reduce shuffle in Stage ${stageId}.`,
  };
}

function gcFinding(
  stageId: number,
  opts: { direction?: 'low'; impactBand?: Finding['impactBand']; value?: number } = {},
): Finding {
  const { direction, impactBand = direction === 'low' ? 'info' : 'warning', value = 15 } = opts;
  return {
    type: 'gc',
    stageId,
    impactBand,
    direction,
    value,
    recommendation:
      direction === 'low'
        ? `Low GC in Stage ${stageId}: reduce executor memory.`
        : `Reduce GC in Stage ${stageId}.`,
  };
}

function taskFailuresFinding(stageId: number, impactBand: Finding['impactBand'] = 'warning', value = 25): Finding {
  return {
    type: 'failures',
    stageId,
    impactBand,
    value,
    failedTasks: 3,
    dominantReason: 'ExecutorLostFailure',
    recommendation: `Investigate task failures in Stage ${stageId}.`,
  };
}

function retryWasteFinding(stageId: number, impactBand: Finding['impactBand'] = 'warning', value = 5_000): Finding {
  return {
    type: 'retryWaste',
    stageId,
    impactBand,
    value,
    extended: `Superseded retry detail for Stage ${stageId}.`,
    recommendation: `Investigate retry waste in Stage ${stageId}.`,
  };
}

function slowHostFinding(stageId: number, impactBand: Finding['impactBand'] = 'warning', value = 3): Finding {
  return {
    type: 'slowHost',
    stageId,
    impactBand,
    value,
    recommendation: `Investigate slow host in Stage ${stageId}.`,
  };
}

// `stageId` defaults to `null` to match the real memoryUtilization detector
// (app-level). A few tests pass an explicit `stageId` to get a genuine
// StageTable route button, the only click-through into a reference-region finding.
function memoryFinding(stageId: number | null = null): Finding {
  return {
    type: 'memoryUtilization',
    stageId,
    impactBand: 'warning',
    variant: 'idleCores',
    value: 0.7,
    recommendation: 'Review executor allocation.',
  };
}

// The `memoryBand` variant emits one finding per flagged executor, the shape
// most likely to exceed VISIBLE_LIMIT; `stageId` defaults to `null` like
// `memoryFinding()` above.
function memoryBandFinding(executorId: number | string, impactBand: Finding['impactBand'], stageId: number | null = null): Finding {
  return {
    type: 'memoryUtilization',
    stageId,
    impactBand,
    variant: 'memoryBand',
    executorId,
    value: 0.9,
    recommendation: `Review heap sizing for executor ${executorId}.`,
  };
}

// `stageId` defaults to `null` to match the real plan detectors, which never
// set a singular `stageId` (only the plural `stageIds` DuplicatePlanSubtree.tsx groups by).
// A test below overrides it to get a precise per-finding StageTable route button.
function duplicatePlanSubtreeFinding(
  stageIds: number[],
  recommendation: string,
  opts: { impactBand?: Finding['impactBand']; stageId?: number | null } = {},
): Finding {
  const { impactBand = 'warning', stageId = null } = opts;
  return { type: 'duplicatePlanSubtree', impactBand, stageId, stageIds, recommendation };
}

function cachingFinding(relation: string, totalReadBytes: number, value = 2): Finding {
  return {
    type: 'cachingOpportunity',
    stageId: null,
    impactBand: 'info',
    metric: 'executionReuse',
    value,
    relation,
    format: 'parquet',
    executionIds: [1, 2],
    totalReadBytes,
    recommendation: `Cache ${relation} between executions.`,
  };
}

// cacheUtilization is app-wide RDD surfacing: `stageId` is always `null`, so
// routing tests below go through FixTheseFirst/SeverityBoard.
function cacheUtilizationFinding(rddId: number | string, impactBand: Finding['impactBand'] = 'warning'): Finding {
  return {
    // `id` is what CacheFindingRow keys its list on; a real detector always
    // sets a unique one via `findingId`.
    id: `cacheUtilization:${rddId}`,
    type: 'cacheUtilization',
    variant: 'partialCache',
    stageId: null,
    rddId,
    rddName: `rdd-${rddId}`,
    impactBand,
    metric: 'cachedRatio',
    value: 40,
    recommendation: `RDD rdd-${rddId} is partially cached, increase executor memory.`,
  } as Finding;
}

// Minimal cached-RDD row so CacheUtilization's "no cached RDDs" early return
// doesn't fire.
function rddRow(id: number) {
  return {
    id,
    name: `rdd${id}`,
    storageLevel: { useMemory: true, useDisk: false, deserialized: true, replication: 1 },
    numPartitions: 10,
    numCachedPartitions: 10,
    memorySize: 5e8,
    diskSize: 0,
  };
}

/** Test double for a widget wired via `useFindingAnchor`, one anchored row per
 * spill finding, substituted into `REGISTRY.spill.component`. Exercises
 * Dashboard's real `registerFindingAnchor`/`reportWidgetOpen` anchor lookup. */
function AnchoredSpillRow({ finding }: { finding: Finding }) {
  const anchorRef = useFindingAnchor([finding]);
  const isFlashed = useIsRouteFlash([finding]);
  return (
    <div
      ref={anchorRef}
      tabIndex={-1}
      data-testid={`spill-row-${finding.stageId}`}
      data-flashed={isFlashed ? 'true' : 'false'}
    >
      spill row {finding.stageId}
    </div>
  );
}

function SpillWithAnchoredRows({ catalog }: WidgetProps) {
  const findings = catalog.filter((finding) => finding.type === 'spill');
  return (
    <WidgetCard title="Spill">
      {findings.map((finding) => (
        <AnchoredSpillRow key={finding.stageId} finding={finding} />
      ))}
    </WidgetCard>
  );
}

function renderReady(catalog: Finding[], stageIds: number[] = []) {
  store.setState({
    status: 'ready',
    appModel: readyAppModel(stageIds),
    catalog,
    activeFileId: 'file-a',
    taskDataCache: new Map(),
    errorMessage: null,
    parse: { pct: 0, lines: 0, etaMs: null },
  });
  return render(<App />);
}

// CacheUtilization.tsx reads its cached-RDD table from `appModel.app.rddInfo`
// (bridged with a cast, same as the widget's own `AppWithRddInfo`; see
// CacheUtilization.tsx), a field `readyAppModel` doesn't set, and returns
// null (no widget at all) with zero cached rows: at least one is needed so
// the widget renders and its (separate) findings list becomes reachable.
function renderReadyWithRdd(catalog: Finding[], rddInfo: Map<number, unknown>, stageIds: number[] = []) {
  const model = readyAppModel(stageIds);
  store.setState({
    status: 'ready',
    appModel: { ...model, app: { ...model.app, rddInfo } as unknown as AppModel['app'] },
    catalog,
    activeFileId: 'file-a',
    taskDataCache: new Map(),
    errorMessage: null,
    parse: { pct: 0, lines: 0, etaMs: null },
  });
  return render(<App />);
}

// FixTheseFirst's impact-ranked rows are these tests' primary route initiator.
// Rows select by `data-finding-type`; findings sharing a type collapse into a
// `fix-these-first-group-row`, so this helper expands that group first before
// looking up the row by `index`. The clickable element is the
// recommendation-cell <button>, not the `<tr>`; a row with a scalar stageId
// also renders a StagePill button, so exclude it by its stage-detail aria-label.
function fixTheseFirstRow(findingType: string, index = 0): HTMLElement {
  let rows = screen.queryAllByTestId('fix-these-first-row').filter((row) => row.dataset.findingType === findingType);
  if (rows.length <= index) {
    const groupRow = screen
      .queryAllByTestId('fix-these-first-group-row')
      .find((row) => row.dataset.findingType === findingType);
    if (groupRow) {
      flushSync(() => { within(groupRow).getByRole('button').click(); });
      rows = screen.queryAllByTestId('fix-these-first-row').filter((row) => row.dataset.findingType === findingType);
    }
  }
  const row = rows[index];
  if (!row) throw new Error(`No "fix-these-first-row" for type "${findingType}" at index ${index} (found ${rows.length})`);
  const navigateButton = within(row)
    .getAllByRole('button')
    .find((button) => !(button.getAttribute('aria-label') ?? '').startsWith('Open details for Stage'));
  if (!navigateButton) throw new Error(`No navigate button in "fix-these-first-row" for type "${findingType}" at index ${index}`);
  return navigateButton;
}

async function waitForDashboard() {
  return screen.findByRole('tab', { name: 'Findings' });
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  window.matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.restoreAllMocks();
  REGISTRY.spill.component = originalSpillComponent;
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: originalScrollIntoView,
  });
  window.matchMedia = originalMatchMedia;
});

test('routes a Reference-region target from Stage Summary: expanding its exact card, scrolling, and focusing its disclosure', async () => {
  // All recommendations' callout only routes into action-region findings, so a
  // reference-region-only finding like memoryUtilization has no top-level
  // auto-route entry point; Stage Summary (inside Full app report) is the
  // remaining click-through source. Its destination, Memory Utilization, lives
  // in the Findings tab, so routing switches back there and Full app report
  // ends up unselected again.
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  const user = userEvent.setup();
  renderReady([memoryFinding(1)], [1]);

  await waitForDashboard();
  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  await user.click(screen.getByRole('button', { name: 'Investigate memory utilization in Stage 1' }));

  const trigger = await screen.findByRole('heading', { name: 'Memory Utilization' });
  expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Full app report' })).toHaveAttribute('aria-selected', 'false');
  expect(screen.getByRole('button', { name: /clean checks/i })).toHaveAttribute('aria-expanded', 'false');
  // MemoryUtilization.tsx anchors each row, so routing focuses the
  // row itself rather than the disclosure title; see the anchor-routing
  // tests below.
  const row = screen.getByText('Idle cores').closest('[data-flashed]');
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(trigger).not.toHaveAttribute('data-route-focused');
});

test('Strict Mode registration probing preserves a Reference route through committed open', async () => {
  // All recommendations' callout only routes into action-region findings
  //; Stage Summary (inside Full app report)
  // is the remaining click-through route source into a reference-region
  // finding, whose destination (Memory Utilization) lives in the Findings tab.
  const user = userEvent.setup();
  store.setState({
    status: 'ready',
    appModel: readyAppModel([1]),
    catalog: [memoryFinding(1)],
    activeFileId: 'file-a',
    taskDataCache: new Map(),
    errorMessage: null,
    parse: { pct: 0, lines: 0, etaMs: null },
  });
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  await waitForDashboard();
  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  await user.click(screen.getByRole('button', { name: 'Investigate memory utilization in Stage 1' }));

  // Waits for the routed widget's lazy chunk; the card itself is always expanded.
  await screen.findByRole('heading', { name: 'Memory Utilization' });
  expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true');
  // MemoryUtilization.tsx anchors each row, so routing focuses the
  // row itself rather than the disclosure title.
  const row = screen.getByText('Idle cores').closest('[data-flashed]');
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });
});

test('an alert target opens only its exact card and leaves Full app report and Clean checks closed', async () => {
  const user = userEvent.setup();
  renderReady([spillFinding(1)], [1]);

  await waitForDashboard();
  await user.click(fixTheseFirstRow('spill'));

  // Spill is code-split (React.lazy); its chunk resolves asynchronously.
  const trigger = await screen.findByRole('heading', { name: 'Spill' });
  // Spill.tsx anchors each row, so routing focuses the row itself
  // rather than the disclosure title; see the anchor-routing tests below.
  // Scoped to the widget card: FixTheseFirst's own row for this same
  // finding also renders a "Open details for Stage 1" StagePill.
  const spillCard = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
  const row = within(spillCard).getByRole('button', { name: 'Open details for Stage 1' }).closest('[data-flashed]');
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(screen.getByRole('tab', { name: 'Full app report' })).toHaveAttribute('aria-selected', 'false');
  expect(screen.getByRole('button', { name: /clean checks/i })).toHaveAttribute('aria-expanded', 'false');
});

test('initial render never scrolls or moves focus', async () => {
  renderReady([spillFinding(1)], [1]);

  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(document.body);
  // Spill is code-split (React.lazy); its chunk resolves asynchronously.
  expect(await screen.findByRole('heading', { name: 'Spill' })).not.toHaveAttribute('data-route-focused');
});

test('reduced motion routes with instant scrolling', async () => {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  // All recommendations' callout only routes into action-region findings
  //; Stage Summary (inside Reference) is the
  // remaining click-through route into a reference-region finding.
  const user = userEvent.setup();
  renderReady([memoryFinding(1)], [1]);

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  await user.click(screen.getByRole('button', { name: 'Investigate memory utilization in Stage 1' }));

  // MemoryUtilization.tsx anchors each row, so routing scrolls to
  // its center rather than the disclosure title's start.
  await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'auto',
    block: 'center',
    inline: 'nearest',
  }));
});

/** Bare `REGISTRY.spill.component` substitute with no anchor wiring, used
 * only by the blur-cleanup test below. The real `Spill.tsx` now
 * anchors stage 1's row, so routing to `spillFinding(1)` would take the
 * anchor path instead and never set `data-route-focused` on the disclosure
 * trigger; this double keeps the test proving the title-focus/blur-cleanup
 * mechanism it's actually about, independent of the real widget's anchors. */
function BareSpill() {
  return <WidgetCard title="Spill">spill details</WidgetCard>;
}

test('blur cleanup is ignored for unrelated widgets and clears only the route-focused widget', async () => {
  REGISTRY.spill.component = BareSpill;
  const user = userEvent.setup();
  const catalog = [spillFinding(1, 'critical'), skewFinding(2, 'warning')];
  renderReady(catalog, [1, 2]);

  await user.click(fixTheseFirstRow('spill'));
  // Spill.tsx is substituted with the (non-lazy) BareSpill double above, but
  // Task Skew is still the real, code-split (React.lazy) Skew; its
  // chunk resolves asynchronously.
  const spillTrigger = screen.getByRole('button', { name: 'Spill' });
  const skewTrigger = await screen.findByRole('button', { name: 'Task Skew' });
  await waitFor(() => expect(spillTrigger).toHaveAttribute('data-route-focused'));

  fireEvent.blur(skewTrigger);
  expect(spillTrigger).toHaveAttribute('data-route-focused');

  fireEvent.blur(spillTrigger);
  await waitFor(() => expect(spillTrigger).not.toHaveAttribute('data-route-focused'));
});

test('latest request wins before commit and stale routes never scroll or move focus', async () => {
  const spill = spillFinding(1, 'warning');
  const skew = skewFinding(2, 'critical');
  renderReady([spill, skew], [1, 2]);
  await userEvent.setup().click(screen.getByRole('tab', { name: 'Full app report' }));
  const spillRoute = screen.getByRole('button', { name: 'Investigate spill in Stage 1' });
  const skewRoute = screen.getByRole('button', { name: 'Investigate task skew in Stage 2' });

  act(() => {
    spillRoute.click();
    skewRoute.click();
  });

  // Skew.tsx anchors each row, so routing focuses the row itself
  // rather than the disclosure title; see the anchor-routing tests below.
  // Scoped to the widget card: FixTheseFirst's own row for this same
  // finding also renders a "Open details for Stage 2" StagePill.
  const skewTrigger = screen.getByRole('heading', { name: 'Task Skew' });
  const skewCard = skewTrigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
  const skewRow = within(skewCard).getByRole('button', { name: 'Open details for Stage 2' }).closest('[data-flashed]');
  await waitFor(() => expect(document.activeElement).toBe(skewRow));
  expect(screen.getByRole('heading', { name: 'Spill' })).not.toHaveAttribute('data-route-focused');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
});

test('catalog replacement cancels a pending route without scrolling or moving focus', () => {
  const finding = spillFinding(1);
  renderReady([finding], [1]);
  const initiator = fixTheseFirstRow('spill');
  initiator.focus();

  act(() => {
    initiator.click();
    store.setState({ catalog: [] });
  });

  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(document.body);
});

test('active-file replacement cancels a pending route without scrolling or moving focus', () => {
  const finding = spillFinding(1);
  renderReady([finding], [1]);
  const initiator = fixTheseFirstRow('spill');
  initiator.focus();

  act(() => {
    initiator.click();
    store.setState({ activeFileId: 'file-b' });
  });

  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(initiator);
});

test('unmounting a pending target cancels without scrolling or moving focus', () => {
  const finding = spillFinding(1);
  const view = renderReady([finding], [1]);
  const initiator = fixTheseFirstRow('spill');
  initiator.focus();

  act(() => {
    initiator.click();
    view.unmount();
  });

  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});

test('Stage Summary routes a duplicate-tuple second occurrence with Enter and Space without opening Stage Detail', async () => {
  const first = skewFinding(1, 'warning');
  const second = { ...skewFinding(1, 'critical') };
  const user = userEvent.setup();
  renderReady([first, second], [1]);
  // Stage Summary (StageTable) lives inside the Full app report tab: select
  // it to reach the route button. Routing switches back to the Findings tab
  // (every routeable target lives there), which unmounts Full app report and
  // remounts Findings, so the Task Skew trigger/row must be looked
  // up fresh after each route rather than captured once up front.
  // Skew.tsx anchors each row, so routing focuses the row itself
  // rather than the disclosure title. Scoped to the widget card:
  // FixTheseFirst's own row for this same finding also renders a
  // "Open details for Stage 1" StagePill.
  const skewRow = () => {
    const skewTrigger = screen.getByRole('heading', { name: 'Task Skew' });
    const skewCard = skewTrigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
    return within(skewCard).getByRole('button', { name: 'Open details for Stage 1' }).closest('[data-flashed]');
  };

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  act(() => screen.getByRole('button', { name: 'Investigate task skew in Stage 1' }).focus());
  await user.keyboard('{Enter}');
  await screen.findByRole('heading', { name: 'Task Skew' });
  await waitFor(() => expect(document.activeElement).toBe(skewRow()));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  act(() => screen.getByRole('button', { name: 'Investigate task skew in Stage 1' }).focus());
  await user.keyboard(' ');
  await screen.findByRole('heading', { name: 'Task Skew' });
  await waitFor(() => expect(document.activeElement).toBe(skewRow()));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('routing preserves the target widget complete established stage order', async () => {
  const user = userEvent.setup();
  // selectTriageTarget ranks by potential savings, not impact band (see
  // src/view/triage-target.ts): give Stage 2's finding a real estimate so
  // it's unambiguously the routed target, independent of impact band or catalog
  // order, which is what this test is actually about.
  const targeted: Finding = {
    ...skewFinding(2, 'critical'),
    impactEstimate: { basis: 'serial', wallClock: { low: 60_000, high: 60_000 }, estimateMethod: 'measured' },
  };
  renderReady([skewFinding(9, 'warning'), targeted], [9, 2]);

  await user.click(fixTheseFirstRow('skew'));

  const trigger = await screen.findByRole('heading', { name: 'Task Skew' });
  const card = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]');
  if (!card) throw new Error('Task Skew should remain inside its registered grid item');
  expect(within(card).getAllByRole('button', { name: /open details for stage/i }).map((button) => button.getAttribute('aria-label')))
    .toEqual(['Open details for Stage 2', 'Open details for Stage 9']);
});

// --- Anchor-based routing (Dashboard.tsx's reportWidgetOpen anchor lookup) ---
//
// These substitute `SpillWithAnchoredRows` (a test double built on the real
// `useFindingAnchor`/`useIsRouteFlash` hooks) into `REGISTRY.spill.component`,
// exercising Dashboard's real `registerFindingAnchor` plumbing and
// `reportWidgetOpen`'s anchor-lookup branch end-to-end.

test('an anchored row is scrolled to center and focused instead of the disclosure title, and is flagged as flashed', async () => {
  REGISTRY.spill.component = SpillWithAnchoredRows;
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  const user = userEvent.setup();
  renderReady([spillFinding(1)], [1]);

  await user.click(fixTheseFirstRow('spill'));

  const row = await screen.findByTestId('spill-row-1');
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });
  expect(row).toHaveAttribute('data-flashed', 'true');
  // The anchor path replaces the title-focus path entirely: the disclosure
  // trigger must not also claim route focus.
  expect(screen.getByRole('heading', { name: 'Spill' })).not.toHaveAttribute('data-route-focused');
});

// `Spill.tsx`/`Skew.tsx` wire their rows via `useFindingAnchor`, so the real
// widgets take the anchor path like the `SpillWithAnchoredRows` double above.
// The no-anchor fallback path stays covered by the Reference/`memoryFinding`
// and `BareSpill` tests.
test.each<{
  title: string;
  key: string;
  heading: string;
  makeFinding: () => Finding;
}>([
  {
    title:
      'a real Spill.tsx row (Task 4) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'spill',
    heading: 'Spill',
    makeFinding: () => spillFinding(1),
  },
  {
    title:
      'a real Skew.tsx row (Task 5) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'skew',
    heading: 'Task Skew',
    makeFinding: () => skewFinding(1, 'critical'),
  },
])('$title', ({ key, heading, makeFinding }) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    renderReady([makeFinding()], [1]);

    act(() => {
      fixTheseFirstRow(key).click();
    });

    const trigger = screen.getByRole('heading', { name: heading });
    // Scoped to the widget card: FixTheseFirst's own row for this same
    // finding also renders a "Open details for Stage 1" StagePill.
    const card = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
    const row = within(card).getByRole('button', { name: 'Open details for Stage 1' }).closest('[data-flashed]') as HTMLElement;
    expect(document.activeElement).toBe(row);
    expect(row).toHaveAttribute('data-flashed', 'true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    // The anchor path replaces the title-focus path entirely.
    expect(trigger).not.toHaveAttribute('data-route-focused');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(row).toHaveAttribute('data-flashed', 'false');
  } finally {
    vi.useRealTimers();
  }
});

test('the flash clears automatically after 2000ms', () => {
  REGISTRY.spill.component = SpillWithAnchoredRows;
  // Fake only setTimeout/clearTimeout (not Date/rAF) so React's own scheduling
  // and any library animation timing are unaffected; timers must be faked
  // *before* the click so the flash's own 2000ms timeout is scheduled on the
  // fake clock from the start (a real timer scheduled first would keep
  // running on the real clock, unaffected by later `vi.advanceTimersByTime`).
  // Raw DOM `.click()` (not `userEvent`) avoids userEvent's own internal
  // timers racing the faked clock.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    renderReady([spillFinding(1)], [1]);

    act(() => {
      fixTheseFirstRow('spill').click();
    });
    const row = screen.getByTestId('spill-row-1');
    expect(row).toHaveAttribute('data-flashed', 'true');

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(row).toHaveAttribute('data-flashed', 'true');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(row).toHaveAttribute('data-flashed', 'false');
  } finally {
    vi.useRealTimers();
  }
});

test('a second anchored route supersedes an active flash, canceling the first timeout', async () => {
  REGISTRY.spill.component = SpillWithAnchoredRows;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    renderReady([spillFinding(1), spillFinding(2)], [1, 2]);

    act(() => {
      fixTheseFirstRow('spill').click();
    });
    const row1 = screen.getByTestId('spill-row-1');
    expect(row1).toHaveAttribute('data-flashed', 'true');

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    // Stage Summary (StageTable) lives inside the Full app report tab: select
    // it to reach the second route button. Routing back to Findings unmounts and
    // remounts SpillWithAnchoredRows; settling that remount plus the anchor-lookup/
    // flash-state chain needs an extra microtask tick, hence `await act(async ...)`.
    await act(async () => {
      screen.getByRole('tab', { name: 'Full app report' }).click();
      await Promise.resolve();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Investigate spill in Stage 2' }).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('spill-row-1')).toHaveAttribute('data-flashed', 'false');
    const row2 = screen.getByTestId('spill-row-2');
    expect(row2).toHaveAttribute('data-flashed', 'true');
    expect(clearTimeoutSpy).toHaveBeenCalled();

    // The superseding flash still clears on its own 2000ms schedule; a
    // canceled first timeout must not leave the second one dangling.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('spill-row-2')).toHaveAttribute('data-flashed', 'false');
  } finally {
    vi.useRealTimers();
  }
});

test('activeRouteTarget reflects the pending route while unresolved, and clears once the pending route is canceled', () => {
  // A widget that mounts no `WidgetCard` at all: `reportWidgetOpen` is never
  // called, so the route never resolves/clears on its own, making the pending
  // window observable deterministically instead of racing real effect flushing.
  function UnresponsiveSpill() {
    const target = useActiveRouteTarget();
    return <span data-testid="active-target">{target?.widgetId ?? 'none'}</span>;
  }
  REGISTRY.spill.component = UnresponsiveSpill;
  renderReady([spillFinding(1)], [1]);
  const initiator = fixTheseFirstRow('spill');

  expect(screen.getByTestId('active-target')).toHaveTextContent('none');

  act(() => initiator.click());
  expect(screen.getByTestId('active-target')).toHaveTextContent('spill');

  // Active-file replacement cancels the pending route (existing cancellation
  // path, see "active-file replacement cancels a pending route..." above);
  // activeRouteTarget must clear along with it. (Clearing the catalog instead
  // would also drop the spill finding's impact band, unmounting this widget via
  // Alerts's active/clean split, a confound unrelated to what's under test.)
  act(() => {
    store.setState({ activeFileId: 'file-b' });
  });
  expect(screen.getByTestId('active-target')).toHaveTextContent('none');
});

// ShuffleIO renders every flagged stage's `StagePill` a second time in its
// always-mounted `StagePillGroup` "jump" strip (`pills`, built from the full
// unpaginated `sorted` list), unlike Spill.tsx/Skew.tsx. So "Open details
// for Stage N" matches twice for ShuffleIO even post-route: the always-present
// pill-strip button, and the real anchored `ShuffleRow` (only mounted once its
// page is visible). This helper picks the one that's actually inside a row.
function findShuffleRow(stageId: number): HTMLElement | null {
  const buttons = screen.queryAllByRole('button', { name: `Open details for Stage ${stageId}` });
  for (const button of buttons) {
    const row = button.closest('[data-flashed]');
    if (row) return row as HTMLElement;
  }
  return null;
}

test('a real ShuffleIO.tsx row (Task 6) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms', async () => {
  // `ShuffleIO.tsx`'s `ShuffleRow` wires `useFindingAnchor`/`useIsRouteFlash`
  // on `[entry.shuffle, ...entry.partitions]` (filtered for null), so routing
  // to a shuffle finding takes the anchor path on the real widget.
  renderReady([shuffleFinding(1)], [1]);
  // ShuffleIO is code-split (React.lazy): let its chunk resolve with real
  // timers before faking setTimeout for the flash-clear assertion further down.
  await screen.findByRole('heading', { name: 'Shuffle I/O' });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => {
      fixTheseFirstRow('shuffle').click();
    });

    const trigger = screen.getByRole('heading', { name: 'Shuffle I/O' });
    const row = findShuffleRow(1) as HTMLElement;
    expect(document.activeElement).toBe(row);
    expect(row).toHaveAttribute('data-flashed', 'true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    // The anchor path replaces the title-focus path entirely.
    expect(trigger).not.toHaveAttribute('data-route-focused');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(row).toHaveAttribute('data-flashed', 'false');
  } finally {
    vi.useRealTimers();
  }
});

test("GcPressure.tsx (Task 7) jumps only the routed bucket's own page, leaving the other bucket's page untouched", async () => {
  // GcPressure has two independent paginated buckets (`highFindings`
  // ("GC overhead") and `lowFindings` ("Low GC (cost)")), each rendered by its
  // own `GcSection` with its own `page` state. Build 8 flagged stages per
  // bucket (VISIBLE_LIMIT is 6) so both sections paginate, then route to a
  // high-bucket finding and assert only the high section's page moves: the
  // low section's `sorted.findIndex` misses (-1) for a finding it doesn't
  // contain, so its page must stay put (the "-1 fallthrough" correctness property).
  const highStageIds = Array.from({ length: 8 }, (_, i) => i + 1);
  const lowStageIds = Array.from({ length: 8 }, (_, i) => i + 9);
  // Same impact band within each bucket so `value` (descending) alone decides
  // sort order: Stage 1 has the highest high-bucket value (sorts first, index
  // 0), Stage 8 the lowest (sorts last, index 7): floor(7 / 6) = page 1 (the
  // second page, "Page 2 of 2").
  const highFindings = highStageIds.map((stageId) => gcFinding(stageId, { value: (9 - stageId) * 10 }));
  const lowFindings = lowStageIds.map((stageId) =>
    gcFinding(stageId, { direction: 'low', value: (17 - stageId) * 10 }),
  );
  renderReady([...highFindings, ...lowFindings], [...highStageIds, ...lowStageIds]);
  // GcPressure is code-split (React.lazy): let its chunk resolve first.
  await screen.findByRole('heading', { name: 'GC Pressure' });

  const overheadSection = screen.getByText('GC overhead', { exact: false }).closest('section') as HTMLElement;
  const lowSection = screen.getByText('Low GC (cost)', { exact: false }).closest('section') as HTMLElement;

  // Before routing: Stage 8's row isn't in the DOM yet (page 0 only shows
  // Stages 1-6 of the high bucket), and both sections show page 1 of 2.
  expect(within(overheadSection).queryByRole('button', { name: 'Open details for Stage 8' })).toBeNull();
  expect(within(overheadSection).getByText('Page 1 of 2')).toBeInTheDocument();
  expect(within(lowSection).getByText('Page 1 of 2')).toBeInTheDocument();

  // Stage Summary (StageTable) lives inside the Full app report tab: switch
  // to it to reach the route button. Routing back switches to Findings
  // (every routeable target lives there), which unmounts and remounts
  // GcPressure, so `overheadSection`/`lowSection` must be re-queried after
  // routing instead of reused from before the tab switch.
  act(() => {
    screen.getByRole('tab', { name: 'Full app report' }).click();
  });
  act(() => {
    screen.getByRole('button', { name: 'Investigate GC pressure in Stage 8' }).click();
  });

  const overheadSectionAfter = screen.getByText('GC overhead', { exact: false }).closest('section') as HTMLElement;
  const lowSectionAfter = screen.getByText('Low GC (cost)', { exact: false }).closest('section') as HTMLElement;

  // Only the high-GC section's page jumped to reveal Stage 8; the low-GC
  // section's page is untouched.
  expect(within(overheadSectionAfter).getByText('Page 2 of 2')).toBeInTheDocument();
  expect(within(lowSectionAfter).getByText('Page 1 of 2')).toBeInTheDocument();

  const row = within(overheadSectionAfter)
    .getByRole('button', { name: 'Open details for Stage 8' })
    .closest('[data-flashed]') as HTMLElement;
  expect(row).not.toBeNull();
  expect(document.activeElement).toBe(row);
  expect(row).toHaveAttribute('data-flashed', 'true');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });
});

// `GcPressure.tsx`/`TaskFailures.tsx`/`RetryWaste.tsx`/`SlowHost.tsx` each wire
// `useFindingAnchor`/`useIsRouteFlash` on `[finding]`, so routing to one of
// their findings takes the anchor path on the real widget. Each is
// code-split (React.lazy): let its chunk resolve with real timers before
// faking setTimeout for the flash-clear assertion further down.
test.each<{
  title: string;
  key: string;
  heading: string;
  makeFinding: () => Finding;
}>([
  {
    title:
      'a real GcPressure.tsx row (Task 7) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'gc',
    heading: 'GC Pressure',
    makeFinding: () => gcFinding(1),
  },
  {
    title:
      'a real TaskFailures.tsx row (Task 8) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'failures',
    heading: 'Failed Tasks',
    makeFinding: () => taskFailuresFinding(1),
  },
  {
    title:
      'a real RetryWaste.tsx row (Task 8) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'retryWaste',
    heading: 'Retry Waste',
    makeFinding: () => retryWasteFinding(1),
  },
  {
    title:
      'a real SlowHost.tsx row is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'slowHost',
    heading: 'Slow Executor Host',
    makeFinding: () => slowHostFinding(1),
  },
])('$title', async ({ key, heading, makeFinding }) => {
  renderReady([makeFinding()], [1]);
  await screen.findByRole('heading', { name: heading });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => {
      fixTheseFirstRow(key).click();
    });

    const trigger = screen.getByRole('heading', { name: heading });
    // Scoped to the widget card: FixTheseFirst's own row for this same
    // finding also renders a "Open details for Stage 1" StagePill.
    const card = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
    const row = within(card).getByRole('button', { name: 'Open details for Stage 1' }).closest('[data-flashed]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row);
    expect(row).toHaveAttribute('data-flashed', 'true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    // The anchor path replaces the title-focus path entirely.
    expect(trigger).not.toHaveAttribute('data-route-focused');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(row).toHaveAttribute('data-flashed', 'false');
  } finally {
    vi.useRealTimers();
  }
});

test('a real MemoryUtilization.tsx row (Task 10) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms', async () => {
  // `MemoryUtilization.tsx`'s `MemoryRow` wires `useFindingAnchor`/`useIsRouteFlash`
  // on `[finding]`, so routing to a `memoryUtilization` finding takes the anchor
  // path on the real widget. It never renders a `StagePill`, so the stable
  // locator is its row label text ("Idle cores"); a `stageId` is still given to
  // get a genuine Stage Summary route button, the only click-through into this
  // reference-region finding.
  renderReady([memoryFinding(1)], [1]);
  // Memory Utilization mounts because of its own active finding here, reached
  // directly from the Findings tab (the default-active one), not from behind
  // Full app report. It's code-split (React.lazy): let its chunk resolve with
  // real timers before faking setTimeout for the flash-clear assertion further down.
  await screen.findByRole('heading', { name: 'Memory Utilization' });

  // Stage Summary (StageTable) lives inside the Full app report tab: switch
  // to it to reach the route button. Routing back switches to Findings
  // (every routeable target lives there), which unmounts and remounts
  // Memory Utilization; `trigger`/`row` below are queried after that route
  // click, so they aren't stale.
  act(() => {
    screen.getByRole('tab', { name: 'Full app report' }).click();
  });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => {
      screen.getByRole('button', { name: 'Investigate memory utilization in Stage 1' }).click();
    });

    const trigger = screen.getByRole('heading', { name: 'Memory Utilization' });
    const row = screen.getByText('Idle cores').closest('[data-flashed]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row);
    expect(row).toHaveAttribute('data-flashed', 'true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    // The anchor path replaces the title-focus path entirely.
    expect(trigger).not.toHaveAttribute('data-route-focused');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(row).toHaveAttribute('data-flashed', 'false');
  } finally {
    vi.useRealTimers();
  }
});

test('a real CachingOpportunity.tsx row (Task 11) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms', async () => {
  // `CachingOpportunity.tsx`'s `CachingRow` wires `useFindingAnchor`/`useIsRouteFlash`
  // on `[finding]`, so routing to a `cachingOpportunity` finding takes the
  // anchor path on the real widget. `cachingFinding()` has `stageId: null`, so
  // the stable locator is the relation name text, not an "Open details" button.
  renderReady([cachingFinding('orders', 1024)]);
  // CachingOpportunity is code-split (React.lazy): let its chunk resolve
  // with real timers before faking setTimeout for the flash-clear assertion
  // further down.
  await screen.findByRole('heading', { name: 'Caching Opportunities' });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => {
      fixTheseFirstRow('cachingOpportunity').click();
    });

    const trigger = screen.getByRole('heading', { name: 'Caching Opportunities' });
    const row = screen.getByText('orders').closest('[data-flashed]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row);
    expect(row).toHaveAttribute('data-flashed', 'true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    // The anchor path replaces the title-focus path entirely.
    expect(trigger).not.toHaveAttribute('data-route-focused');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(row).toHaveAttribute('data-flashed', 'false');
  } finally {
    vi.useRealTimers();
  }
});

test('CachingOpportunity.tsx (widget-ui-unification Task 11) jumps its own pagination to the page containing a route target beyond the first page', async () => {
  // usePagedRows's page size is VISIBLE_LIMIT (6, src/format-utils.js). The
  // `cachingOpportunity` detector always emits `impactBand: 'info'`
  // (src/detectors.js), so with an all-cachingOpportunity catalog,
  // `selectTriageTarget`'s impact-band/widget-order tie-breaks are all equal and
  // it falls through to catalog index: `target` (catalog[0]) is what "Start
  // with..." routes to. Giving `target` the smallest `totalReadBytes` makes
  // the widget's own descending-bytes sort push it to the *last* rendered
  // position (index 6 of 7, i.e. page 2), so this only passes if the page
  // jump actually fires, not merely if the target happens to already be
  // visible on page 1.
  const target = cachingFinding('rel-target', 1);
  const others = Array.from({ length: 6 }, (_, i) => cachingFinding(`rel-${i}`, (i + 1) * 1_000));
  renderReady([target, ...others]);
  await screen.findByRole('heading', { name: 'Caching Opportunities' });

  act(() => {
    fixTheseFirstRow('cachingOpportunity').click();
  });

  const row = screen.getByText('rel-target').closest('[data-flashed]') as HTMLElement;
  expect(row).not.toBeNull();
  expect(document.activeElement).toBe(row);
  expect(row).toHaveAttribute('data-flashed', 'true');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });

  const card = screen
    .getByRole('heading', { name: 'Caching Opportunities' })
    .closest<HTMLElement>('[data-testid^="widget-grid-item-"]') as HTMLElement;
  // Page jumped to page 2 of 2 to reveal the target: pagination shows a fixed
  // window (only that page's one row).
  expect(within(card).getByText('Page 2 of 2')).toBeInTheDocument();
  expect(within(card).getAllByRole('row')).toHaveLength(1 + 1);
});

test('MemoryUtilization.tsx (final whole-branch review fix) jumps its own pagination to the page containing a route target beyond the first page', async () => {
  // Regression: a missing `routeIndex` wire is most reachable in
  // MemoryUtilization, since its `memoryBand` variant emits one finding per
  // flagged executor and routinely exceeds VISIBLE_LIMIT (6).
  //
  // Its list sorts purely by impact band, so giving `target` the least severe
  // band among 7 findings pushes it to the last position (page 2). `target`
  // also gets a real `stageId` so exactly one Stage Summary route button exists,
  // routing to it by object identity (the other 6 stay `stageId: null`).
  const target = memoryBandFinding('target', 'warning', 1);
  const others = Array.from({ length: 6 }, (_, i) => memoryBandFinding(i, 'critical'));
  renderReady([target, ...others], [1]);
  await screen.findByRole('heading', { name: 'Memory Utilization' });

  // Stage Summary (StageTable) lives inside the Full app report tab: switch
  // to it to reach the route button.
  act(() => {
    screen.getByRole('tab', { name: 'Full app report' }).click();
  });

  act(() => {
    screen.getByRole('button', { name: 'Investigate memory utilization in Stage 1' }).click();
  });

  const row = screen.getByText('Executor target').closest('[data-flashed]') as HTMLElement;
  expect(row).not.toBeNull();
  expect(document.activeElement).toBe(row);
  expect(row).toHaveAttribute('data-flashed', 'true');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });

  const card = screen
    .getByRole('heading', { name: 'Memory Utilization' })
    .closest<HTMLElement>('[data-testid^="widget-grid-item-"]') as HTMLElement;
  // Page jumped to page 2 of 2 to reveal the target: without the Finding 1
  // fix, `usePagedRows` never receives a `routeIndex`, so this stays stuck on
  // "Page 1 of 2" and the row is never revealed at all.
  expect(within(card).getByText('Page 2 of 2')).toBeInTheDocument();
});

test('a real DuplicatePlanSubtree.tsx row is anchor-routable: the flash/focus lands on the second finding, not the first row or the widget title, and clears after 2000ms', async () => {
  // `DuplicatePlanSubtree.tsx`'s `DuplicatePlanSubtreeRow` wires
  // `useFindingAnchor`/`useIsRouteFlash` on `[finding]`. This builds two
  // `duplicatePlanSubtree` findings and asserts the anchor lands on the
  // SECOND row, not the first row or the widget's own title.
  //
  // Plan findings never carry a singular `stageId`, so there is no per-finding
  // StageTable route button by default and the auto-route always targets the
  // finding worst by impact band (the one sorted to the front). So the
  // *target* is given a real `stageId` to get a genuine StageTable route button,
  // letting this test prove routing hits a specific object by reference,
  // independent of the widget's sort order. DuplicatePlanSubtree never reads
  // `finding.stageId`, so the extra field doesn't affect rendering.
  const first = duplicatePlanSubtreeFinding([3], 'Consolidate subtree A.', { impactBand: 'critical' });
  const target = duplicatePlanSubtreeFinding([7], 'Consolidate subtree B.', { impactBand: 'warning', stageId: 7 });
  renderReady([first, target], [7]);
  // DuplicatePlanSubtree is code-split (React.lazy): let its chunk resolve with real
  // timers before faking setTimeout for the flash-clear assertion further down.
  await screen.findByRole('heading', { name: 'Redundant Plan Subtree' });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    // Stage Summary (StageTable) now lives inside the collapsed Reference
    // accordion: expand it to reach the route
    // button. This also mounts every reference-region widget for the first
    // time, including `CoreUsageHistogram`'s own unrelated `getTaskData`
    // fetch effect; flush that pending, unrelated async update inside `act`
    // so it doesn't leak into a later test as a bare act() warning; it has
    // no bearing on this test's anchor/flash assertions.
    await act(async () => {
      screen.getByRole('tab', { name: 'Full app report' }).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      screen.getByRole('button', { name: 'Investigate duplicate plan subtree in Stage 7' }).click();
    });

    const trigger = screen.getByRole('heading', { name: 'Redundant Plan Subtree' });

    const card = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-"]') as HTMLElement;
    const rows = within(card).getAllByRole('listitem');
    // `first` (critical) sorts ahead of `target` (warning), so `target` is
    // genuinely the list's *second* rendered row.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Consolidate subtree A.');
    expect(rows[1]).toHaveTextContent('Consolidate subtree B.');

    const row = rows[1];
    expect(document.activeElement).toBe(row);
    expect(row).toHaveAttribute('data-flashed', 'true');
    expect(rows[0]).toHaveAttribute('data-flashed', 'false');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    // The anchor path replaces the title-focus path entirely.
    expect(trigger).not.toHaveAttribute('data-route-focused');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(row).toHaveAttribute('data-flashed', 'false');
  } finally {
    vi.useRealTimers();
  }
});

// --- Page-jump regression guards for the six widgets whose other routing
// coverage renders 1-2 findings that never leave page 1 (Spill.tsx,
// Skew.tsx, SlowHost.tsx, DuplicatePlanSubtree.tsx, TaskFailures.tsx,
// RetryWaste.tsx), plus basic coverage for ConfigAudit.tsx/CacheUtilization.tsx's own findings list.

// Each widget's own sort comparator (or, absent a tiebreak, plain
// `Array.prototype.sort` stability) pushes Stage 8 to the list's last
// rendered position (index 7 of 8: floor(7 / 6) = page 1, "Page 2 of 2") when
// every finding shares the same impact band, so this only passes if the
// route's page jump actually fires, not merely if the target happens to
// already be visible on page 1. `findShuffleRow` (defined above) isn't
// Shuffle-specific: it just finds a "Open details for Stage N" button inside
// a `[data-flashed]` row, a convention every widget below follows.
test.each<{
  title: string;
  heading: string;
  routeLabel: string;
  makeFinding: (stageId: number) => Finding;
}>([
  {
    title:
      'ShuffleIO.tsx (Task 6) jumps its own page to reveal a route target that is not on the currently-visible page',
    heading: 'Shuffle I/O',
    routeLabel: 'Investigate shuffle I/O in Stage 8',
    makeFinding: (stageId) => shuffleFinding(stageId, 'critical', (9 - stageId) * 100),
  },
  {
    title:
      'TaskFailures.tsx jumps its own pagination to reveal a route target that is not on the currently-visible page',
    heading: 'Failed Tasks',
    routeLabel: 'Investigate failed tasks in Stage 8',
    makeFinding: (stageId) => taskFailuresFinding(stageId, 'critical'),
  },
  {
    title:
      'RetryWaste.tsx jumps its own pagination to reveal a route target that is not on the currently-visible page',
    heading: 'Retry Waste',
    routeLabel: 'Investigate retry waste in Stage 8',
    makeFinding: (stageId) => retryWasteFinding(stageId, 'critical'),
  },
  {
    title: 'Spill.tsx jumps its own pagination to reveal a route target that is not on the currently-visible page',
    heading: 'Spill',
    routeLabel: 'Investigate spill in Stage 8',
    makeFinding: (stageId) => ({ ...spillFinding(stageId, 'critical'), value: (9 - stageId) * 1024 ** 3 }),
  },
  {
    title: 'Skew.tsx jumps its own pagination to reveal a route target that is not on the currently-visible page',
    heading: 'Task Skew',
    routeLabel: 'Investigate task skew in Stage 8',
    makeFinding: (stageId) => skewFinding(stageId, 'critical'),
  },
  {
    title:
      'SlowHost.tsx jumps its own pagination to reveal a route target that is not on the currently-visible page',
    heading: 'Slow Executor Host',
    routeLabel: 'Investigate slow executor host in Stage 8',
    makeFinding: (stageId) => slowHostFinding(stageId, 'critical'),
  },
])('$title', async ({ heading, routeLabel, makeFinding }) => {
  const stageIds = Array.from({ length: 8 }, (_, i) => i + 1);
  const findings = stageIds.map((stageId) => makeFinding(stageId));
  renderReady(findings, stageIds);
  await screen.findByRole('heading', { name: heading });

  // Before routing: Stage 8's row isn't in the DOM yet (page 0 only shows
  // Stages 1-6), and the widget shows page 1 of 2.
  expect(findShuffleRow(8)).toBeNull();
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

  act(() => {
    screen.getByRole('tab', { name: 'Full app report' }).click();
  });
  act(() => {
    screen.getByRole('button', { name: routeLabel }).click();
  });

  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  const row = findShuffleRow(8) as HTMLElement;
  expect(row).not.toBeNull();
  expect(document.activeElement).toBe(row);
  expect(row).toHaveAttribute('data-flashed', 'true');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });
});

test('DuplicatePlanSubtree.tsx jumps its own pagination to the page containing a route target beyond the first page', async () => {
  // duplicatePlanSubtree findings never carry a singular `stageId` (see the
  // anchor-routing test above); `target` is given one for a genuine
  // StageTable "Investigate ... in Stage N" route button. Same impact band
  // across all 8 findings keeps both the top-level impact-band sort and the
  // widget's own stable order tied to construction order, so building `target`
  // last in the array pushes it to the list's last rendered position (index
  // 7 of 8, i.e. page 2 of usePagedRows' VISIBLE_LIMIT-6 pagination).
  const others = Array.from({ length: 7 }, (_, i) =>
    duplicatePlanSubtreeFinding([i + 1], `Consolidate subtree ${i}.`, { impactBand: 'critical' }),
  );
  const target = duplicatePlanSubtreeFinding([8], 'Consolidate subtree target.', { impactBand: 'critical', stageId: 8 });
  renderReady([...others, target], [8]);
  await screen.findByRole('heading', { name: 'Redundant Plan Subtree' });

  const card = screen
    .getByRole('heading', { name: 'Redundant Plan Subtree' })
    .closest<HTMLElement>('[data-testid^="widget-grid-item-"]') as HTMLElement;
  expect(within(card).queryByText('Consolidate subtree target.')).not.toBeInTheDocument();
  expect(within(card).getByText('Page 1 of 2')).toBeInTheDocument();

  // Stage Summary (StageTable) lives inside the Full app report tab: expand
  // it to reach the route button. This also mounts every reference-region
  // widget for the first time, including CoreUsageHistogram's own unrelated
  // getTaskData fetch effect; flush that pending, unrelated async update
  // inside act so it doesn't leak into a later test as a bare act() warning
  // (same as the anchor-routing test above).
  await act(async () => {
    screen.getByRole('tab', { name: 'Full app report' }).click();
    await Promise.resolve();
    await Promise.resolve();
  });

  act(() => {
    screen.getByRole('button', { name: 'Investigate duplicate plan subtree in Stage 8' }).click();
  });

  const cardAfter = screen
    .getByRole('heading', { name: 'Redundant Plan Subtree' })
    .closest<HTMLElement>('[data-testid^="widget-grid-item-"]') as HTMLElement;
  expect(within(cardAfter).getByText('Page 2 of 2')).toBeInTheDocument();
  const rows = within(cardAfter).getAllByRole('listitem');
  // Page 2 holds the remaining 2 of 8 items (others[6] and target).
  expect(rows).toHaveLength(2);
  expect(rows[1]).toHaveTextContent('Consolidate subtree target.');
  expect(document.activeElement).toBe(rows[1]);
  expect(rows[1]).toHaveAttribute('data-flashed', 'true');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });
});

// --- CacheUtilization.tsx routing/anchor coverage. Its findings' `stageId` is
// always `null`, so routing goes through FixTheseFirst/SeverityBoard's
// recommendation row (`fixTheseFirstRow`) rather than StageTable.

// ConfigAudit.tsx's findings live only in the store's `configFindings` slot,
// never `catalog`, so this covers the route coordinator resolving against both.
test('a real ConfigAudit.tsx row is anchor-routable from its recommendation row', async () => {
  const finding: Finding = {
    type: 'configAudit', property: 'spark.serializer', value: 'java', stageId: null,
    impactBand: 'warning', recommendation: 'Use KryoSerializer.',
  };
  try {
    store.setState({ configFindings: [finding] });
    renderReady([]);
    await waitForDashboard();

    act(() => {
      fixTheseFirstRow('configAudit').click();
    });

    const row = await waitFor(() => {
      const found = screen
        .getAllByText('Use KryoSerializer.', { exact: false })
        .map((element) => element.closest('[data-flashed]') as HTMLElement | null)
        .find(Boolean);
      expect(found).not.toBeNull();
      return found!;
    });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(row).toHaveAttribute('data-flashed', 'true');
  } finally {
    store.setState({ configFindings: [] });
  }
});

test('a real CacheUtilization.tsx row is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms', async () => {
  const rddInfo = new Map([[1, rddRow(1)]]);
  renderReadyWithRdd([cacheUtilizationFinding(1)], rddInfo);
  // Cache Storage is code-split (React.lazy): let its chunk resolve with
  // real timers before faking setTimeout for the flash-clear assertion
  // further down.
  await screen.findByRole('heading', { name: 'Cache Storage' });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => {
      fixTheseFirstRow('cacheUtilization').click();
    });

    const trigger = screen.getByRole('heading', { name: 'Cache Storage' });
    const row = screen.getByText('rdd-1').closest('[data-flashed]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row);
    expect(row).toHaveAttribute('data-flashed', 'true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    // The anchor path replaces the title-focus path entirely.
    expect(trigger).not.toHaveAttribute('data-route-focused');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(row).toHaveAttribute('data-flashed', 'false');
  } finally {
    vi.useRealTimers();
  }
});

test('CacheUtilization.tsx jumps its own findings-list pagination to the page containing a route target beyond the first page', async () => {
  // CacheUtilization.tsx's own findings list sorts strictly by impact band
  // (IMPACT_BAND_ORDER), no secondary tiebreak, same as ConfigAudit.tsx above: giving
  // `target` the least severe impact band among 7 findings pushes it to the
  // group's last rendered position (index 6 of 7, i.e. page 2) in both the
  // widget's own list and FixTheseFirst's same-criterion group ranking.
  const rddInfo = new Map([[1, rddRow(1)]]);
  const target = cacheUtilizationFinding('target', 'info');
  const others = Array.from({ length: 6 }, (_, i) => cacheUtilizationFinding(i, 'critical'));
  renderReadyWithRdd([target, ...others], rddInfo);
  await screen.findByRole('heading', { name: 'Cache Storage' });

  act(() => {
    fixTheseFirstRow('cacheUtilization', 6).click();
  });

  const row = screen.getByText('rdd-target').closest('[data-flashed]') as HTMLElement;
  expect(row).not.toBeNull();
  expect(document.activeElement).toBe(row);
  expect(row).toHaveAttribute('data-flashed', 'true');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });

  const card = screen
    .getByRole('heading', { name: 'Cache Storage' })
    .closest<HTMLElement>('[data-testid^="widget-grid-item-"]') as HTMLElement;
  expect(within(card).getByText('Page 2 of 2')).toBeInTheDocument();
});
