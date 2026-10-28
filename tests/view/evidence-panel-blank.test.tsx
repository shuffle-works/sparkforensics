// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { Finding, TaskData } from '@sparkforensics/core/types.ts';

import { emptyAppModel, store } from '@/store/store';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { TriageNavigationProvider, type WidgetRegistration } from '@/view/TriageNavigationContext';
import { ImpactBoard } from '@/view/widgets/ImpactBoard';
import { RunVerdict } from '@/view/widgets/RunVerdict';
import { installInterpretation } from './_shared/interpretation';
import { allRowsPanel } from './_shared/evidence-panel';
import { testFinding } from './_shared/finding';

const appModel = () => ({ ...emptyAppModel(), app: { startTime: 0, endTime: 60_000 } });

const coldStart = testFinding({
  type: 'coldStart', id: 'cold-1', impactBand: 'warning', value: 43,
  recommendation: 'Keep a warm pool of idle executors.',
  impactEstimate: { basis: 'serial', wallClock: { low: 40_000, high: 43_000 }, estimateMethod: 'measured' },
});
// Its row is the model error only, shown in Advanced density.
const rightSizing = testFinding({
  type: 'rightSizing', id: 'size-1', impactBand: 'info', value: 8, observedCores: 16,
  observedActiveMs: 4_000, modeledActiveMs: 4_100, modelErrorPct: 2.5,
  recommendation: 'The run needs 8 cores.',
  impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 1_800_000, unit: 'coreMs' } },
});

// Records what each evidence-less step or row registers, and what a route asks of it.
function renderWithNavigation(ui: React.ReactNode) {
  const registrations: Array<{ widgetId: string; registration: WidgetRegistration }> = [];
  const reportWidgetOpen = vi.fn();
  render(
    <StageDetailProvider>
      <TriageNavigationProvider
        registerWidget={(widgetId, registration) => {
          registrations.push({ widgetId, registration });
          return () => {};
        }}
        registerFindingAnchor={() => () => {}}
        reportWidgetOpen={reportWidgetOpen}
        clearRouteFocus={() => {}}
        focusedCardKey={null}
        activeRouteTarget={null}
        flashedFinding={null}
      >
        {ui}
      </TriageNavigationProvider>
    </StageDetailProvider>,
  );
  return { registrations, reportWidgetOpen };
}

function board(catalog: Finding[]) {
  const model = appModel();
  installInterpretation(catalog, model as never);
  return (
    <ImpactBoard
      appModel={model as never}
      catalog={catalog}
      configFindings={[]}
      stages={model.stages as never}
      getTaskData={async () => ({ taskEvents: [] }) as unknown as TaskData}
      onRoute={vi.fn()}
    />
  );
}

afterEach(() => store.setState({ widgetDensity: 'basic' }));

describe('a step or row whose widget has nothing to show beyond it', () => {
  it('a Findings row offers no evidence control, and a route to it lands on the row', () => {
    const { registrations, reportWidgetOpen } = renderWithNavigation(board([coldStart]));

    expect(screen.getByTestId('fix-these-first-row')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /evidence/i })).toBeNull();

    // The row registers as the route target of its finding, in place of an evidence panel.
    const landing = registrations.find((entry) => entry.widgetId === 'cold-start')!.registration;
    expect(landing.holds?.(coldStart)).toBe(true);
    expect(landing.wrapperElement).toBe(screen.getByTestId('fix-these-first-row'));
    act(() => landing.open());
    expect(reportWidgetOpen).toHaveBeenCalledWith('cold-start', true);
    // The route focuses the row's label.
    expect(landing.getDisclosureButton()).toHaveTextContent(/pre-warm/i);
  });

  it('follows the widget density', () => {
    const { rerender } = render(<StageDetailProvider>{board([rightSizing])}</StageDetailProvider>);
    expect(screen.queryByRole('button', { name: 'Show evidence' })).toBeNull();

    // The Advanced model error is a row of its own, so the row has evidence to show.
    act(() => store.setState({ widgetDensity: 'advanced' }));
    rerender(<StageDetailProvider>{board([rightSizing])}</StageDetailProvider>);
    expect(screen.getByRole('button', { name: 'Show evidence' })).toBeInTheDocument();

    act(() => store.setState({ widgetDensity: 'basic' }));
    expect(screen.queryByRole('button', { name: /evidence/i })).toBeNull();
  });

  it('a verdict step offers no evidence control, and a route to it lands on the step', () => {
    const interpretation = installInterpretation([coldStart], appModel() as never);
    const { registrations, reportWidgetOpen } = renderWithNavigation(
      <RunVerdict
        interpretation={interpretation}
        onRoute={vi.fn()}
        onShowMoreFindings={vi.fn()}
        evidenceOwners={new Map([[0, 'cold-start']])}
        evidencePanel={() => null}
        renderEvidence={() => <p>card</p>}
      />,
    );

    expect(screen.queryByRole('button', { name: /evidence/i })).toBeNull();
    expect(screen.queryByText('card')).toBeNull();
    const landing = registrations.find((entry) => entry.widgetId === 'cold-start')!.registration;
    expect(landing.holds?.(coldStart)).toBe(true);
    expect(landing.wrapperElement).toBe(screen.getByTestId('next-step'));
    act(() => landing.open());
    expect(reportWidgetOpen).toHaveBeenCalledWith('cold-start', true);
    expect(landing.getDisclosureButton()).toBe(screen.getByRole('heading', { level: 3 }));
  });

  it('a verdict step with evidence keeps its control', () => {
    const interpretation = installInterpretation([coldStart], appModel() as never);
    renderWithNavigation(
      <RunVerdict
        interpretation={interpretation}
        onRoute={vi.fn()}
        onShowMoreFindings={vi.fn()}
        evidenceOwners={new Map([[0, 'cold-start']])}
        evidencePanel={() => allRowsPanel('coldStart', [coldStart])}
        renderEvidence={() => <p>card</p>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Show evidence' })).toBeInTheDocument();
  });
});
