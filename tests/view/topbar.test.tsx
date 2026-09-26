// @vitest-environment jsdom
import { test, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { store, emptyAppModel } from '@/store/store';
import { Topbar } from '@/view/Topbar';

// DocsSheet resizes via react-resizable-panels, which constructs a
// ResizeObserver on mount; jsdom has none (see docs-sheet.test.tsx).
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

beforeEach(() => store.setState({
  ...store.getState(),
  catalog: [],
  configFindings: [],
  appModel: emptyAppModel(),
  skippedLines: 0,
  planGraph: { active: false, stageId: null, initialScope: 'segment' },
  exportMode: false,
}));

function renderTopbar(props: Partial<Parameters<typeof Topbar>[0]> = {}) {
  const onLoadNew = vi.fn();
  const onPickRecent = vi.fn();
  const onRemoveRecent = vi.fn();
  render(
    <ThemeProvider>
      <Topbar
        onLoadNew={onLoadNew}
        recentEntries={[]}
        activeFileId={null}
        onPickRecent={onPickRecent}
        onRemoveRecent={onRemoveRecent}
        {...props}
      />
    </ThemeProvider>,
  );
  return { onLoadNew, onPickRecent, onRemoveRecent };
}

test('stays pinned to the top of the viewport while the page scrolls', () => {
  renderTopbar();
  expect(screen.getByRole('banner')).toHaveClass('sticky', 'top-0');
});

test('renders the app name', () => {
  store.setState({ appModel: { ...emptyAppModel(), app: { name: 'My Spark App' } } });
  renderTopbar();
  expect(screen.getByText('My Spark App')).toBeInTheDocument();
});

test('renders the app id and Spark version subtitle', () => {
  store.setState({ appModel: { ...emptyAppModel(), app: { name: 'My Spark App', id: 'app-1', sparkVersion: '3.5.3' } } });
  renderTopbar();
  expect(screen.getByText('app-1 · Spark 3.5.3')).toBeInTheDocument();
});

test('shows a skipped-lines warning when parsing skipped malformed or invalid data', () => {
  store.setState({ skippedLines: 3 });
  renderTopbar();
  expect(screen.getByText('3 lines skipped: malformed or invalid data')).toBeInTheDocument();
});

test('shows no skipped-lines warning when nothing was skipped', () => {
  renderTopbar();
  expect(screen.queryByText(/lines skipped/i)).not.toBeInTheDocument();
});

test('clicking the theme button flips data-theme', async () => {
  renderTopbar();
  const start = document.documentElement.getAttribute('data-theme');
  await userEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
  expect(document.documentElement.getAttribute('data-theme')).not.toBe(start);
});

test('opens narrow overflow options from the keyboard', async () => {
  renderTopbar();
  const trigger = screen.getByRole('button', { name: 'More options' });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.getByRole('menuitem', { name: 'Toggle theme' })).toBeInTheDocument();
});

test('the narrow overflow menu exposes the evidence-export path', async () => {
  // Below sm: the desktop export cluster is hidden, so the export must be
  // reachable from the overflow menu instead (else no download path on a phone).
  renderTopbar();
  await userEvent.click(screen.getByRole('button', { name: 'More options' }));
  expect(await screen.findByRole('menuitemcheckbox', { name: /redact identifiers/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /download markdown/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /download json/i })).toBeInTheDocument();
});

test('selecting an overflow item closes the menu and restores focus to its trigger', async () => {
  renderTopbar();
  const trigger = screen.getByRole('button', { name: 'More options' });
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Toggle theme' }));
  expect(trigger).toHaveFocus();
});

