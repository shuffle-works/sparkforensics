// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { emptyAppModel, store } from '@/store/store';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { buildNextSteps, estimateProvenance, gapSettings, locationKey, prioritizeIdleCapacity, savingsMeaning, sparkSubmitFlags, verdictIdlePct } from '@/view/run-verdict';
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
    expect(writeText).toHaveBeenCalledWith('Reduce spill: Fix spill in Stage 4. Potential savings: 12.0s of run time');
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

  it('states a non-leading idle-capacity step as idle executor capacity', () => {
    renderVerdict([timed('skew', 7, 2_400), {
      type: 'memoryUtilization', variant: 'idleCores', stageId: null, impactBand: 'info', value: 50,
      recommendation: '50% of allocated core-time ran no task: reduce cluster size or enable dynamic allocation.',
    }]);
    expect(screen.getByRole('heading', { level: 2, name: 'Start with Stage 7' })).toBeInTheDocument();
    const verdict = screen.getByTestId('run-verdict');
    expect(verdict).toHaveTextContent('50% of the executor capacity sat idle, so the cluster may be larger than this job needs.');
    expect(verdict).not.toHaveTextContent('went unused');
  });

  it('states the Scorecard figure as unused core time when no idle-capacity step exists', () => {
    const model = {
      ...appModel(),
      app: { startTime: 0, endTime: 20_000, resources: { executor: { cores: 2 } } },
      executors: { added: [{ kind: 'added', executorId: '1', timestamp: 0, host: 'host-1', totalCores: 2, resourceProfileId: null }], removed: [] },
      runAggregates: { busyCoreMs: 10, perStage: { 7: { totalTaskDurationSum: 10, taskCount: 1 } } },
    } as unknown as AppModel;
    renderVerdict([timed('skew', 7, 2_400)], vi.fn(), model);
    const verdict = screen.getByTestId('run-verdict');
    expect(verdict).toHaveTextContent(/\d+% of the run's core time went unused, so the cluster may be larger than this job needs\./);
    expect(verdict).not.toHaveTextContent('sat idle');
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
    expect(verdict).toHaveTextContent('core usage, memory and executor churn checks had no run length to measure');
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

describe('RunVerdict on a failed run', () => {
  type JobRow = { id: number; stageIds: number[]; result: string | null; succeeded: boolean | null; exception: unknown };
  function withJobs(jobs: JobRow[]): AppModel {
    const model = appModel();
    return {
      ...model,
      jobs: new Map(jobs.map((job) => [job.id, { submissionTime: 0, sqlExecutionId: null, completionTime: 1, ...job }])),
    } as AppModel;
  }
  const failedJob = (id: number, stageIds: number[], exception: unknown = null): JobRow => ({
    id, stageIds, result: 'JobFailed', succeeded: false, exception,
  });
  const okJob = (id: number): JobRow => ({ id, stageIds: [], result: 'JobSucceeded', succeeded: true, exception: null });
  const stageFailed = (stageId: number, reason: string): Finding => ({
    type: 'stageFailed', stageId, impactBand: 'critical', metric: 'stageFailureReason', value: reason,
    recommendation: 'This stage attempt failed outright.',
  });

  it('says the run failed, quotes Spark\'s reason for the failed job\'s stage, and puts the failure ahead of bigger savings', () => {
    renderVerdict(
      [timed('skew', 7, 9_000), stageFailed(4, 'Unrelated retry'), stageFailed(13, 'Fetch failed: executor lost\n\tat Frame.run')],
      vi.fn(),
      withJobs([failedJob(1, [13])]),
    );

    expect(screen.getByRole('heading', { level: 2, name: 'This run failed: its job did not finish' })).toBeInTheDocument();
    expect(screen.getByTestId('run-failure-reason')).toHaveTextContent("Spark's recorded reason: Fetch failed: executor lost");
    expect(screen.getByTestId('run-failure-reason')).not.toHaveTextContent('Frame.run');
    const verdict = screen.getByTestId('run-verdict');
    expect(verdict).toHaveTextContent('Fix the failure before tuning: the other findings cover only the work that ran.');
    expect(verdict).not.toHaveTextContent('The first fix could save');
    const steps = within(screen.getByRole('list', { name: 'Next steps' })).getAllByTestId('next-step');
    expect(steps[0]).toHaveTextContent('Inspect stage failure in Stage 13');
  });

  it('points the failure step at the quoted reason instead of the driver log, in the step and its copied text', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const failure = { ...stageFailed(13, 'Fetch failed: executor lost'), recommendation: 'Inspect the driver log for the failure reason.' };
    renderVerdict([failure], vi.fn(), withJobs([failedJob(1, [13])]));

    const step = within(screen.getByRole('list', { name: 'Next steps' })).getAllByTestId('next-step')[0];
    const pointer = "Spark's recorded reason is quoted above. Open the driver log only if you need the full stack trace.";
    expect(step).toHaveTextContent(`What to try: ${pointer}`);
    expect(step).not.toHaveTextContent('Inspect the driver log for the failure reason.');
    await user.click(within(step).getByTestId('copy-finding-button'));
    expect(writeText).toHaveBeenCalledWith(
      "Inspect stage failure: Spark's recorded reason: Fetch failed: executor lost. Open the driver log only if you need the full stack trace.",
    );
  });

  it('points only the step whose reason is quoted at it; another failed stage keeps its own advice', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const advice = 'Inspect the driver log for the failure reason.';
    renderVerdict(
      [
        { ...stageFailed(3, 'FetchFailed: shuffle lost'), recommendation: advice },
        { ...stageFailed(9, 'Task not serializable'), recommendation: advice },
      ],
      vi.fn(),
      withJobs([failedJob(1, [3]), failedJob(2, [9])]),
    );

    expect(screen.getByTestId('run-failure-reason')).toHaveTextContent('FetchFailed: shuffle lost');
    const steps = within(screen.getByRole('list', { name: 'Next steps' })).getAllByTestId('next-step');
    const stage3 = steps.find((step) => step.textContent?.includes('in Stage 3'))!;
    const stage9 = steps.find((step) => step.textContent?.includes('in Stage 9'))!;
    expect(stage3).toHaveTextContent("What to try: Spark's recorded reason is quoted above.");
    expect(stage9).toHaveTextContent(`What to try: ${advice}`);
    expect(stage9).not.toHaveTextContent('quoted above');
    await user.click(within(stage9).getByTestId('copy-finding-button'));
    expect(writeText).toHaveBeenCalledWith(`Inspect stage failure: ${advice}`);
  });

  it('points the job-failure step at the quoted reason only when exactly one job failed', () => {
    const jobFailures: Finding = {
      type: 'jobFailureRate', stageId: null, impactBand: 'critical', recommendation: 'Inspect the driver log for the failure reason.',
    };
    const { unmount } = render(
      <StageDetailProvider>
        <RunVerdict appModel={withJobs([failedJob(1, [], 'Job aborted: out of memory')])} catalog={[jobFailures]} onRoute={vi.fn()} />
      </StageDetailProvider>,
    );
    expect(screen.getByTestId('next-step')).toHaveTextContent("What to try: Spark's recorded reason is quoted above.");
    unmount();

    renderVerdict([jobFailures], vi.fn(), withJobs([failedJob(1, [], 'Job aborted: out of memory'), failedJob(2, [], 'Other cause')]));
    expect(screen.getByTestId('next-step')).toHaveTextContent('What to try: Inspect the driver log for the failure reason.');
  });

  it('keeps the detector\'s advice on a failure step when no reason is recorded', () => {
    const failure: Finding = {
      type: 'stageFailed', stageId: 13, impactBand: 'critical', recommendation: 'Inspect the driver log for the failure reason.',
    };
    renderVerdict([failure], vi.fn(), withJobs([failedJob(1, [13])]));

    expect(screen.queryByTestId('run-failure-reason')).not.toBeInTheDocument();
    const step = within(screen.getByRole('list', { name: 'Next steps' })).getAllByTestId('next-step')[0];
    expect(step).toHaveTextContent('What to try: Inspect the driver log for the failure reason.');
  });

  it('counts a partial failure, falls back to the job exception, and never calls the run clean', () => {
    renderVerdict([], vi.fn(), withJobs([okJob(1), failedJob(2, [], 'Job aborted: out of memory'), okJob(3)]));

    expect(screen.getByRole('heading', { level: 2, name: '1 of 3 jobs failed in this run' })).toBeInTheDocument();
    expect(screen.getByTestId('run-failure-reason')).toHaveTextContent('Job aborted: out of memory');
    expect(screen.getByTestId('run-verdict')).not.toHaveTextContent('Every check passed');
  });

  it('says every job succeeded on a run that finished', () => {
    renderVerdict([timed('skew', 7, 2_400)], vi.fn(), withJobs([okJob(1), okJob(2)]));
    expect(screen.getByTestId('run-verdict')).toHaveTextContent('All 2 jobs succeeded.');
    expect(screen.queryByTestId('run-failure-reason')).not.toBeInTheDocument();
  });
});

describe('RunVerdict on what the log could not check', () => {
  const memoryCaveat: Finding = {
    type: 'memoryUtilization', variant: 'memoryBand', stageId: null, impactBand: 'info', dataUnavailable: true,
    recommendation: 'Per-executor memory usage requires spark.eventLog.logStageExecutorMetrics=true: not enabled for this run.',
  } as Finding;

  it('never calls a run clean when a check could not run, and names the setting to turn on', () => {
    renderVerdict([memoryCaveat]);
    expect(screen.getByRole('heading', { level: 2, name: 'Nothing to fix, but some checks could not run on this log' })).toBeInTheDocument();
    expect(screen.getByTestId('run-verdict')).not.toHaveTextContent('Every check passed');
    expect(screen.getByTestId('verdict-gaps')).toHaveTextContent('Not checked on this log');
    expect(screen.getByTestId('verdict-gaps')).toHaveTextContent('spark.eventLog.logStageExecutorMetrics=true');
  });

  it('lists the gaps under the next steps of a run with findings too', () => {
    renderVerdict([timed('skew', 7, 2_400), memoryCaveat]);
    expect(screen.getByRole('heading', { level: 2, name: 'Start with Stage 7' })).toBeInTheDocument();
    expect(screen.getByTestId('verdict-gaps')).toHaveTextContent('spark.eventLog.logStageExecutorMetrics=true');
  });

  it('says so when no stage in the log finished', () => {
    const model = { ...appModel(), stages: new Map([[7, { id: 7, submittedAt: 0 }]]) } as AppModel;
    renderVerdict([], vi.fn(), model);
    expect(screen.getByRole('heading', { level: 2, name: 'This log has no finished stages to check' })).toBeInTheDocument();
    expect(screen.getByTestId('verdict-gaps')).toHaveTextContent('No stage in this log recorded an end');
  });

  it('keeps the clean message for a run with nothing missing', () => {
    renderVerdict([]);
    expect(screen.getByRole('heading', { level: 2, name: 'No findings to fix right now.' })).toBeInTheDocument();
    expect(screen.queryByTestId('verdict-gaps')).not.toBeInTheDocument();
  });
});

describe('savingsMeaning', () => {
  const withEstimate = (impactEstimate: Finding['impactEstimate']): Finding => ({ type: 'skew', stageId: 1, impactBand: 'critical', impactEstimate });
  const costOnly = (unit: 'mbSeconds' | 'coreHours' | 'coreMs' | 'bytes' | 'ms') =>
    withEstimate({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 10, unit } });

  it('says a wall-clock figure is run time, and names the resource behind a cost-only one', () => {
    expect(savingsMeaning(withEstimate({ basis: 'serial', wallClock: { low: 1, high: 1 }, estimateMethod: 'measured' }))).toBe('of run time');
    expect(savingsMeaning(costOnly('mbSeconds'))).toBe('of unused executor memory');
    expect(savingsMeaning(costOnly('coreHours'))).toBe('of core time');
    expect(savingsMeaning(costOnly('coreMs'))).toBe('of core time');
    expect(savingsMeaning(costOnly('bytes'))).toBe('of extra data written');
    expect(savingsMeaning(withEstimate({ basis: 'informational', wallClock: null, estimateMethod: 'none' }))).toBeNull();
    expect(savingsMeaning(withEstimate(undefined))).toBeNull();
  });

  it('renders a capacity figure in readable units and says what it counts, on screen and when copied', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderVerdict([{
      type: 'memoryUtilization', stageId: null, impactBand: 'warning', recommendation: 'Right-size executor memory.',
      impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 10_956_685.3, unit: 'mbSeconds' } },
    }]);

    const step = screen.getByTestId('next-step');
    expect(step).toHaveTextContent('Potential savings 3.0 GB-h of unused executor memory');
    await user.click(within(step).getByTestId('copy-finding-button'));
    expect(writeText.mock.calls[0][0]).toMatch(/Potential savings: 3\.0 GB-h of unused executor memory$/);
  });
});

