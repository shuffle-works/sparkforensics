// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { emptyAppModel, store } from '@/store/store';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { buildNextSteps, locationKey, prioritizeIdleCapacity, verdictIdlePct } from '@/view/run-verdict';
import { RunVerdict } from '@/view/widgets/RunVerdict';
import type { AppModel, Finding, ImpactBand } from '@sparkforensics/core/types.ts';

function timed(type: string, stageId: number, highMs: number, impactBand: ImpactBand = 'critical'): Finding {
  return {
    type,
    impactBand,
    stageId,
    recommendation: `Fix ${type} in Stage ${stageId}.`,
    impactEstimate: { basis: 'serial', wallClock: { low: highMs, high: highMs }, estimateMethod: 'modeled' },
  };
}

function appModel(): AppModel {
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 20_000 },
    stages: new Map([[7, { id: 7, submittedAt: 0, completedAt: 15_000 }]]),
  } as AppModel;
}

function renderVerdict(catalog: Finding[], onRoute = vi.fn(), model: AppModel = appModel()) {
  render(
    <StageDetailProvider>
      <RunVerdict appModel={model} catalog={catalog} onRoute={onRoute} />
    </StageDetailProvider>,
  );
  return onRoute;
}

afterEach(() => {
  // @ts-expect-error -- restore jsdom's default (no Clipboard API) between tests
  delete navigator.clipboard;
});

describe('buildNextSteps', () => {
  it('folds findings that share a stage into one step led by the biggest win, one related entry per type', () => {
    const skew = timed('skew', 7, 2_400);
    const straggler = timed('straggler', 7, 2_300);
    const secondStraggler = { ...timed('straggler', 7, 100), recommendation: 'Another straggler.' };
    const spill = timed('spill', 3, 1_000, 'warning');

    const steps = buildNextSteps([spill, straggler, secondStraggler, skew]);

    expect(steps.map((step) => step.key)).toEqual(['stage:7', 'stage:3']);
    expect(steps[0].lead.finding).toBe(skew);
    expect(steps[0].related).toEqual([straggler]);
    expect(steps[0].stageId).toBe(7);
    expect(steps[1].related).toEqual([]);
  });

  it('keeps app-level findings of different types, and multi-stage plan findings, as separate places', () => {
    expect(locationKey({ type: 'utilization', impactBand: 'info', stageId: null }).key).toBe('app:utilization');
    expect(locationKey({ type: 'smallFiles', impactBand: 'info', stageIds: [4] })).toEqual({ key: 'stage:4', stageId: 4 });
    expect(locationKey({ type: 'duplicatePlanSubtree', impactBand: 'info', stageIds: [2, 0] }))
      .toEqual({ key: 'stages:duplicatePlanSubtree:0,2', stageId: null });
    expect(locationKey({ type: 'memoryUtilization', variant: 'idleCores', impactBand: 'warning', stageId: null }).key)
      .toBe('app:memoryUtilization:idleCores');
  });
});

