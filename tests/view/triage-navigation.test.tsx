// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { flushSync } from 'react-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StrictMode } from 'react';

import App from '@/App';
import { emptyAppModel, selectAppModel, store } from '@/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { REGISTRY, type WidgetProps } from '@/view/detector-registry';
import { WidgetCard } from '@/view/WidgetCard';
import { useFindingAnchor, useIsRouteFlash } from '@/view/finding-anchor';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { testFinding } from './_shared/finding';
import { runState } from './_shared/run';

// Conventions shared by the tests below:
// - Stage Summary (StageTable) lives inside the Full app report tab, so tests select that tab to
//   reach its route buttons. Routing back to the Findings tab unmounts Full app report and
//   remounts Findings, so widget queries are repeated after the route.
// - Widgets are code-split (React.lazy): open the card first so the chunk resolves with real
//   timers before faking setTimeout for the flash-clear assertions.
// - Widgets whose rows use useFindingAnchor take the anchor path: the row itself gets focus and
//   the flash, and the disclosure title does not get data-route-focused.
// - The recommendations callout only routes into action-region findings; reference-region
//   findings are reached from Stage Summary.
// - Queries are scoped to the widget card because the verdict step for the same finding also
//   renders a "Stage N" button.

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
  return testFinding({
    type: 'failures',
    stageId,
    impactBand,
    value,
    failedTasks: 3,
    dominantReason: 'ExecutorLostFailure',
    dominantError: null,
    failureGroups: [],
    otherFailedTasks: 0,
    recommendation: `Investigate task failures in Stage ${stageId}.`,
  });
}

function retryWasteFinding(stageId: number, impactBand: Finding['impactBand'] = 'warning', value = 5_000): Finding {
  return testFinding({
    type: 'retryWaste',
    stageId,
    impactBand,
    value,
    numTasks: 1,
    memoryBytesSpilled: 0,
    retriedTaskDetails: [],
    extended: `Superseded retry detail for Stage ${stageId}.`,
    recommendation: `Investigate retry waste in Stage ${stageId}.`,
  });
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
  return testFinding({
    type: 'memoryUtilization',
    stageId,
    impactBand,
    variant: 'memoryBand',
    executorId: String(executorId),
    value: 0.9,
    recommendation: `Review heap sizing for executor ${executorId}.`,
  });
}

