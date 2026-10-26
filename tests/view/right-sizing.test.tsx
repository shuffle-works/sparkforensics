// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel, store } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { RightSizing } from '@/view/widgets/RightSizing';
import type { AppModel, Finding, FindingOf } from '@sparkforensics/core/types.ts';
import { installInterpretation } from './_shared/interpretation';
import { testFinding } from './_shared/finding';

function finding(overrides: Partial<FindingOf<'rightSizing'>> = {}): Finding {
  return testFinding({
    type: 'rightSizing', stageId: null, impactBand: 'warning',
    metric: 'rightSizedCores', value: 8, observedCores: 16,
    observedActiveMs: 10_000, modeledActiveMs: 10_500, modelErrorPct: 12,
    confidence: 'low',
    ...overrides,
  });
}

function renderWidget(catalog: Finding[]) {
  const appModel: AppModel = emptyAppModel();
  installInterpretation(catalog, appModel);
  return render(
    <DocsProvider>
      <RightSizing appModel={appModel} catalog={catalog} getTaskData={() => Promise.reject()} />
    </DocsProvider>,
  );
}

test('summarizes the modeled core count against the cores held at peak, with the UTIL tag', () => {
  renderWidget([finding()]);
  expect(screen.getByRole('heading', { name: 'Right-sized Cluster' })).toBeInTheDocument();
  expect(screen.getByText('8 of 16 cores')).toBeInTheDocument();
  expect(screen.getByText('UTIL')).toBeInTheDocument();
});

test('shows the modeled and observed stage time once expanded, and the model error in Advanced density', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  renderWidget([finding()]);

  await user.click(screen.getByRole('button', { name: 'Right-sized Cluster' }));

  expect(screen.getByText(/Modeled need:/)).toBeInTheDocument();
  expect(screen.getByText(/10.5s modeled at 8 cores, against 10.0s observed/)).toBeInTheDocument();
  expect(screen.getByText(/Model error at the observed core count: 12%/)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('hides the model error at Basic density', async () => {
  const user = userEvent.setup();
  renderWidget([finding()]);

  await user.click(screen.getByRole('button', { name: 'Right-sized Cluster' }));

  expect(screen.getByText(/Modeled need:/)).toBeInTheDocument();
  expect(screen.queryByText(/Model error/)).not.toBeInTheDocument();
});

test('renders nothing when no rightSizing finding is present', () => {
  const { container } = renderWidget([{ type: 'spill', stageId: 1, impactBand: 'warning' }]);
  expect(container).toBeEmptyDOMElement();
});
