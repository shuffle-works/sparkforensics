// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import type { Finding } from '@sparkforensics/core/types';
import { emptyAppModel, store } from '@/store/store';
import { buildBoardLayout, resolveRoute } from '@/view/board-layout';
import { emptySelection } from '@/view/finding-filter';
import { interpretationOf } from '@/view/interpretation';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { installInterpretation } from './_shared/interpretation';
import { TestImpactBoard, TestRunVerdict } from './_shared/board';
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

function board(catalog: Finding[]) {
  const model = appModel();
  installInterpretation(catalog, model as never);
  return <StageDetailProvider><TestImpactBoard appModel={model as never} catalog={catalog} /></StageDetailProvider>;
}

function verdict(catalog: Finding[]) {
  const model = appModel();
  const interpretation = installInterpretation(catalog, model as never);
  return <StageDetailProvider><TestRunVerdict appModel={model as never} catalog={catalog} interpretation={interpretation} withEvidence /></StageDetailProvider>;
}

afterEach(() => {
  store.getState().resetModel();
  store.setState({ widgetDensity: 'basic' });
});

describe('a step or row whose widget has nothing to show beyond it', () => {
  it('a Findings row offers no evidence control, and a route to it lands on the row', () => {
    render(board([coldStart]));

    expect(screen.getByTestId('fix-these-first-row')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /evidence/i })).toBeNull();

    // The route to the row's finding lands on the row's label, in place of an evidence panel.
    const interpretation = interpretationOf(store.getState().run!);
    const layout = buildBoardLayout({
      interpretation: { ...interpretation, data: { ...interpretation.data, verdict: { ...interpretation.data.verdict, steps: [] } } },
      appModel: appModel() as never, catalog: [coldStart], configFindings: [], selection: emptySelection(), density: 'basic',
    });
    const route = resolveRoute({ finding: coldStart } as never, layout);
    expect(route).toMatchObject({ openCards: [], cardKey: null });
    act(() => store.getState().startRoute(route!));
    expect(screen.getByText(/pre-warm/i)).toHaveFocus();
  });

  it('follows the widget density', () => {
    const { rerender } = render(board([rightSizing]));
    expect(screen.queryByRole('button', { name: 'Show evidence' })).toBeNull();

    // The Advanced model error is a row of its own, so the row has evidence to show.
    act(() => store.setState({ widgetDensity: 'advanced' }));
    rerender(board([rightSizing]));
    expect(screen.getByRole('button', { name: 'Show evidence' })).toBeInTheDocument();

    act(() => store.setState({ widgetDensity: 'basic' }));
    expect(screen.queryByRole('button', { name: /evidence/i })).toBeNull();
  });

  it('a verdict step offers no evidence control, and a route to it lands on the step', () => {
    render(verdict([coldStart]));

    expect(screen.queryByRole('button', { name: /evidence/i })).toBeNull();
    const layout = buildBoardLayout({ interpretation: interpretationOf(store.getState().run!), appModel: appModel() as never, catalog: [coldStart], configFindings: [], selection: emptySelection(), density: 'basic' });
    const route = resolveRoute({ finding: coldStart } as never, layout);
    expect(route).toMatchObject({ openCards: [], cardKey: null });
    act(() => store.getState().startRoute(route!));
    expect(screen.getByRole('heading', { level: 3 })).toHaveFocus();
  });

  it('a verdict step with evidence keeps its control', () => {
    // Advanced density gives the finding a row of its own beyond the step line.
    store.setState({ widgetDensity: 'advanced' });
    render(verdict([rightSizing]));
    expect(screen.getByRole('button', { name: 'Show evidence' })).toBeInTheDocument();
  });
});