describe('estimateProvenance', () => {
  const withEstimate = (impactEstimate: Finding['impactEstimate']): Finding => ({ type: 'skew', stageId: 1, impactBand: 'critical', impactEstimate });

  it('calls a serial figure close to a point estimate and notes ms raw waste only when the floor clipped it', () => {
    expect(estimateProvenance(withEstimate({ basis: 'serial', wallClock: { low: 2000, high: 2000 }, estimateMethod: 'measured', rawWaste: { value: 2000, unit: 'ms' } })))
      .toBe('2.0s, measured. The stage ran effectively alone, so this is close to a point estimate.');
    expect(estimateProvenance(withEstimate({ basis: 'serial', wallClock: { low: 2000, high: 2000 }, estimateMethod: 'measured', rawWaste: { value: 900, unit: 'ms' } })))
      .toBe('2.0s, measured. The stage ran effectively alone, so this is close to a point estimate.');
    expect(estimateProvenance(withEstimate({ basis: 'serial', wallClock: { low: 2000, high: 2000 }, estimateMethod: 'measured', rawWaste: { value: 9000, unit: 'ms' } })))
      .toBe('2.0s, measured. The stage ran effectively alone, so this is close to a point estimate. Raw waste before the floor clipped it: 9.0s.');
  });

  it('describes a bytes raw waste as the resource measured, never as clipped time', () => {
    const text = estimateProvenance(withEstimate({ basis: 'serial', wallClock: { low: 4000, high: 4000 }, estimateMethod: 'modeled', rawWaste: { value: 3.2e9, unit: 'bytes' } }));
    expect(text).toMatch(/^4\.0s, modeled\. The stage ran effectively alone, so this is close to a point estimate\. Resource waste measured: 3\.2 GB\.$/);
    expect(text).not.toContain('clipped');
  });

  it('explains a contended range as a floor and an optimistic high, without a degenerate range', () => {
    expect(estimateProvenance(withEstimate({ basis: 'contended', wallClock: { low: 1000, high: 3000 }, estimateMethod: 'modeled' })))
      .toBe('1.0s-3.0s, modeled. The stage shared the cluster with others: 1.0s is the floor, 3.0s assumes the fix fully lands.');
    expect(estimateProvenance(withEstimate({ basis: 'contended', wallClock: { low: 141_100, high: 141_400 }, estimateMethod: 'modeled' })))
      .toBe('2m 21s, modeled. The stage shared the cluster with others: its floor and optimistic high agree.');
  });

  it('says nothing for a figure that reads as zero, like the step itself', () => {
    expect(estimateProvenance(withEstimate({ basis: 'serial', wallClock: { low: 0, high: 0 }, estimateMethod: 'measured' }))).toBeNull();
    expect(estimateProvenance(withEstimate({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 0.04, unit: 'coreHours' } }))).toBeNull();
  });

  it('makes no run-time claim for a resource-only figure, and says nothing without a model', () => {
    expect(estimateProvenance(withEstimate({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 5000, unit: 'coreMs' } })))
      .toBe('No run-time claim, modeled. 5.0 core-s was wasted, but it may not shorten the run.');
    expect(estimateProvenance(withEstimate({ basis: 'informational', wallClock: null, estimateMethod: 'none' }))).toBeNull();
    expect(estimateProvenance(withEstimate(undefined))).toBeNull();
  });
});