describe('prioritizeIdleCapacity', () => {
  const idleCores: Finding = {
    type: 'memoryUtilization', variant: 'idleCores', stageId: null, impactBand: 'warning',
    recommendation: '92% of allocated core-time ran no task: reduce cluster size or enable dynamic allocation.',
  };
  const steps = () => buildNextSteps([timed('skew', 0, 64), idleCores]);

  it('leads with idle capacity when it is the dominant story (>= 70%)', () => {
    expect(prioritizeIdleCapacity(steps(), 92, 3_100)[0].lead.finding).toBe(idleCores);
  });

  it('leads with idle capacity at >= 40% only while the best time-based fix is under 5% of the run', () => {
    expect(prioritizeIdleCapacity(steps(), 50, 3_100)[0].lead.finding).toBe(idleCores);
    // 64ms of a 1s run is 6.4%: the time-based fix keeps the lead.
    expect(prioritizeIdleCapacity(steps(), 50, 1_000)[0].lead.finding.type).toBe('skew');
  });

  it('never promotes a heap-pressure memoryUtilization finding as idle capacity, and keeps idleCores as its own step', () => {
    const heapNearCapacity: Finding = {
      type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapNearCapacity', stageId: null, impactBand: 'warning',
      recommendation: 'Raise spark.executor.memory to avoid OOM.',
    };
    const withHeap = buildNextSteps([timed('skew', 0, 64), heapNearCapacity]);
    expect(prioritizeIdleCapacity(withHeap, 92, 3_100)[0].lead.finding.type).toBe('skew');

    const both = buildNextSteps([timed('skew', 0, 64), heapNearCapacity, { ...idleCores, impactBand: 'info' }]);
    expect(both.map((step) => step.key)).toContain('app:memoryUtilization:idleCores');
    expect(prioritizeIdleCapacity(both, 92, 3_100)[0].lead.finding.variant).toBe('idleCores');
  });

  it('states the idle share the idle-capacity step itself reports, falling back to the Scorecard figure', () => {
    expect(verdictIdlePct(steps(), 80)).toBe(80);
    expect(verdictIdlePct(buildNextSteps([timed('skew', 0, 64), { ...idleCores, value: 55 }]), 80)).toBe(55);
    const utilization: Finding = { type: 'utilization', stageId: null, impactBand: 'info', value: 30, recommendation: 'x' };
    expect(verdictIdlePct(buildNextSteps([utilization]), 80)).toBe(70);
    expect(verdictIdlePct(buildNextSteps([timed('skew', 0, 64)]), 80)).toBe(80);
  });

  it('keeps the savings order below 40% idle, or when no idle-capacity step exists', () => {
    expect(prioritizeIdleCapacity(steps(), 30, 3_100)[0].lead.finding.type).toBe('skew');
    const noIdle = buildNextSteps([timed('skew', 0, 64), timed('spill', 1, 32)]);
    expect(prioritizeIdleCapacity(noIdle, 95, 3_100)).toEqual(noIdle);
  });
});

