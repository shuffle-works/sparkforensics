// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, type ReactElement } from 'react';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { DocsProvider } from '@/view/DocsContext';
import { StageDetailProvider, useStageDetail } from '@/view/StageDetailContext';
import { PlanGraphRoute } from '@/view/PlanGraphRoute';
import { emptyAppModel, store } from '@/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { testFinding } from './_shared/finding';
import { installInterpretation } from './_shared/interpretation';

// Same stubs as plan-graph-route.test.tsx: React Flow renders for real, but its
// viewport calls are inert and jsdom has no ResizeObserver.
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    useReactFlow: () => ({ setCenter: vi.fn(), getNode: vi.fn(), fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn() }),
  };
});
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// A phone layout stacks the graph, which makes xyflow read the zoom off a
// DOMMatrixReadOnly; jsdom has none and a unit matrix is enough.
if (!('DOMMatrixReadOnly' in window)) {
  (window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
    m22 = 1;
  };
}

const STAGE_ID = 7;

function appModel(): AppModel {
  const planTree = { id: 'n0', name: 'SortMergeJoin', detail: 'SortMergeJoin', metrics: [], children: [] };
  const model = emptyAppModel();
  model.stages.set(STAGE_ID, {
    id: STAGE_ID, name: 'sql-scan', sqlExecutionId: 1, submittedAt: 1_000, completedAt: 5_000, taskCount: 0,
  } as never);
  model.sql.set(1, { executionId: 1, planTree, stageIds: [STAGE_ID] } as never);
  return model;
}

const skew = testFinding({
  type: 'skew', stageId: STAGE_ID, impactBand: 'critical', recommendation: 'One task ran 5x the median: salt the join key.',
});
const note = testFinding({ type: 'gc', stageId: STAGE_ID, impactBand: 'info', recommendation: 'Right-size memory: raise executor memory.' });

/** Opens a stage's dialog before the route mounts, as the dashboard does when
 * its "View plan graph" button is used. */
function PreopenedDialog() {
  const { openStage } = useStageDetail();
  useLayoutEffect(() => openStage(STAGE_ID), [openStage]);
  return null;
}

function renderRoute(findings: Finding[] = [skew], { onClose = vi.fn(), preopened = false } = {}) {
  const model = appModel();
  installInterpretation(findings, model);
  const ui: ReactElement = (
    <ThemeProvider>
      <DocsProvider>
        <StageDetailProvider>
          {preopened ? <PreopenedDialog /> : null}
          <PlanGraphRoute stageId={STAGE_ID} appModel={model} findings={findings} activeFileId={null} onClose={onClose} />
        </StageDetailProvider>
      </DocsProvider>
    </ThemeProvider>
  );
  render(ui);
  return { onClose };
}

const chip = () => screen.getByRole('button', { name: 'SKEW' });
const title = () => screen.getByRole('button', { name: `Show the findings for stage ${STAGE_ID}` });
const panel = () => screen.queryByTestId('plan-stage-detail');
const nodeDetail = () => screen.queryByTestId('plan-node-detail');
// `fireEvent` for clicks: userEvent's mousedown reaches React Flow's pane, whose
// d3-drag handler throws on that synthetic event in jsdom.
const click = (el: HTMLElement) => fireEvent.click(el);

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  store.getState().resetModel();
});
beforeEach(() => {
  store.getState().openPlanGraph(STAGE_ID);
});

