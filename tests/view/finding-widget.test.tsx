// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

import type { FindingOf } from '@sparkforensics/core/types.ts';
import { emptyAppModel, store } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetModel } from '@/view/finding-widget';
import { TriageNavigationProvider } from '@/view/TriageNavigationContext';
import type { TriageTarget } from '@/view/triage-target';
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

function renderWidget(findings: FindingOf<'spill'>[], target: TriageTarget | null = null, registerFindingAnchor: (finding: unknown) => () => void = vi.fn(() => vi.fn())) {
  installInterpretation(findings);
  const wrap = (children: ReactNode) => (
    <DocsProvider>
      <TriageNavigationProvider
        registerWidget={vi.fn(() => vi.fn())}
        registerFindingAnchor={registerFindingAnchor}
        reportWidgetOpen={vi.fn()}
        clearRouteFocus={vi.fn()}
        focusedCardKey={null}
        activeRouteTarget={target}
        flashedFinding={null}
      >
        {children}
      </TriageNavigationProvider>
    </DocsProvider>
  );
  return render(wrap(<Widget appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />));
}

const shownRows = () => screen.getAllByText(/^row /).map((node) => node.textContent);

afterEach(() => {
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
    renderWidget(findings, { widgetId: 'spill', finding: findings[7] } as TriageTarget);
    expect(shownRows()).toContain('row s8');
  });

  it('registers every row\'s findings as route anchors', () => {
    const register = vi.fn((_finding: unknown) => vi.fn());
    const findings = [spill(1, 100), spill(2, 200)];
    renderWidget(findings, null, register);
    const registered = register.mock.calls.map(([finding]) => finding);
    expect(registered).toEqual(expect.arrayContaining(findings));
  });
});
