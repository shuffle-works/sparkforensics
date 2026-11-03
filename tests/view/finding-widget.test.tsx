// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { FindingOf } from '@sparkforensics/core/types';
import { emptyAppModel, store } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetModel } from '@/view/finding-widget';
import { BoardLayoutContext } from '@/view/BoardLayoutContext';
import { buildBoardLayout } from '@/view/board-layout';
import { emptySelection } from '@/view/finding-filter';
import { installInterpretation } from './_shared/interpretation';
import { testFinding } from './_shared/finding';

// One test for what every finding widget gets from the shell: title, tag, rows, sort, paging,
// route index and row anchors. A widget's own file tests only its rows.

interface Row extends WidgetRow<'spill'> {
  finding: FindingOf<'spill'>;
  stated: boolean;
}

const rows: RowsOf<'spill', Row> = ({ findings, stated }) => findings.map((finding) => ({ findings: [finding], finding, stated: isStated(finding, stated) }));

const model: FindingWidgetModel<'spill', Row> = {
  type: 'spill',
  rows,
  stageOf: (row) => row.finding.stageId ?? null,
  rowElement: 'li',
};

function RowView({ row }: FindingRowProps<Row>) {
  return <span>{`row ${row.finding.id}`}</span>;
}

const Widget = defineFindingWidget(model, { Row: RowView });

const estimate = (high: number, stageTaskMs: number) => ({ basis: 'serial', wallClock: { low: high, high }, estimateMethod: 'measured', stageTaskMs }) as const;

function spill(stageId: number, savingsMs: number, stageTaskMs = 10 * savingsMs, impactBand: 'critical' | 'warning' = 'warning') {
  return testFinding({ type: 'spill', stageId, impactBand, id: `s${stageId}`, value: 1024, recommendation: 'r', confidence: 'low', impactEstimate: estimate(savingsMs, stageTaskMs) });
}

function layoutOf(findings: FindingOf<'spill'>[]) {
  return buildBoardLayout({ interpretation: null, appModel: emptyAppModel(), catalog: findings, configFindings: [], selection: emptySelection(), density: 'basic' });
}

/** Renders the widget on a board whose active route (if any) lands on `routedFinding`'s row. */
function renderWidget(findings: FindingOf<'spill'>[], routedFinding: FindingOf<'spill'> | null = null) {
  installInterpretation(findings);
  const layout = layoutOf(findings);
  if (routedFinding) store.getState().startRoute({ tab: null, openCards: [], cardKey: null, rowKey: layout.keyOf(routedFinding) });
  return render(
    <DocsProvider>
      <BoardLayoutContext.Provider value={layout}>
        <Widget appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />
      </BoardLayoutContext.Provider>
    </DocsProvider>,
  );
}

const shownRows = () => screen.getAllByText(/^row /).map((node) => node.textContent);

afterEach(() => {
  store.getState().resetModel();
  cleanup();
  store.getState().setWidgetDensity('basic');
});

describe('the finding widget shell', () => {
  it('renders nothing when the rows are empty', () => {
    const { container } = renderWidget([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('titles the card with the finding\'s core name and shows its tag once in the header', () => {
    renderWidget([spill(1, 100), spill(2, 200)]);
    expect(screen.getByRole('heading', { name: 'Spill' })).toBeInTheDocument();
    expect(screen.getAllByText('SPILL')).toHaveLength(1);
  });

  it('lists rows in impact order, and in stage order once Advanced offers the Stage button', async () => {
    const user = userEvent.setup();
    store.getState().setWidgetDensity('advanced');
    // The critical finding with the small saving ranks below the warning with the large one.
    renderWidget([spill(1, 100, 1000, 'critical'), spill(2, 5000, 9000)]);
    expect(shownRows()).toEqual(['row s2', 'row s1']);

    await user.click(screen.getByRole('button', { name: 'Stage' }));
    expect(shownRows()).toEqual(['row s1', 'row s2']);
  });

  it('offers no sort toggle at Basic', () => {
    renderWidget([spill(1, 100), spill(2, 5000)]);
    expect(screen.queryByRole('button', { name: 'Stage' })).not.toBeInTheDocument();
  });

  it('pages six rows at a time', async () => {
    const user = userEvent.setup();
    renderWidget(Array.from({ length: 8 }, (_, i) => spill(i + 1, 1000 - i)));
    expect(shownRows()).toHaveLength(6);

    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(shownRows()).toEqual(['row s7', 'row s8']);
  });

  it('returns to the first page when the run changes', async () => {
    const user = userEvent.setup();
    const findings = Array.from({ length: 8 }, (_, i) => spill(i + 1, 1000 - i));
    const { rerender } = renderWidget(findings);
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(shownRows()).toEqual(['row s7', 'row s8']);

    rerender(
      <DocsProvider>
        <Widget appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />
      </DocsProvider>,
    );
    expect(shownRows()).toHaveLength(6);
  });

  it('opens the page that holds the routed finding', () => {
    const findings = Array.from({ length: 8 }, (_, i) => spill(i + 1, 1000 - i));
    renderWidget(findings, findings[7]);
    expect(shownRows()).toContain('row s8');
  });

  it('keeps the routed page under StrictMode when the route mounts the list', () => {
    const findings = Array.from({ length: 8 }, (_, i) => spill(i + 1, 1000 - i));
    installInterpretation(findings);
    const layout = layoutOf(findings);
    store.getState().startRoute({ tab: null, openCards: [], cardKey: null, rowKey: layout.keyOf(findings[7]) });
    render(
      <StrictMode>
        <DocsProvider>
          <BoardLayoutContext.Provider value={layout}>
            <Widget appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />
          </BoardLayoutContext.Provider>
        </DocsProvider>
      </StrictMode>,
    );
    expect(shownRows()).toEqual(['row s7', 'row s8']);
    expect(screen.getByText('row s8').closest('li')).toHaveFocus();
  });

  it('pages freely once the route has landed, and does not flash the routed row again when it mounts again', async () => {
    const user = userEvent.setup();
    const findings = Array.from({ length: 8 }, (_, i) => spill(i + 1, 1000 - i));
    renderWidget(findings, findings[7]);
    const routedRow = () => screen.getByText('row s8').closest('li');
    expect(routedRow()).toHaveFocus();
    expect(routedRow()).toHaveAttribute('data-flashed', 'true');

    await user.click(screen.getByRole('button', { name: /previous/i }));
    expect(shownRows()).toHaveLength(6);
    expect(shownRows()).not.toContain('row s8');

    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(shownRows()).toEqual(['row s7', 'row s8']);
    expect(routedRow()).toHaveAttribute('data-flashed', 'false');
  });

  it('makes every row a route landing: a route to a row\'s finding focuses the row', () => {
    const findings = [spill(1, 100), spill(2, 200)];
    renderWidget(findings);
    const keyOf = layoutOf(findings).keyOf;
    for (const finding of findings) {
      act(() => store.getState().startRoute({ tab: null, openCards: [], cardKey: null, rowKey: keyOf(finding) }));
      expect(screen.getByText(`row ${finding.id}`).closest('li')).toHaveFocus();
    }
  });
});