describe('stage panel in the plan graph', () => {
  test('a finding chip opens the stage panel with the dialog findings block and rings the stage box', () => {
    renderRoute();
    expect(panel()).not.toBeInTheDocument();

    click(chip());

    const open = within(panel()!);
    expect(open.getByRole('heading', { name: 'Stage 7' })).toBeInTheDocument();
    expect(open.getByRole('link', { name: 'SKEW' })).toBeInTheDocument();
    expect(panel()).toHaveTextContent('What to try: salt the join key.');
    expect(screen.getByTestId(`rf__node-stage-${STAGE_ID}`).firstElementChild).toHaveClass('ring-primary');
    expect(screen.queryByTestId('rf__node-segment-0')).not.toBeInTheDocument();
  });

  test('a stage title opens the same panel', () => {
    renderRoute();

    click(title());

    expect(within(panel()!).getByRole('heading', { name: 'Stage 7' })).toBeInTheDocument();
    expect(panel()).toHaveTextContent('1 finding here.');
  });

  test('says how many info notes are hidden, and lists none of them', () => {
    renderRoute([skew, note]);

    click(title());

    expect(panel()).toHaveTextContent('1 finding here. 1 info note hidden.');
    expect(within(panel()!).getAllByTestId('stage-finding')).toHaveLength(1);
    expect(panel()).not.toHaveTextContent('raise executor memory');
  });

  test('the panel and the node detail replace each other', () => {
    renderRoute();

    click(chip());
    click(screen.getByText('SortMergeJoin'));
    expect(nodeDetail()).toBeInTheDocument();
    expect(panel()).not.toBeInTheDocument();

    click(chip());
    expect(panel()).toBeInTheDocument();
    expect(nodeDetail()).not.toBeInTheDocument();
  });

  test('moves focus into the panel and back to the chip on Escape and on the close button', async () => {
    const user = userEvent.setup();
    renderRoute();

    click(chip());
    expect(panel()).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(panel()).not.toBeInTheDocument();
    expect(chip()).toHaveFocus();

    click(title());
    expect(panel()).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Close stage findings' }));
    expect(panel()).not.toBeInTheDocument();
    expect(title()).toHaveFocus();
  });

  test('leaves focus alone when a node the user focused replaces the panel', () => {
    renderRoute();
    click(chip());

    const node = screen.getByText('SortMergeJoin').closest<HTMLElement>('.react-flow__node-planNode')!;
    act(() => node.focus());
    click(node);

    expect(nodeDetail()).toBeInTheDocument();
    expect(chip()).not.toHaveFocus();
  });

  test('Escape closes one level at a time: dialog, panel, node, route', async () => {
    const user = userEvent.setup();
    const { onClose } = renderRoute();

    click(chip());
    click(screen.getByRole('button', { name: 'Open full stage details' }));
    expect(await screen.findByRole('dialog', { name: 'Stage 7' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Stage 7' })).not.toBeInTheDocument();
    expect(panel()).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(panel()).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    click(screen.getByText('SortMergeJoin'));
    await user.keyboard('{Escape}');
    expect(nodeDetail()).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('"Open full stage details" opens the existing dialog without its own plan graph button', async () => {
    renderRoute();
    click(chip());

    click(screen.getByRole('button', { name: 'Open full stage details' }));

    const dialog = await screen.findByRole('dialog', { name: 'Stage 7' });
    expect(within(dialog).getByText(/sql-scan/)).toBeInTheDocument();
    click(within(dialog).getByRole('button', { name: /query plan/i }));
    expect(await within(dialog).findByRole('tab', { name: 'Tree' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'View plan graph' })).not.toBeInTheDocument();
  });

  test('a dialog left open on the dashboard does not pop up over the graph', async () => {
    renderRoute([skew], { preopened: true });

    await act(async () => {});

    expect(screen.queryByRole('dialog', { name: 'Stage 7' })).not.toBeInTheDocument();
  });

  test.each([
    ['a phone shows a bottom sheet with a grabber', true, 'sheet'],
    ['a desktop shows a docked panel', false, 'dock'],
  ])('%s', (_name, phone, variant) => {
    window.matchMedia = ((query: string) => ({
      matches: phone && query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    renderRoute();

    click(chip());

    expect(panel()).toHaveAttribute('data-variant', variant);
    expect(screen.queryByTestId('plan-graph-inspector-grabber') !== null).toBe(phone);
  });
});