test('Escape closes the overflow menu and restores focus to its trigger', async () => {
  renderTopbar();
  const trigger = screen.getByRole('button', { name: 'More options' });
  await userEvent.click(trigger);
  expect(await screen.findByRole('menuitem', { name: 'Toggle theme' })).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('menuitem', { name: 'Toggle theme' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test('outside dismissal restores focus to the overflow trigger', async () => {
  renderTopbar();
  const trigger = screen.getByRole('button', { name: 'More options' });
  await userEvent.click(trigger);
  expect(await screen.findByRole('menuitem', { name: 'Toggle theme' })).toBeInTheDocument();
  await userEvent.click(document.body);
  expect(screen.queryByRole('menuitem', { name: 'Toggle theme' })).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
});

test('selecting Toggle theme from the overflow menu changes the document theme', async () => {
  renderTopbar();
  const start = document.documentElement.getAttribute('data-theme');
  await userEvent.click(screen.getByRole('button', { name: 'More options' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Toggle theme' }));
  expect(document.documentElement.getAttribute('data-theme')).not.toBe(start);
});

test('clicking the load-new-file menu item in the file switcher calls onLoadNew', async () => {
  const { onLoadNew } = renderTopbar();
  await userEvent.click(screen.getByRole('button', { name: /spark application/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /load new file/i }));
  expect(onLoadNew).toHaveBeenCalledOnce();
});

test('wires the file switcher to the recent-files list', async () => {
  renderTopbar({
    recentEntries: [
      {
        id: 'a',
        name: 'alpha.ndjson',
        size: 100,
        lastModified: 1,
        appName: 'Distinct Recent App',
        issueCount: null,
        handle: {} as FileSystemFileHandle,
        lastOpenedAt: 1,
      },
    ],
  });
  await userEvent.click(screen.getByRole('button', { name: /spark application/i }));
  expect(await screen.findByText('Distinct Recent App')).toBeInTheDocument();
});

// A run with one finished stage: the checks had something to measure.
const checkedAppModel = () => ({ ...emptyAppModel(), stages: new Map([[1, { id: 1, submittedAt: 0, completedAt: 1_000 }]]) }) as any;

test('shows an all-clear verdict when catalog is empty', () => {
  store.setState({ appModel: checkedAppModel(), configFindings: [] });
  renderTopbar();
  expect(screen.getByText(/no findings/i)).toBeInTheDocument();
});

test('says "Not fully checked" instead of all-clear when the log had nothing to check or lacked evidence', () => {
  store.setState({ configFindings: [] });
  renderTopbar();
  expect(screen.getByText('Not fully checked')).toBeInTheDocument();

  cleanup();
  store.setState({
    appModel: checkedAppModel(),
    catalog: [{ type: 'memoryUtilization', variant: 'memoryBand', stageId: null, impactBand: 'info', dataUnavailable: true, recommendation: 'Enable executor metrics.' }],
  });
  renderTopbar();
  // The caveat is not counted as a finding ("1 info"), and the run is not called clean.
  expect(screen.queryByText(/1 info/)).not.toBeInTheDocument();
  expect(screen.getByText('Not fully checked')).toBeInTheDocument();
});

test('says the run failed when a job failed even with no finding to rank', () => {
  store.setState({
    configFindings: [],
    appModel: { ...checkedAppModel(), jobs: new Map([[1, { id: 1, stageIds: [], result: 'JobFailed', succeeded: false, exception: null }]]) },
  });
  renderTopbar();
  expect(screen.getByText('Run failed')).toBeInTheDocument();
});

test('the count chip jumps to that band of the Findings list', async () => {
  const user = userEvent.setup();
  const onJumpToFindings = vi.fn();
  store.setState({
    appModel: checkedAppModel(),
    configFindings: [],
    catalog: [
      { type: 'skew', stageId: 1, impactBand: 'critical', recommendation: 'Rebalance.' },
      { type: 'spill', stageId: 1, impactBand: 'critical', recommendation: 'Add memory.' },
    ],
  });
  renderTopbar({ onJumpToFindings });
  await user.click(screen.getByRole('button', { name: '2 critical: show them in Findings' }));
  expect(onJumpToFindings).toHaveBeenCalledWith('critical');
});

test('size="sm" secondary buttons carry the comfortable tap-target class', () => {
  // Sub-44px text buttons must opt into .tap-target-comfortable for coarse pointers.
  store.setState({ comparison: { active: false, baselineId: 'a', candidateId: 'b' } });
  renderTopbar();
  expect(screen.getByRole('button', { name: /back to comparison/i })).toHaveClass('tap-target-comfortable');
});

test('verdict pill reflects the worst impactBand in the catalog', () => {
  store.setState({
    catalog: [
      { type: 'gc', stageId: 1, impactBand: 'warning' },
      { type: 'gc', stageId: 2, impactBand: 'warning' },
      { type: 'skew', stageId: 3, impactBand: 'critical' },
    ],
  });
  renderTopbar();
  expect(screen.getByText(/1 critical/i)).toBeInTheDocument();
});

test('shows no Plan graph control when no SQL execution has a plan tree', () => {
  renderTopbar();
  expect(screen.queryByRole('button', { name: 'Plan graph' })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Plan graph' })).not.toBeInTheDocument();
});

test('a single eligible SQL execution renders a plain Plan graph button that opens its anchor stage', async () => {
  const user = userEvent.setup();
  const appModel = emptyAppModel();
  appModel.stages.set(7, { id: 7, sqlExecutionId: 1 } as never);
  appModel.sql.set(1, { executionId: 1, planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] } } as never);
  store.setState({ appModel });

  renderTopbar();
  await user.click(screen.getByRole('button', { name: 'Plan graph' }));

  expect(store.getState().planGraph).toEqual({ active: true, stageId: 7, initialScope: 'full' });
});

test('an execution with no plan tree is excluded even if it has stages', () => {
  const appModel = emptyAppModel();
  appModel.stages.set(7, { id: 7, sqlExecutionId: 1 } as never);
  appModel.sql.set(1, { executionId: 1, planTree: null } as never);
  store.setState({ appModel });

  renderTopbar();
  expect(screen.queryByRole('button', { name: 'Plan graph' })).not.toBeInTheDocument();
});

test('two or more eligible SQL executions render a picker dialog listing each, and picking one opens its anchor stage', async () => {
  const user = userEvent.setup();
  const appModel = emptyAppModel();
  appModel.stages.set(7, { id: 7, sqlExecutionId: 1 } as never);
  appModel.stages.set(9, { id: 9, sqlExecutionId: 2 } as never);
  appModel.sql.set(1, {
    executionId: 1, description: 'SELECT * FROM orders',
    planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] },
  } as never);
  appModel.sql.set(2, { executionId: 2, planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] } } as never);
  store.setState({ appModel });

  renderTopbar();
  await user.click(screen.getByRole('button', { name: 'Plan graph' }));

  expect(screen.getByText('Open plan graph')).toBeInTheDocument();
  expect(screen.getByText('SELECT * FROM orders')).toBeInTheDocument();
  expect(screen.getByText('SQL execution #2')).toBeInTheDocument();

  await user.click(screen.getByText('SELECT * FROM orders'));

  expect(store.getState().planGraph).toEqual({ active: true, stageId: 7, initialScope: 'full' });
  expect(screen.queryByText('Open plan graph')).not.toBeInTheDocument();
});

test('the narrow overflow menu also exposes Plan graph, opening the same picker', async () => {
  const user = userEvent.setup();
  const appModel = emptyAppModel();
  appModel.stages.set(7, { id: 7, sqlExecutionId: 1 } as never);
  appModel.stages.set(9, { id: 9, sqlExecutionId: 2 } as never);
  appModel.sql.set(1, { executionId: 1, planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] } } as never);
  appModel.sql.set(2, { executionId: 2, planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] } } as never);
  store.setState({ appModel });

  renderTopbar();
  await user.click(screen.getByRole('button', { name: 'More options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Plan graph' }));

  expect(screen.getByText('Open plan graph')).toBeInTheDocument();
});