describe('RunVerdict in Advanced view', () => {
  afterEach(() => store.getState().setWidgetDensity('basic'));

  it('shows how each estimate was made, the confidence marker and the ranking rule; Basic view does not', () => {
    const skew = { ...timed('skew', 7, 2_400), confidence: 'medium' } as Finding;
    const spill = timed('spill', 3, 1_000, 'warning');
    renderVerdict([skew, spill]);
    expect(screen.queryByTestId('next-step-provenance')).not.toBeInTheDocument();

    cleanup();
    store.getState().setWidgetDensity('advanced');
    renderVerdict([skew, spill]);
    const [first] = screen.getAllByTestId('next-step-provenance');
    expect(first).toHaveTextContent('Estimate: 2.4s, modeled. The stage ran effectively alone');
    expect(first).toHaveTextContent('Medium confidence: verify before acting.');
    expect(screen.getByTestId('run-verdict')).toHaveTextContent('Order: by the high end of potential savings');
  });
});

describe('RunVerdict Copy next steps', () => {
  it('copies the whole plan as a checklist: run, verdict, numbered steps with their stage, and what was not checked', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const caveat = {
      type: 'memoryUtilization', variant: 'memoryBand', stageId: null, impactBand: 'info', dataUnavailable: true,
      recommendation: 'Per-executor memory usage requires spark.eventLog.logStageExecutorMetrics=true.',
    } as Finding;
    const model = { ...appModel(), app: { ...appModel().app, name: 'nightly-job' } } as AppModel;
    renderVerdict([timed('skew', 7, 2_400), timed('spill', 3, 1_000, 'warning'), caveat], vi.fn(), model);

    await user.click(screen.getByTestId('copy-plan-button'));
    expect(writeText).toHaveBeenCalledWith([
      'Spark run nightly-job: Start with Stage 7',
      '',
      '1. Fix task skew in Stage 7: Fix skew in Stage 7. Potential savings: 2.4s of run time',
      '2. Reduce spill in Stage 3: Fix spill in Stage 3. Potential savings: 1.0s of run time',
      '',
      'Not checked on this log:',
      '- Per-executor memory usage requires spark.eventLog.logStageExecutorMetrics=true.',
      '',
      'For the next run: --conf spark.eventLog.logStageExecutorMetrics=true',
    ].join('\n'));
    expect(screen.getByTestId('copy-plan-button')).toHaveTextContent('Copied');
  });
});

