// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StrictMode } from 'react';

import App from '@/App';
import { emptyAppModel, store } from '@/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types';
import { testFinding } from './_shared/finding';
import { runState } from './_shared/run';

// App-level smoke tests of routing: a route from a control lands on the right element of the real
// board. What a route resolves to is decided as data and tested without rendering in
// board-layout.test.ts; every example finding of every docs run is routed and focused in
// route-focus.test.tsx; a row's page, focus and flash are tested in finding-widget.test.tsx and
// finding-anchor.test.tsx. These keep the wiring between the controls, the store and the board.

vi.mock('@core-src/recent-files.ts', () => ({
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
    metric: 'P95/median',
    value: 5,
    recommendation: `Rebalance Stage ${stageId}.`,
  };
}

// `stageId` defaults to `null` to match the real memoryUtilization detector
// (app-level). A few tests pass an explicit `stageId` to get a genuine
// StageTable route button, the only click-through into a reference-region finding.
function memoryFinding(stageId: number | null = null): Finding {
  return testFinding({
    type: 'memoryUtilization',
    stageId,
    impactBand: 'warning',
    variant: 'idleCores',
    value: 0.7,
    // The measurement a stated row's evidence panel keeps beside the line that states the figure.
    allocatedMBSeconds: 3_600_000,
    recommendation: 'Review executor allocation.',
  });
}

function renderReady(catalog: Finding[], stageIds: number[] = [], widgetDensity: 'basic' | 'advanced' = 'advanced') {
  store.setState({
    status: 'ready',
    ...runState({ appModel: readyAppModel(stageIds), catalog }, 'file-a'),
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

/** Three findings of other types, each on its own stage with the biggest saving: they fill the verdict's steps. */
function stepLeads(): Finding[] {
  return [asLead(spillFinding(41)), asLead(skewFinding(42, 'critical')), asLead(testFinding({ type: 'shuffle', stageId: 43, impactBand: 'critical', value: 100, recommendation: 'Reduce shuffle in Stage 43.' }))];
}

async function waitForDashboard() {
  return screen.findByRole('tab', { name: 'Findings' });
}

beforeEach(() => {
  // These tests list info findings too.
  window.history.replaceState({}, '', '/?impact=critical,warning,info');
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
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
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: originalScrollIntoView });
  window.matchMedia = originalMatchMedia;
  store.setState({ widgetDensity: 'basic' });
});

test('routes a Reference-region target from Stage Summary: expanding its exact card, scrolling, and focusing its disclosure', async () => {
  // memoryUtilization is reference-region only, so Stage Summary is its click-through source.
  // Its destination, Memory Utilization, lives in the Findings tab, so routing switches back
  // there and Full app report ends up unselected again.
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  const user = userEvent.setup();
  renderReady([...stepLeads(), memoryFinding(1)], [1, 41, 42, 43]);

  await waitForDashboard();
  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  await user.click(screen.getByRole('button', { name: 'Investigate memory utilization in Stage 1' }));

  await screen.findByRole('heading', { name: 'Memory Utilization' });
  expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Full app report' })).toHaveAttribute('aria-selected', 'false');
  expect(screen.getByRole('button', { name: /clean checks/i })).toHaveAttribute('aria-expanded', 'false');
  const row = screen.getByText('Idle cores').closest('[data-flashed]');
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(row).toHaveAttribute('data-flashed', 'true');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  });
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

test('Strict Mode registration probing preserves a Reference route through committed open', async () => {
  // The destination (Memory Utilization) lives in the Findings tab.
  const user = userEvent.setup();
  store.setState({
    status: 'ready',
    ...runState({ appModel: readyAppModel([1, 41, 42, 43]), catalog: [...stepLeads(), memoryFinding(1)] }, 'file-a'),
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

test('a route opens only the exact panel of its finding and leaves the other panels and Clean checks closed', async () => {
  renderReady([...stepLeads(), spillFinding(1, 'warning'), skewFinding(2, 'warning')], [1, 2, 41, 42, 43]);

  await waitForDashboard();
  await routeFromStageSummary('Investigate spill in Stage 1');

  // The row of Stage 1 opened its own panel and the route landed on the finding's row inside it.
  const trigger = await screen.findByRole('heading', { name: 'Spill' });
  const card = trigger.closest<HTMLElement>('[data-testid^="widget-grid-item-alert-"]') as HTMLElement;
  const row = panelRow(card);
  await waitFor(() => expect(document.activeElement).toBe(row));
  // The other row's panel stays closed.
  expect(screen.queryByRole('heading', { name: 'Task Skew' })).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('button', { name: /clean checks/i })).toHaveAttribute('aria-expanded', 'false');
});

test('a route to a verdict step\'s evidence opens it and leaves the selected tab alone', async () => {
  renderReady([asLead(spillFinding(90)), spillFinding(1)], [1, 90]);

  await waitForDashboard();
  await routeFromStageSummary('Investigate spill in Stage 1');

  // Only the second step's panel holds the routed finding; the lead step's stays closed.
  const trigger = await screen.findByRole('heading', { name: 'Spill' });
  expect(stepPanelHeading(1, 'Spill')).toBe(trigger);
  expect(stepEvidenceButton(0)).toHaveAttribute('aria-expanded', 'false');
  const row = panelRow(trigger.closest('section') as HTMLElement);
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(screen.getByRole('tab', { name: 'Full app report' })).toHaveAttribute('aria-selected', 'true');
});

test('a core-locality target switches to Full app report, where its always-mounted card lives, and focuses it', async () => {
  const user = userEvent.setup();
  const locality: Finding = testFinding({ type: 'coreLocality', stageId: null, impactBand: 'warning', value: 40, nonLocalTaskCount: 0, recommendation: 'Check locality.' });
  renderReady([locality], [1]);

  await waitForDashboard();
  await user.click(stepEvidenceButton(0));

  expect(screen.getByRole('tab', { name: 'Full app report' })).toHaveAttribute('aria-selected', 'true');
  const reportPanel = screen.getByRole('tabpanel', { name: 'Full app report' });
  const heading = await within(reportPanel).findByRole('heading', { name: 'Core Locality' });
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
  expect(await screen.findByRole('heading', { name: 'Spill' })).toBeInTheDocument();
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
  renderReady([...stepLeads(), memoryFinding(1)], [1, 41, 42, 43]);

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
  renderReady([...stepLeads(), memoryFinding(1)], [1, 41, 42, 43], 'basic');
  await waitForDashboard();

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  await user.click(screen.getByRole('button', { name: 'Investigate memory utilization in Stage 1' }));

  expect(await screen.findByRole('heading', { name: 'Memory Utilization' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true');
  await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
});