test('sectionControls replaces the impactBand chip and dashboard action cluster, but keeps the theme toggle', () => {
  store.setState({
    catalog: [{ type: 'gc', stageId: 1, impactBand: 'warning' }],
    comparison: { active: false, baselineId: 'a', candidateId: 'b' },
  });
  const appModel = emptyAppModel();
  appModel.stages.set(7, { id: 7, sqlExecutionId: 1 } as never);
  appModel.sql.set(1, { executionId: 1, planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] } } as never);
  store.setState({ appModel });

  renderTopbar({ sectionControls: <span>my-controls</span> });

  expect(screen.getByText('my-controls').parentElement).toHaveClass('max-sm:order-3', 'max-sm:w-full');

  expect(screen.getByText('my-controls')).toBeInTheDocument();
  expect(screen.queryByText(/warning/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/no findings/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /back to comparison/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /redact identifiers/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Plan graph' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Advanced view' })).not.toBeInTheDocument();

  expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
});

test('sectionControls trims the overflow menu to just Toggle theme', async () => {
  const appModel = emptyAppModel();
  appModel.stages.set(7, { id: 7, sqlExecutionId: 1 } as never);
  appModel.sql.set(1, { executionId: 1, planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] } } as never);
  store.setState({ appModel });

  renderTopbar({ sectionControls: <span>my-controls</span> });

  await userEvent.click(screen.getByRole('button', { name: 'More options' }));

  expect(await screen.findByRole('menuitem', { name: 'Toggle theme' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Plan graph' })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitemcheckbox', { name: /redact identifiers/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: /download markdown/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitemcheckbox', { name: 'Advanced view' })).not.toBeInTheDocument();
});

test('the picker sorts entries by impactBand (critical, then warning, then unflagged)', async () => {
  const user = userEvent.setup();
  const appModel = emptyAppModel();
  appModel.stages.set(10, { id: 10, sqlExecutionId: 1 } as never);
  appModel.stages.set(20, { id: 20, sqlExecutionId: 2 } as never);
  appModel.stages.set(30, { id: 30, sqlExecutionId: 3 } as never);
  appModel.sql.set(1, {
    executionId: 1, description: 'Unflagged exec',
    planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] },
  } as never);
  appModel.sql.set(2, {
    executionId: 2, description: 'Warning exec',
    planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] },
  } as never);
  appModel.sql.set(3, {
    executionId: 3, description: 'Critical exec',
    planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] },
  } as never);
  store.setState({
    appModel,
    catalog: [
      { type: 'gc', stageId: 20, impactBand: 'warning' },
      { type: 'skew', stageId: 30, impactBand: 'critical' },
    ],
  });

  renderTopbar();
  await user.click(screen.getByRole('button', { name: 'Plan graph' }));

  const text = document.body.textContent ?? '';
  const criticalIdx = text.indexOf('Critical exec');
  const warningIdx = text.indexOf('Warning exec');
  const unflaggedIdx = text.indexOf('Unflagged exec');
  expect(criticalIdx).toBeGreaterThanOrEqual(0);
  expect(warningIdx).toBeGreaterThan(criticalIdx);
  expect(unflaggedIdx).toBeGreaterThan(warningIdx);
});