// `stageId` defaults to `null` to match the real plan detectors, which never
// set a singular `stageId` (only the plural `stageIds` DuplicatePlanSubtree.tsx groups by).
// A test below overrides it to get a precise per-finding StageTable route button.
// `label` doubles as the root name: the card's row says what repeats, not the recommendation.
function duplicatePlanSubtreeFinding(
  stageIds: number[],
  label: string,
  opts: { impactBand?: Finding['impactBand']; stageId?: number | null } = {},
): Finding {
  const { impactBand = 'warning', stageId = null } = opts;
  return testFinding({
    type: 'duplicatePlanSubtree', impactBand, stageId, stageIds, recommendation: label,
    executionId: 1, planNodeIds: [], stageShares: {}, occurrencesIdentical: true,
    rootName: label, value: 2, subtreeSize: 1, sampleRelation: null, groupIndex: 0,
  });
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

function renderReady(catalog: Finding[], stageIds: number[] = [], widgetDensity: 'basic' | 'advanced' = 'advanced', configFindings: Finding[] = []) {
  store.setState({
    status: 'ready',
    ...runState({ appModel: readyAppModel(stageIds), catalog, configFindings }, 'file-a'),
    activeFileId: 'file-a',
    taskDataCache: new Map(),
    errorMessage: null,
    parse: { pct: 0, lines: 0, etaMs: null },
    // These tests drive card-level routing (focus, flash, pagination) in Advanced
    // view; Basic view's folded evidence is covered at the end of this file.
    widgetDensity,
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
    ...runState({ appModel: { ...model, app: { ...model.app, rddInfo } as unknown as AppModel['app'] }, catalog }, 'file-a'),
    activeFileId: 'file-a',
    taskDataCache: new Map(),
    errorMessage: null,
    parse: { pct: 0, lines: 0, etaMs: null },
    // These tests drive card-level routing (focus, flash, pagination) in Advanced
    // view; Basic view's folded evidence is covered at the end of this file.
    widgetDensity: 'advanced',
  });
  return render(<App />);
}

// The verdict owns the top three findings and every step, like every Findings
// row, shows its own evidence panel scoped to its finding: its "Show evidence"
// toggles that panel and does not route. A route (Stage Summary, the stage
// dialog, a group row's member) opens the panel whose scope holds the target
// finding. These tests drive that routing (scroll, focus, flash, pagination,
// cancellation) from the Stage Summary, or from a group member's row for a
// finding with no stage. `leadSaving` and `asLead` put a higher-ranked step
// beside the finding under test.
const leadSaving = { basis: 'serial', wallClock: { low: 60_000, high: 60_000 }, estimateMethod: 'measured' } as Finding['impactEstimate'];

/** The same finding at another place with the biggest saving: the step that leads the verdict and owns the card. */
function asLead(finding: Finding, overrides: Partial<Finding> = {}): Finding {
  const id = finding.id ? { id: `${finding.id}:lead` } : {};
  return { ...finding, impactBand: 'critical', impactEstimate: leadSaving, ...id, ...overrides } as Finding;
}

function verdictSteps(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Next steps' })).getAllByTestId('next-step');
}

/** A verdict step's evidence button, steps numbered from 0. */
function stepEvidenceButton(index: number): HTMLElement {
  return within(verdictSteps()[index]).getByRole('button', { name: /^(show|hide) evidence$/i });
}

/** The evidence panel's heading inside a verdict step, steps numbered from 0. */
function stepPanelHeading(index: number, name: string): HTMLElement {
  return within(verdictSteps()[index]).getByRole('heading', { name });
}

/** The anchored row inside a verdict step's evidence card. The step line states its finding, so the
 * row leaves out its stage chip and is found by its anchor. */
function panelRow(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>('[data-flashed]');
}

/** A finding's Stage Summary route button, which is in the Full app report tab. */
async function stageSummaryRoute(label: string): Promise<HTMLElement> {
  await act(async () => {
    screen.getByRole('tab', { name: 'Full app report' }).click();
    await Promise.resolve();
    await Promise.resolve();
  });
  return screen.getByRole('button', { name: label });
}

/** Routes to a finding from its Stage Summary row. */
async function routeFromStageSummary(label: string) {
  const button = await stageSummaryRoute(label);
  act(() => {
    button.click();
  });
}

/** Opens the evidence panel of the Findings-tab group row for `findingType`. */
async function openGroupEvidence(findingType: string, user = userEvent.setup()) {
  const groupRow = screen.getAllByTestId('fix-these-first-group-row').find((row) => row.dataset.findingType === findingType);
  if (!groupRow) throw new Error(`No "fix-these-first-group-row" for type "${findingType}"`);
  await user.click(within(groupRow).getByRole('button', { name: 'Show evidence' }));
}

/** Opens the lead step's card in place, which also lets its lazy chunk resolve. */
async function openLeadEvidence(heading: string, user = userEvent.setup()) {
  await user.click(stepEvidenceButton(0));
  await screen.findByRole('heading', { name: heading });
}

/** Three findings of other types, each on its own stage with the biggest saving: they fill the verdict's steps. */
function stepLeads(): Finding[] {
  return [asLead(spillFinding(41)), asLead(skewFinding(42, 'critical')), asLead(shuffleFinding(43))];
}

/** The Findings-tab row for a finding of `findingType` and its route button. Findings
 * sharing a type collapse into a `fix-these-first-group-row`; this expands that group
 * first and returns the `index`-th instance row's navigate button. */
function boardRowRoute(findingType: string, index = 0, containing = ''): HTMLElement {
  const ofType = () => screen.queryAllByTestId('fix-these-first-row')
    .filter((row) => row.dataset.findingType === findingType && (row.textContent ?? '').includes(containing));
  let rows = ofType();
  const groupRow = screen
    .queryAllByTestId('fix-these-first-group-row')
    .find((row) => row.dataset.findingType === findingType);
  if (groupRow) {
    // The group's first button toggles its member list; its evidence control comes after.
    flushSync(() => { within(groupRow).getAllByRole('button')[0].click(); });
    rows = ofType();
  }
  const row = rows[index];
  if (!row) throw new Error(`No "fix-these-first-row" for type "${findingType}" at index ${index} (found ${rows.length})`);
  // A single finding's row routes through its "Show evidence" button; a group member's
  // row is one navigate button. Either way, not the row's StagePill.
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
  // These tests list info findings too.
  window.history.replaceState({}, '', '/?impact=critical,warning,info');
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
  store.setState({ widgetDensity: 'basic' });
});