describe('RunVerdict', () => {
  it('leads with the stage to start in, what it could save, and why grouped findings do not add up', () => {
    renderVerdict([timed('skew', 7, 2_400), timed('straggler', 7, 2_300), timed('spill', 3, 1_000, 'warning')]);

    expect(screen.getByRole('heading', { level: 2, name: 'Start with Stage 7' })).toBeInTheDocument();
    const verdict = screen.getByTestId('run-verdict');
    expect(verdict).toHaveTextContent('3 findings in 2 places.');
    expect(verdict).toHaveTextContent('The first fix could save up to 2.4s of this 20.0s run.');
    expect(verdict).toHaveTextContent('their savings overlap rather than add up');

    const steps = within(screen.getByRole('list', { name: 'Next steps' })).getAllByTestId('next-step');
    expect(steps).toHaveLength(2);
    // Plain-language explanation first, then the detector's concrete fix.
    expect(steps[0]).toHaveTextContent("What's happening: A small number of tasks take much longer than their peers.");
    expect(steps[0]).toHaveTextContent('What to try: Fix skew in Stage 7.');
    expect(steps[0]).toHaveTextContent('Also flagged here:');
  });

  it('routes a step to its evidence and opens the stage from its own control', async () => {
    const user = userEvent.setup();
    const skew = timed('skew', 7, 2_400);
    const onRoute = renderVerdict([skew]);

    await user.click(screen.getByRole('button', { name: /show evidence/i }));
    expect(onRoute).toHaveBeenCalledTimes(1);
    expect(onRoute.mock.calls[0][0]).toMatchObject({ finding: skew, widgetId: 'skew' });

    await user.click(screen.getByRole('button', { name: 'Stage 7 details' }));
    expect(onRoute).toHaveBeenCalledTimes(1);
  });

  it('lists at most three places and counts the rest', () => {
    renderVerdict([1, 2, 3, 4, 5].map((stageId) => timed('spill', stageId, stageId * 100, 'warning')));
    expect(screen.getAllByTestId('next-step')).toHaveLength(3);
    expect(screen.getByText('2 more places to look at in the full list under Findings.')).toBeInTheDocument();
  });

  it('copies a step summary and confirms it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderVerdict([timed('spill', 4, 12_000)]);

    const copyButton = screen.getByTestId('copy-finding-button');
    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith('Reduce spill: Fix spill in Stage 4. Potential savings: 12.0s');
    expect(copyButton).toHaveTextContent('Copied');
    await waitFor(() => expect(copyButton).toHaveTextContent('Copy'), { timeout: 3000 });
  });

  it('titles an idle-capacity lead with the idle share its own step reports', () => {
    renderVerdict([timed('skew', 7, 64), {
      type: 'memoryUtilization', variant: 'idleCores', stageId: null, impactBand: 'warning', value: 92,
      recommendation: '92% of allocated core-time ran no task: reduce cluster size or enable dynamic allocation.',
    }]);
    expect(screen.getByRole('heading', { level: 2, name: 'Start with cluster size: 92% of executor capacity sat idle' }))
      .toBeInTheDocument();
  });

  it('titles a heap-pressure lead by its own fix, not by cluster size', () => {
    renderVerdict([{
      type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapNearCapacity', stageId: null, impactBand: 'warning',
      recommendation: 'Raise spark.executor.memory to avoid OOM.',
    }]);
    expect(screen.getByRole('heading', { level: 2 })).not.toHaveTextContent(/cluster size/i);
    expect(screen.getByTestId('run-verdict')).not.toHaveTextContent('idle cores');
  });

  it('never calls an incomplete run clean, and says what the figures cover', () => {
    const incompleteRun: Finding = { type: 'incompleteRun', stageId: null, impactBand: 'warning', recommendation: 'No ApplicationEnd.' };
    const model = { ...appModel(), app: { startTime: 0 } } as AppModel;
    renderVerdict([incompleteRun], vi.fn(), model);

    expect(screen.getByRole('heading', { level: 2, name: 'This log looks incomplete, so results cover only part of the run' }))
      .toBeInTheDocument();
    const verdict = screen.getByTestId('run-verdict');
    expect(verdict).not.toHaveTextContent('Every check passed');
    expect(verdict).toHaveTextContent('cover only the part of the run it captured');
    // No clean-run check icon in the title.
    expect(screen.getByRole('heading', { level: 2 }).querySelector('svg')).toBeNull();
  });

  it('flags an incomplete run alongside its next steps', () => {
    const incompleteRun: Finding = { type: 'incompleteRun', stageId: null, impactBand: 'warning', recommendation: 'No ApplicationEnd.' };
    renderVerdict([timed('skew', 7, 2_400), incompleteRun]);
    expect(screen.getByRole('heading', { level: 2, name: 'Start with Stage 7' })).toBeInTheDocument();
    expect(screen.getByTestId('run-verdict')).toHaveTextContent('cover only the part of the run it captured');
  });

  it('does not call a run clean when only evidence caveats were found', () => {
    renderVerdict([{
      type: 'cacheUtilization', variant: 'storageUnobserved', stageId: null, impactBand: 'info', dataUnavailable: true,
      recommendation: 'Enable block updates.',
    }]);
    expect(screen.getByRole('heading', { level: 2, name: 'Nothing to fix, but some checks could not run on this log' }))
      .toBeInTheDocument();
    expect(screen.getByTestId('run-verdict')).not.toHaveTextContent('Every check passed');
  });

  it('says a clean run is clean', () => {
    renderVerdict([]);
    expect(screen.getByRole('heading', { level: 2, name: 'No findings to fix right now.' })).toBeInTheDocument();
    expect(screen.getByTestId('run-verdict')).toHaveTextContent('Every check passed for this run.');
    expect(screen.queryByRole('list', { name: 'Next steps' })).not.toBeInTheDocument();
  });

  it('offers a collapsed newcomer primer in Basic view only', async () => {
    const user = userEvent.setup();
    renderVerdict([timed('skew', 7, 2_400)]);
    const toggle = screen.getByRole('button', { name: /new to spark tuning\? how to read this report/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByText(/Spark splits each job into stages/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'What every finding means' }))
      .toHaveAttribute('href', 'docs/user-guide/understanding-findings.html');
  });

  it('drops the newcomer primer in Advanced view', () => {
    store.getState().setWidgetDensity('advanced');
    try {
      renderVerdict([timed('skew', 7, 2_400)]);
      expect(screen.queryByRole('button', { name: /new to spark tuning/i })).not.toBeInTheDocument();
    } finally {
      store.getState().setWidgetDensity('basic');
    }
  });
});