test('mobile overflow menu offers the Advanced view toggle', async () => {
  store.getState().setWidgetDensity('basic');
  renderTopbar();
  await userEvent.click(screen.getByRole('button', { name: 'More options' }));
  const item = await screen.findByRole('menuitemcheckbox', { name: 'Advanced view' });
  expect(item).not.toBeChecked();
  await userEvent.click(item);
  expect(store.getState().widgetDensity).toBe('advanced');
  store.getState().setWidgetDensity('basic');
});

test('the picker impactBand and total count aggregate all findings across linked stages, including stageIds-only findings', async () => {
  const appModel = emptyAppModel();
  appModel.stages.set(7, { id: 7, sqlExecutionId: 1 } as never);
  appModel.stages.set(8, { id: 8, sqlExecutionId: 1 } as never);
  appModel.stages.set(9, { id: 9, sqlExecutionId: 2 } as never);
  appModel.sql.set(1, {
    executionId: 1,
    description: 'Linked execution',
    planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] },
  } as never);
  appModel.sql.set(2, { executionId: 2, planTree: { name: 'Scan', detail: 'Scan', metrics: [], children: [] } } as never);
  store.setState({
    appModel,
    catalog: [
      { type: 'gc', stageId: 7, impactBand: 'warning' },
      { type: 'smallFiles', stageId: null, stageIds: [8], impactBand: 'critical' },
    ],
  });

  renderTopbar();

  expect(screen.getByRole('button', { name: 'Plan graph' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Plan graph' }));

  expect(screen.getByText('Open plan graph')).toBeInTheDocument();
  expect(screen.getByText('Linked execution')).toBeInTheDocument();
  expect(screen.getByText('2 findings')).toBeInTheDocument();

  const text = document.body.textContent ?? '';
  expect(text.indexOf('Linked execution')).toBeGreaterThanOrEqual(0);
  expect(text.indexOf('Linked execution')).toBeLessThan(text.indexOf('SQL execution #2'));
});

test('exportMode hides the interactive file switcher but keeps the app identity visible', () => {
  store.setState({ exportMode: true, appModel: { ...emptyAppModel(), app: { name: 'My Spark App' } } });
  renderTopbar();
  expect(screen.getByText('My Spark App')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /My Spark App/i })).not.toBeInTheDocument();
});