describe('settings for the next run', () => {
  const executorMetrics = 'Per-executor memory usage requires spark.eventLog.logStageExecutorMetrics=true: not enabled for this run.';
  const blockUpdates = "1 persisted RDD has no cache-storage evidence in this log, so eviction can't be checked: Spark 2.3+ records cached sizes only as block updates, which need spark.eventLog.logBlockUpdates.enabled=true.";

  it('collects each named setting once, with its value and without the sentence punctuation around it', () => {
    expect(gapSettings([executorMetrics, blockUpdates, executorMetrics, 'No stage in this log recorded an end.']))
      .toEqual(['spark.eventLog.logStageExecutorMetrics=true', 'spark.eventLog.logBlockUpdates.enabled=true']);
    expect(gapSettings(['Turn on spark.eventLog.logBlockUpdates.enabled for this.'])).toEqual([]);
    expect(sparkSubmitFlags(['spark.a=true', 'spark.b.c=1'])).toBe('--conf spark.a=true --conf spark.b.c=1');
  });

  it('offers the settings as one spark-submit line to copy, and nothing when no gap names one', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const caveat = (recommendation: string, variant: string) =>
      ({ type: 'memoryUtilization', variant, stageId: null, impactBand: 'info', dataUnavailable: true, recommendation }) as Finding;
    renderVerdict([timed('skew', 7, 2_400), caveat(executorMetrics, 'memoryBand'), caveat(blockUpdates, 'cacheStorage')]);

    const settings = screen.getByTestId('verdict-gap-settings');
    const flags = '--conf spark.eventLog.logStageExecutorMetrics=true --conf spark.eventLog.logBlockUpdates.enabled=true';
    expect(within(settings).getByText('--conf spark.eventLog.logStageExecutorMetrics=true')).toBeInTheDocument();
    expect(within(settings).getByText('--conf spark.eventLog.logBlockUpdates.enabled=true')).toBeInTheDocument();
    await user.click(within(settings).getByTestId('copy-settings-button'));
    expect(writeText).toHaveBeenCalledWith(flags);
    expect(within(settings).getByTestId('copy-settings-button')).toHaveTextContent('Copied');

    cleanup();
    renderVerdict([timed('skew', 7, 2_400)], vi.fn(), { ...appModel(), stages: new Map() } as AppModel);
    expect(screen.getByTestId('verdict-gaps')).toHaveTextContent('No stage in this log recorded an end');
    expect(screen.queryByTestId('verdict-gap-settings')).not.toBeInTheDocument();
  });
});