test('routes a Reference-region target from Stage Summary: expanding its exact card, scrolling, and focusing its disclosure', async () => {
  // memoryUtilization is reference-region only, so Stage Summary is its click-through source.
  // Its destination, Memory Utilization, lives in the Findings tab, so routing switches back
  // there and Full app report ends up unselected again.
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
  // The destination (Memory Utilization) lives in the Findings tab.
  const user = userEvent.setup();
  store.setState({
    status: 'ready',
    ...runState({ appModel: readyAppModel([1]), catalog: [memoryFinding(1)] }, 'file-a'),
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

test('a route opens only the exact panel of its finding and leaves Full app report and Clean checks closed', async () => {
  renderReady([asLead(spillFinding(90)), spillFinding(1)], [1, 90]);

  await waitForDashboard();
  await routeFromStageSummary('Investigate spill in Stage 1');

  const trigger = await screen.findByRole('heading', { name: 'Spill' });
  // The lead step's panel stays closed: only the second step's holds the routed finding.
  expect(stepPanelHeading(1, 'Spill')).toBe(trigger);
  // Spill.tsx anchors each row, so routing focuses the row itself
  // rather than the disclosure title; see the anchor-routing tests below.
  const spillCard = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
  const row = panelRow(spillCard);
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(screen.getByRole('tab', { name: 'Full app report' })).toHaveAttribute('aria-selected', 'false');
  expect(screen.getByRole('button', { name: /clean checks/i })).toHaveAttribute('aria-expanded', 'false');
});

test('a core-locality target switches to Full app report, where its always-mounted card lives, and focuses it', async () => {
  const user = userEvent.setup();
  const locality: Finding = testFinding({ type: 'coreLocality', stageId: null, impactBand: 'warning', value: 40, nonLocalTaskCount: 0, recommendation: 'Check locality.' });
  renderReady([locality], [1]);

  await waitForDashboard();
  await user.click(stepEvidenceButton(0));

  expect(screen.getByRole('tab', { name: 'Full app report' })).toHaveAttribute('aria-selected', 'true');
  const reportPanel = screen.getByRole('tabpanel', { name: 'Full app report' });
  const heading = await within(reportPanel).findByRole('heading', { name: 'Core Usage by Locality' });
  const card = heading.closest<HTMLElement>('[data-testid^="widget-grid-item-"]') as HTMLElement;
  await waitFor(() => expect(card.contains(document.activeElement)).toBe(true));
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

test('initial render never scrolls or moves focus, and opening a step\'s evidence does not claim route focus', async () => {
  renderReady([spillFinding(1)], [1]);

  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(document.body);
  // The verdict keeps its card closed until asked.
  expect(screen.queryByRole('heading', { name: 'Spill' })).not.toBeInTheDocument();

  await userEvent.setup().click(stepEvidenceButton(0));
  expect(await screen.findByRole('heading', { name: 'Spill' })).not.toHaveAttribute('data-route-focused');
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
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
 * only by the blur-cleanup test below. The real `Spill.tsx` anchors stage 1's
 * row, so this double keeps the test on the title-focus/blur-cleanup mechanism. */
function BareSpill() {
  return <WidgetCard title="Spill">spill details</WidgetCard>;
}

test('blur cleanup is ignored for unrelated widgets and clears only the route-focused widget', async () => {
  REGISTRY.spill.component = BareSpill;
  const user = userEvent.setup();
  // Steps: the lead spill, spill Stage 1, skew Stage 2.
  const catalog = [asLead(spillFinding(90)), spillFinding(1, 'critical'), skewFinding(2, 'warning')];
  renderReady(catalog, [1, 2, 90]);
  await waitForDashboard();

  // Task Skew is the real Skew widget; open its panel first so its chunk resolves before the route.
  await user.click(stepEvidenceButton(2));
  const skewTrigger = await screen.findByRole('heading', { name: 'Task Skew' });
  await routeFromStageSummary('Investigate spill in Stage 1');
  // Spill.tsx is substituted with the (non-lazy) BareSpill double above.
  const spillTrigger = stepPanelHeading(1, 'Spill');
  await waitFor(() => expect(spillTrigger).toHaveAttribute('data-route-focused'));

  fireEvent.blur(skewTrigger);
  expect(spillTrigger).toHaveAttribute('data-route-focused');

  fireEvent.blur(spillTrigger);
  await waitFor(() => expect(spillTrigger).not.toHaveAttribute('data-route-focused'));
});

test('route focus marks only the panel the route opened, not the widget\'s other open panels', async () => {
  REGISTRY.spill.component = BareSpill;
  const user = userEvent.setup();
  // Steps: the lead spill, spill Stage 1, spill Stage 3: each step has its own Spill panel.
  const catalog = [asLead(spillFinding(90)), spillFinding(1, 'critical'), spillFinding(3, 'critical')];
  renderReady(catalog, [1, 3, 90]);
  await waitForDashboard();

  await user.click(stepEvidenceButton(1));
  const stageOneTrigger = await screen.findByRole('heading', { name: 'Spill' });
  await routeFromStageSummary('Investigate spill in Stage 3');
  const stageThreeTrigger = stepPanelHeading(2, 'Spill');
  await waitFor(() => expect(stageThreeTrigger).toHaveAttribute('data-route-focused'));
  expect(stepPanelHeading(1, 'Spill')).toBe(stageOneTrigger);
  expect(stageOneTrigger).not.toHaveAttribute('data-route-focused');

  fireEvent.blur(stageOneTrigger);
  expect(stageThreeTrigger).toHaveAttribute('data-route-focused');
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
  const skewTrigger = await screen.findByRole('heading', { name: 'Task Skew' });
  const skewCard = skewTrigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
  const skewRow = panelRow(skewCard);
  await waitFor(() => expect(document.activeElement).toBe(skewRow));
  // The superseded spill route never opened its card.
  expect(screen.queryByRole('heading', { name: 'Spill' })).not.toBeInTheDocument();
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
});

test('catalog replacement cancels a pending route without scrolling or moving focus', async () => {
  renderReady([asLead(spillFinding(90)), spillFinding(1)], [1, 90]);
  await waitForDashboard();
  const initiator = await stageSummaryRoute('Investigate spill in Stage 1');
  initiator.focus();

  act(() => {
    initiator.click();
    store.setState(runState({ appModel: selectAppModel(store.getState()), catalog: [] }, 'file-a'));
  });

  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(document.body);
});

test('active-file replacement cancels a pending route without scrolling or moving focus', async () => {
  renderReady([asLead(spillFinding(90)), spillFinding(1)], [1, 90]);
  await waitForDashboard();
  const initiator = await stageSummaryRoute('Investigate spill in Stage 1');
  initiator.focus();

  act(() => {
    initiator.click();
    // Another run takes over the dashboard under its own key.
    store.setState({ activeFileId: 'file-b', runKey: 'file-b' });
  });

  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  // The route switched to Findings, which hides the initiator; focus must not have landed on a routed row.
  expect(document.activeElement?.closest('[data-flashed]')).toBeNull();
});

test('unmounting a pending target cancels without scrolling or moving focus', async () => {
  const view = renderReady([asLead(spillFinding(90)), spillFinding(1)], [1, 90]);
  await waitForDashboard();
  const initiator = await stageSummaryRoute('Investigate spill in Stage 1');
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
  // The Task Skew trigger/row is looked up fresh after each route rather than captured up front.
  const skewRow = () => {
    const skewTrigger = screen.getByRole('heading', { name: 'Task Skew' });
    const skewCard = skewTrigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
    return panelRow(skewCard);
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

test('a step\'s panel shows only the stage of its own finding', async () => {
  const user = userEvent.setup();
  // selectTriageTarget ranks by potential savings, not impact band (see
  // src/view/triage-target.ts): give Stage 2's finding a real estimate so it leads.
  const lead: Finding = {
    ...skewFinding(2, 'critical'),
    impactEstimate: { basis: 'serial', wallClock: { low: 60_000, high: 60_000 }, estimateMethod: 'measured' },
  };
  renderReady([skewFinding(9, 'warning'), lead], [9, 2]);

  await user.click(stepEvidenceButton(1));

  const trigger = await screen.findByRole('heading', { name: 'Task Skew' });
  const card = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]');
  if (!card) throw new Error('Task Skew should remain inside its registered grid item');
  // The step line states its finding, so the panel's row carries no stage chip: it names its stage by the stage's own name.
  expect(card.querySelectorAll('[data-flashed]')).toHaveLength(1);
  expect(card).toHaveTextContent('stage-9');
  expect(card).not.toHaveTextContent('stage-2');
  expect(stepEvidenceButton(0)).toHaveAttribute('aria-expanded', 'false');
});

test('each step of a type opens its own evidence panel without routing, and both stay open', async () => {
  const user = userEvent.setup();
  renderReady([asLead(skewFinding(2, 'critical')), skewFinding(9, 'warning')], [2, 9]);
  await waitForDashboard();

  await user.click(stepEvidenceButton(0));
  await user.click(stepEvidenceButton(1));

  expect(await screen.findAllByRole('heading', { name: 'Task Skew' })).toHaveLength(2);
  expect(stepEvidenceButton(0)).toHaveAttribute('aria-expanded', 'true');
  expect(stepEvidenceButton(1)).toHaveAttribute('aria-expanded', 'true');
  // Each panel holds only the stage of the step it sits under.
  const panel = (index: number) => stepPanelHeading(index, 'Task Skew').closest('section') as HTMLElement;
  for (const [index, stage] of [[0, 'stage-2'], [1, 'stage-9']] as const) {
    expect(panel(index).querySelectorAll('[data-flashed]')).toHaveLength(1);
    expect(panel(index)).toHaveTextContent(stage);
    expect(panel(index)).not.toHaveTextContent(stage === 'stage-2' ? 'stage-9' : 'stage-2');
  }
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});

test('a route to a finding no step or row holds opens its type\'s full card, without reordering it', async () => {
  const user = userEvent.setup();
  const lead: Finding = {
    ...skewFinding(2, 'critical'),
    impactEstimate: { basis: 'serial', wallClock: { low: 60_000, high: 60_000 }, estimateMethod: 'measured' },
  };
  // Evidence-unavailable findings are not rolled up, so no step or row holds this one.
  const unlisted = { ...skewFinding(5, 'warning'), dataUnavailable: true } as Finding;
  renderReady([skewFinding(9, 'warning'), lead, unlisted], [9, 2, 5]);
  await waitForDashboard();
  // Task Skew is the real Skew widget; open a step's panel first so its lazy chunk resolves.
  await user.click(stepEvidenceButton(0));
  await screen.findByRole('heading', { name: 'Task Skew' });
  await user.click(stepEvidenceButton(0));
  expect(screen.queryByRole('heading', { name: 'Task Skew' })).not.toBeInTheDocument();

  await routeFromStageSummary('Investigate task skew in Stage 5');

  const trigger = await screen.findByRole('heading', { name: 'Task Skew' });
  const card = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
  expect(within(card).getAllByRole('button', { name: /open details for stage/i }).map((button) => button.getAttribute('aria-label')))
    .toEqual(['Open details for Stage 2', 'Open details for Stage 9', 'Open details for Stage 5']);
  const row = within(card).getByRole('button', { name: 'Open details for Stage 5' }).closest('[data-flashed]');
  await waitFor(() => expect(document.activeElement).toBe(row));
});

test('an anchored row is scrolled to center and focused instead of the disclosure title, and is flagged as flashed', async () => {
  REGISTRY.spill.component = SpillWithAnchoredRows;
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  renderReady([asLead(spillFinding(90)), spillFinding(1)], [1, 90]);

  await routeFromStageSummary('Investigate spill in Stage 1');

  const row = await screen.findByTestId('spill-row-1');
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });
  expect(row).toHaveAttribute('data-flashed', 'true');
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
  routeLabel: string;
  makeFinding: () => Finding;
}>([
  {
    title:
      'a real Spill.tsx row (Task 4) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'spill',
    heading: 'Spill',
    routeLabel: 'Investigate spill in Stage 1',
    makeFinding: () => spillFinding(1),
  },
  {
    title:
      'a real Skew.tsx row (Task 5) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'skew',
    heading: 'Task Skew',
    routeLabel: 'Investigate task skew in Stage 1',
    makeFinding: () => skewFinding(1, 'critical'),
  },
])('$title', async ({ heading, routeLabel, makeFinding }) => {
  renderReady([asLead(makeFinding(), { stageId: 90 }), makeFinding()], [1, 90]);
  // The lead step shows the card in place; open it so its lazy chunk resolves
  // with real timers before faking setTimeout for the flash-clear assertion.
  await openLeadEvidence(heading);
  const routeButton = await stageSummaryRoute(routeLabel);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    // The Stage 1 step's own panel holds the routed finding.
    act(() => {
      routeButton.click();
    });

    const trigger = stepPanelHeading(1, heading);
    const card = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
    const row = panelRow(card) as HTMLElement;
    expect(document.activeElement).toBe(row);
    expect(row).toHaveAttribute('data-flashed', 'true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    expect(trigger).not.toHaveAttribute('data-route-focused');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(row).toHaveAttribute('data-flashed', 'false');
  } finally {
    vi.useRealTimers();
  }
});

test('the flash clears automatically after 2000ms', async () => {
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
    renderReady([asLead(spillFinding(90)), spillFinding(1)], [1, 90]);

    await routeFromStageSummary('Investigate spill in Stage 1');
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
    // Stage 2 leads the verdict; each step has its own panel.
    renderReady([spillFinding(1), asLead(spillFinding(2))], [1, 2]);

    await routeFromStageSummary('Investigate spill in Stage 1');
    const row1 = screen.getByTestId('spill-row-1');
    expect(row1).toHaveAttribute('data-flashed', 'true');

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    // Settling the SpillWithAnchoredRows remount plus the anchor-lookup/flash-state chain
    // needs an extra microtask tick, hence `await act(async ...)`.
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

test('activeRouteTarget reflects the pending route while unresolved, and clears once the pending route is canceled', async () => {
  // A widget that mounts no `WidgetCard` at all: `reportWidgetOpen` is never
  // called, so the route never resolves/clears on its own, making the pending
  // window observable deterministically instead of racing real effect flushing.
  function UnresponsiveSpill() {
    const target = useActiveRouteTarget();
    return <span data-testid="active-target">{target?.widgetId ?? 'none'}</span>;
  }
  REGISTRY.spill.component = UnresponsiveSpill;
  renderReady([asLead(spillFinding(90)), spillFinding(1)], [1, 90]);
  await waitForDashboard();
  // Open the Stage 1 step's card, which mounts the double; the route then targets its finding.
  act(() => stepEvidenceButton(1).click());
  const initiator = await stageSummaryRoute('Investigate spill in Stage 1');

  expect(screen.getByTestId('active-target')).toHaveTextContent('none');

  act(() => initiator.click());
  expect(screen.getByTestId('active-target')).toHaveTextContent('spill');

  // Another run replacing the dashboard cancels the pending route (the dashboard remounts under the
  // new run's key, see "active-file replacement cancels a pending route..." above); the new
  // dashboard starts with no active target, so its step's card is opened again to read it. (Clearing the catalog instead
  // would also drop the spill finding's impact band, unmounting this widget via
  // Alerts's active/clean split, a confound unrelated to what's under test.)
  act(() => {
    store.setState({ activeFileId: 'file-b', runKey: 'file-b' });
  });
  await waitForDashboard();
  act(() => stepEvidenceButton(1).click());
  expect(await screen.findByTestId('active-target')).toHaveTextContent('none');
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
  renderReady([asLead(shuffleFinding(90)), shuffleFinding(1)], [1, 90]);
  await openLeadEvidence('Shuffle I/O');
  const routeButton = await stageSummaryRoute('Investigate shuffle I/O in Stage 1');

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => {
      routeButton.click();
    });

    const trigger = stepPanelHeading(1, 'Shuffle I/O');
    const row = panelRow(trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement) as HTMLElement;
    expect(document.activeElement).toBe(row);
    expect(row).toHaveAttribute('data-flashed', 'true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
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
  // own `GcSection` with its own `page` state. Three leads take the verdict's
  // steps; the other findings form one group whose panel holds both buckets.
  // Build 7 flagged stages per bucket (VISIBLE_LIMIT is 6) so both sections paginate,
  // then route to a high-bucket finding and assert only the high section's page moves: the
  // low section's `sorted.findIndex` misses (-1) for a finding it doesn't
  // contain, so its page must stay put (the "-1 fallthrough" correctness property).
  const highStageIds = Array.from({ length: 7 }, (_, i) => i + 1);
  const lowStageIds = Array.from({ length: 7 }, (_, i) => i + 8);
  // Same impact band within each bucket, so the stages list in order: Stage 7
  // sorts last (index 6): floor(6 / 6) = page 1 (the second page, "Page 2 of 2").
  const highFindings = highStageIds.map((stageId) => gcFinding(stageId, { value: stageId * 10 }));
  const lowFindings = lowStageIds.map((stageId) => gcFinding(stageId, { direction: 'low', value: stageId * 10 }));
  const leads = [90, 91, 92].map((stageId) => asLead(gcFinding(stageId)));
  renderReady([...leads, ...highFindings, ...lowFindings], [...highStageIds, ...lowStageIds, 90, 91, 92]);
  await waitForDashboard();
  await openGroupEvidence('gc');

  const overheadSection = (await screen.findByText('GC overhead', { exact: false })).closest('section') as HTMLElement;
  const lowSection = screen.getByText('Low GC (cost)', { exact: false }).closest('section') as HTMLElement;

  // Before routing: Stage 7's row isn't in the DOM yet (page 0 only shows
  // Stages 1-6 of the high bucket), and both sections show page 1 of 2.
  expect(findShuffleRow(7)).toBeNull();
  expect(within(overheadSection).getByText('Page 1 of 2')).toBeInTheDocument();
  expect(within(lowSection).getByText('Page 1 of 2')).toBeInTheDocument();

  // `overheadSection`/`lowSection` must be re-queried after routing.
  await routeFromStageSummary('Investigate GC pressure in Stage 7');

  const overheadSectionAfter = screen.getByText('GC overhead', { exact: false }).closest('section') as HTMLElement;
  const lowSectionAfter = screen.getByText('Low GC (cost)', { exact: false }).closest('section') as HTMLElement;

  // Only the high-GC section's page jumped to reveal Stage 7; the low-GC
  // section's page is untouched.
  expect(within(overheadSectionAfter).getByText('Page 2 of 2')).toBeInTheDocument();
  expect(within(lowSectionAfter).getByText('Page 1 of 2')).toBeInTheDocument();

  const row = findShuffleRow(7) as HTMLElement;
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
// their findings takes the anchor path on the real widget.
test.each<{
  title: string;
  key: string;
  heading: string;
  routeLabel: string;
  makeFinding: () => Finding;
}>([
  {
    title:
      'a real GcPressure.tsx row (Task 7) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'gc',
    heading: 'GC Pressure',
    routeLabel: 'Investigate GC pressure in Stage 1',
    makeFinding: () => gcFinding(1),
  },
  {
    title:
      'a real TaskFailures.tsx row (Task 8) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'failures',
    heading: 'Failed Tasks',
    routeLabel: 'Investigate failed tasks in Stage 1',
    makeFinding: () => taskFailuresFinding(1),
  },
  {
    title:
      'a real RetryWaste.tsx row (Task 8) is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'retryWaste',
    heading: 'Retry Waste',
    routeLabel: 'Investigate retry waste in Stage 1',
    makeFinding: () => retryWasteFinding(1),
  },
  {
    title:
      'a real SlowHost.tsx row is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms',
    key: 'slowHost',
    heading: 'Slow Executor Host',
    routeLabel: 'Investigate slow executor host in Stage 1',
    makeFinding: () => slowHostFinding(1),
  },
])('$title', async ({ heading, routeLabel, makeFinding }) => {
  renderReady([asLead(makeFinding(), { stageId: 90 }), makeFinding()], [1, 90]);
  await openLeadEvidence(heading);
  const routeButton = await stageSummaryRoute(routeLabel);

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => {
      routeButton.click();
    });

    const trigger = stepPanelHeading(1, heading);
    const card = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
    const row = panelRow(card) as HTMLElement;
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row);
    expect(row).toHaveAttribute('data-flashed', 'true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
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
  // Memory Utilization's card is the verdict step's evidence.
  await openLeadEvidence('Memory Utilization');

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
  // The lead takes the verdict's step; the other two form a group whose member
  // row routes to the finding and opens the group's panel.
  renderReady([asLead(cachingFinding('lead', 1024)), cachingFinding('orders', 1024), cachingFinding('items', 1024)]);
  await waitForDashboard();
  // Open the group's panel so the widget's lazy chunk resolves with real timers.
  await openGroupEvidence('cachingOpportunity');
  await screen.findByRole('heading', { name: 'Caching Opportunities' });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => {
      boardRowRoute('cachingOpportunity', 0, 'orders').click();
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
  // usePagedRows's page size is VISIBLE_LIMIT (6, packages/core/src/format-utils.ts). The
  // `cachingOpportunity` detector always emits `impactBand: 'info'`
  // (packages/core/src/detectors.ts). The lead takes the verdict's step and the other
  // eight findings form a group whose panel paginates. Giving `target` the smallest
  // `totalReadBytes` makes the widget's own descending-bytes sort push it to the *last*
  // rendered position (page 2), so this only passes if the page jump actually fires,
  // not merely if the target happens to already be visible on page 1.
  const target = cachingFinding('rel-target', 1);
  const others = Array.from({ length: 7 }, (_, i) => cachingFinding(`rel-${i}`, (i + 1) * 1_000));
  renderReady([asLead(cachingFinding('lead', 1)), target, ...others]);
  await waitForDashboard();
  await openGroupEvidence('cachingOpportunity');
  expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();

  act(() => {
    boardRowRoute('cachingOpportunity', 0, 'rel-target').click();
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
  // window (only that page's remaining rows).
  expect(within(card).getByText('Page 2 of 2')).toBeInTheDocument();
});

test('MemoryUtilization.tsx (final whole-branch review fix) jumps its own pagination to the page containing a route target beyond the first page', async () => {
  // A missing `routeIndex` wire is most reachable in MemoryUtilization, since its
  // `memoryBand` variant emits one finding per flagged executor and routinely
  // exceeds VISIBLE_LIMIT (6).
  //
  // Its list sorts purely by impact band, so giving `target` the least severe
  // band among the group's findings pushes it to the last position (page 2).
  // The lead takes the verdict's step; the group's panel holds the other ten, and the
  // member row for `target` routes to it.
  const target = memoryBandFinding('target', 'warning');
  const others = Array.from({ length: 9 }, (_, i) => memoryBandFinding(i, 'critical'));
  renderReady([asLead(memoryBandFinding('lead', 'critical')), target, ...others]);
  await waitForDashboard();

  act(() => {
    boardRowRoute('memoryUtilization', 0, 'target').click();
  });

  const row = (await screen.findByText('Executor target')).closest('[data-flashed]') as HTMLElement;
  expect(row).not.toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(row).toHaveAttribute('data-flashed', 'true');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });

  const card = screen
    .getByRole('heading', { name: 'Memory Utilization' })
    .closest<HTMLElement>('[data-testid^="widget-grid-item-"]') as HTMLElement;
  // The page jumps to page 2 of 2 to reveal the target; it requires `usePagedRows`
  // to receive a `routeIndex`.
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
  // Three other findings take the verdict's steps; `first` and `target` form a group, whose panel lists both.
  const first = duplicatePlanSubtreeFinding([3], 'Consolidate subtree A.', { impactBand: 'critical' });
  const target = duplicatePlanSubtreeFinding([7], 'Consolidate subtree B.', { impactBand: 'warning', stageId: 7 });
  renderReady([...stepLeads(), first, target], [7, 41, 42, 43]);
  await waitForDashboard();
  await openGroupEvidence('duplicatePlanSubtree');
  await screen.findByRole('heading', { name: 'Redundant Plan Subtree' });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    // Selecting the tab mounts every reference-region widget for the first time, including
    // `CoreUsageHistogram`'s unrelated `getTaskData` fetch effect; flush that pending async
    // update inside `act` so it does not leak into a later test as a bare act() warning.
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
    expect(trigger).not.toHaveAttribute('data-route-focused');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(row).toHaveAttribute('data-flashed', 'false');
  } finally {
    vi.useRealTimers();
  }
});

// Page-jump guards for the six widgets whose other routing
// coverage renders 1-2 findings that never leave page 1 (Spill.tsx,
// Skew.tsx, SlowHost.tsx, DuplicatePlanSubtree.tsx, TaskFailures.tsx,
// RetryWaste.tsx), plus basic coverage for ConfigAudit.tsx/CacheUtilization.tsx's own findings list.

// Each widget's own sort comparator (or, absent a tiebreak, plain
// `Array.prototype.sort` stability) pushes Stage 12 to the panel's last
// rendered position (index 8 of 9: floor(8 / 6) = page 1, "Page 2 of 2") when
// every finding shares the same impact band, so this only passes if the
// route's page jump actually fires, not merely if the target happens to
// already be visible on page 1. `findShuffleRow` (defined above) isn't
// Shuffle-specific: it just finds a "Open details for Stage N" button inside
// a `[data-flashed]` row, a convention every widget below follows.
test.each<{
  title: string;
  type: string;
  heading: string;
  makeFinding: (stageId: number) => Finding;
}>([
  {
    title:
      'ShuffleIO.tsx (Task 6) jumps its own page to reveal a route target that is not on the currently-visible page',
    type: 'shuffle',
    heading: 'Shuffle I/O',
    makeFinding: (stageId) => shuffleFinding(stageId, 'critical', (13 - stageId) * 100),
  },
  {
    title:
      'TaskFailures.tsx jumps its own pagination to reveal a route target that is not on the currently-visible page',
    type: 'failures',
    heading: 'Failed Tasks',
    makeFinding: (stageId) => taskFailuresFinding(stageId, 'critical'),
  },
  {
    title:
      'RetryWaste.tsx jumps its own pagination to reveal a route target that is not on the currently-visible page',
    type: 'retryWaste',
    heading: 'Retry Waste',
    makeFinding: (stageId) => retryWasteFinding(stageId, 'critical'),
  },
  {
    title: 'Spill.tsx jumps its own pagination to reveal a route target that is not on the currently-visible page',
    type: 'spill',
    heading: 'Spill',
    makeFinding: (stageId) => ({ ...spillFinding(stageId, 'critical'), value: (13 - stageId) * 1024 ** 3 }) as Finding,
  },
  {
    title: 'Skew.tsx jumps its own pagination to reveal a route target that is not on the currently-visible page',
    type: 'skew',
    heading: 'Task Skew',
    makeFinding: (stageId) => skewFinding(stageId, 'critical'),
  },
  {
    title:
      'SlowHost.tsx jumps its own pagination to reveal a route target that is not on the currently-visible page',
    type: 'slowHost',
    heading: 'Slow Executor Host',
    makeFinding: (stageId) => slowHostFinding(stageId, 'critical'),
  },
])('$title', async ({ type, makeFinding }) => {
  const stageIds = Array.from({ length: 12 }, (_, i) => i + 1);
  const findings = stageIds.map((stageId) => makeFinding(stageId));
  renderReady(findings, stageIds);
  await waitForDashboard();
  // The verdict's three steps take Stages 1-3. The other nine form one group, and its panel pages by six.
  await openGroupEvidence(type);

  // Before routing: Stage 12's row isn't in the DOM yet (page 0 only shows
  // Stages 4-9), and the panel shows page 1 of 2.
  expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();
  expect(findShuffleRow(12)).toBeNull();

  // The group's member row for Stage 12 routes to the finding.
  act(() => {
    boardRowRoute(type, 0, 'Stage 12').click();
  });

  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  const row = findShuffleRow(12) as HTMLElement;
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
  renderReady([...stepLeads(), ...others, target], [8, 41, 42, 43]);
  await waitForDashboard();
  // Three other findings take the verdict's steps; the eight duplicates form a group whose panel paginates.
  await openGroupEvidence('duplicatePlanSubtree');
  await screen.findByRole('heading', { name: 'Redundant Plan Subtree' });

  const card = screen
    .getByRole('heading', { name: 'Redundant Plan Subtree' })
    .closest<HTMLElement>('[data-testid^="widget-grid-item-"]') as HTMLElement;
  expect(within(card).queryByText(/Consolidate subtree target\./)).not.toBeInTheDocument();
  expect(within(card).getByText('Page 1 of 2')).toBeInTheDocument();

  // Selecting the tab mounts every reference-region widget; flush the unrelated
  // CoreUsageHistogram getTaskData effect inside act (same as the anchor-routing test above).
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
// always `null`, so routing goes through a Findings-tab row (`boardRowRoute`) rather than StageTable.

// ConfigAudit.tsx's findings live only in the store's `configFindings` slot,
// never `catalog`, so this covers the route coordinator resolving against both.
test('a real ConfigAudit.tsx row is anchor-routable from its recommendation row', async () => {
  const finding: Finding = testFinding({
    type: 'configAudit', property: 'spark.serializer', valueText: 'java', stageId: null,
    impactBand: 'warning', recommendation: 'Use KryoSerializer.',
  });
  // The app-level step takes the lead; this finding and `other` form a group, whose member row routes to the finding.
  const other: Finding = testFinding({
    type: 'configAudit', property: 'spark.other', valueText: 'y', stageId: null,
    impactBand: 'warning', recommendation: 'Use another setting.',
  });
  const lead: Finding = testFinding({
    type: 'configAudit', property: 'spark.lead', valueText: 'x', stageId: null,
    impactBand: 'critical', recommendation: 'Lead setting.', impactEstimate: leadSaving,
  });
  try {
    renderReady([], [], 'advanced', [lead, finding, other]);
    await waitForDashboard();
    await openGroupEvidence('configAudit');
    await screen.findByRole('heading', { name: 'Config Audit' });

    act(() => {
      boardRowRoute('configAudit', 0, 'KryoSerializer').click();
    });

    const row = await waitFor(() => {
      const found = screen
        .getAllByText('Use KryoSerializer.', { exact: false })
        .map((element) => element.closest('[data-flashed]') as HTMLElement | null)
        .find(Boolean);
      expect(found).toBeTruthy();
      return found!;
    });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(row).toHaveAttribute('data-flashed', 'true');
  } finally {
    store.getState().resetModel();
  }
});

test('a real CacheUtilization.tsx row is anchor-routable: focus and the flash land on the row, not the disclosure title, and the flash clears after 2000ms', async () => {
  const rddInfo = new Map([[1, rddRow(1)]]);
  // The app-level step takes `rdd-0`; `rdd-1` and `rdd-2` form a group, whose member row routes to `rdd-1`.
  renderReadyWithRdd([asLead(cacheUtilizationFinding(0)), cacheUtilizationFinding(1), cacheUtilizationFinding(2)], rddInfo);
  await waitForDashboard();
  await openGroupEvidence('cacheUtilization');
  await screen.findByRole('heading', { name: 'Cache Storage' });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => {
      boardRowRoute('cacheUtilization', 0, 'rdd-1').click();
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
  const others = Array.from({ length: 7 }, (_, i) => cacheUtilizationFinding(i, 'critical'));
  renderReadyWithRdd([asLead(cacheUtilizationFinding('lead')), target, ...others], rddInfo);
  await waitForDashboard();
  // The lead takes the verdict's step; the other eight form a group whose panel paginates.
  await openGroupEvidence('cacheUtilization');
  expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();

  act(() => {
    boardRowRoute('cacheUtilization', 0, 'rdd-target').click();
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

test('Basic view keeps a step\'s evidence card folded until its Show evidence is pressed', async () => {
  const user = userEvent.setup();
  renderReady([spillFinding(1)], [1], 'basic');
  await waitForDashboard();

  expect(screen.queryByRole('heading', { name: 'Spill' })).not.toBeInTheDocument();
  const toggle = stepEvidenceButton(0);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await user.click(toggle);
  expect(await screen.findByRole('heading', { name: 'Spill' })).toBeInTheDocument();
  expect(stepEvidenceButton(0)).toHaveTextContent('Hide evidence');
  expect(stepEvidenceButton(0)).toHaveAttribute('aria-expanded', 'true');
});

test('in Basic view a route to a step\'s folded evidence opens it and lands on its row', async () => {
  renderReady([asLead(spillFinding(90)), spillFinding(1)], [1, 90], 'basic');
  await waitForDashboard();

  await routeFromStageSummary('Investigate spill in Stage 1');

  const trigger = await screen.findByRole('heading', { name: 'Spill' });
  const spillCard = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
  const row = panelRow(spillCard);
  await waitFor(() => expect(document.activeElement).toBe(row));
  // The evidence stays open once the route has completed.
  expect(stepEvidenceButton(1)).toHaveAttribute('aria-expanded', 'true');
});

test('in Basic view a route from Full app report opens the folded evidence it targets', async () => {
  const user = userEvent.setup();
  renderReady([memoryFinding(1)], [1], 'basic');
  await waitForDashboard();

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  await user.click(screen.getByRole('button', { name: 'Investigate memory utilization in Stage 1' }));

  expect(await screen.findByRole('heading', { name: 'Memory Utilization' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true');
  await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
});