test('clicking the keyboard-shortcuts button opens the shortcuts dialog', async () => {
  renderTopbar();
  await userEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
  expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  expect(screen.getByText('Open this list')).toBeInTheDocument();
  // The Advanced-view triage keys are documented, and say where they apply.
  expect(screen.getByRole('heading', { name: 'Triage (Advanced view only)' })).toBeInTheDocument();
  expect(screen.getByText("Next or previous finding, starting with the verdict's steps")).toBeInTheDocument();
});

test('pressing "?" opens the shortcuts dialog', async () => {
  renderTopbar();
  await userEvent.keyboard('?');
  expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
});

test('pressing "?" while typing in a text field does not open the shortcuts dialog', async () => {
  renderTopbar();
  // A stand-in text field: the guard checks the event target's tag, not
  // which specific input it is, so this exercises the same code path as
  // typing "?" into the Type/Stage filter search boxes elsewhere in the app.
  const input = document.createElement('input');
  document.body.appendChild(input);
  await userEvent.type(input, '?');
  expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
  input.remove();
});

test('the narrow overflow menu also opens the shortcuts dialog', async () => {
  renderTopbar();
  await userEvent.click(screen.getByRole('button', { name: 'More options' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Keyboard shortcuts' }));
  expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
});

test('clicking "New analysis" invokes onLoadNew', async () => {
  const { onLoadNew } = renderTopbar();
  await userEvent.click(screen.getByRole('button', { name: 'New analysis' }));
  expect(onLoadNew).toHaveBeenCalledTimes(1);
});

test('sectionControls hides the "New analysis" button', () => {
  renderTopbar({ sectionControls: <span>my-controls</span> });
  expect(screen.queryByRole('button', { name: 'New analysis' })).not.toBeInTheDocument();
});

test('exportMode hides the "New analysis" button', () => {
  store.setState({ exportMode: true });
  renderTopbar();
  expect(screen.queryByRole('button', { name: 'New analysis' })).not.toBeInTheDocument();
});

test('the Docs control links to the docs site in a new tab', () => {
  renderTopbar();
  const docsLink = screen.getByRole('button', { name: 'Docs' });
  expect(docsLink).toHaveAttribute('href', 'docs/');
  expect(docsLink).toHaveAttribute('target', '_blank');
  expect(docsLink).toHaveAttribute('rel', 'noopener noreferrer');
});

test('the narrow overflow menu also offers a Docs link to the docs site', async () => {
  renderTopbar();
  await userEvent.click(screen.getByRole('button', { name: 'More options' }));
  const docsMenuLink = await screen.findByRole('menuitem', { name: 'Docs' });
  expect(docsMenuLink).toHaveAttribute('href', 'docs/');
  expect(docsMenuLink).toHaveAttribute('target', '_blank');
});

test('offers Compare with another run for an open run, and calls onCompare', async () => {
  const user = userEvent.setup();
  const onCompare = vi.fn();
  // Not paused behind "Back to comparison", which hides this action.
  store.setState({
    comparison: { active: false, baselineId: null, candidateId: null },
    appModel: { ...emptyAppModel(), app: { name: 'My Spark App' } },
  });
  renderTopbar({ activeFileId: 'a::1::2', onCompare });
  await user.click(screen.getByRole('button', { name: 'Compare with another run' }));
  expect(onCompare).toHaveBeenCalledOnce();
});

test('has no Compare with another run without an open run', () => {
  renderTopbar({ onCompare: vi.fn() });
  expect(screen.queryByRole('button', { name: 'Compare with another run' })).not.toBeInTheDocument();
});

test('has no Compare with another run for an open run without an application start event', () => {
  store.setState({ comparison: { active: false, baselineId: null, candidateId: null } });
  renderTopbar({ activeFileId: 'a::1::2', onCompare: vi.fn() });
  expect(screen.queryByRole('button', { name: 'Compare with another run' })).not.toBeInTheDocument();
});
