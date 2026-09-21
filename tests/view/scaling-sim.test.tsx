// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { emptyAppModel, store } from '@/store/store';
import { ScalingSim, makespanYAxisDomain } from '@/view/widgets/ScalingSim';
import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import type { AppModel, Job } from '@sparkforensics/core/types.ts';

// Fixture mirrors the real per-stage shape posted by the parser worker so
// simulateScaling can actually run.
function runnableAppModel(): AppModel {
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 1000, resources: { executor: { cores: 2 } } },
    stages: new Map([[1, { stageId: 1, submittedAt: 0, completedAt: 1000 }]]) as unknown as AppModel['stages'],
    runAggregates: { perStage: { 1: { totalTaskDurationSum: 2000, taskCount: 4 } } },
    evidenceAvailability: {
      schemaVersion: 1,
      entries: [{ key: 'taskCoreTime', state: 'present', reasonCode: 'observed', summary: 'Observed in this event log.', evidence: { eventType: 'taskRecords', count: 4 } }],
    },
    executors: {
      added: [{ executorId: '1', timestamp: 0, totalCores: 2 } as unknown as AppModel['executors']['added'][number]],
      removed: [],
    },
  };
}

describe('ScalingSim', () => {
  it('renders the WidgetCard heading and a chart region when the model can run', async () => {
    const user = userEvent.setup();
    store.getState().setWidgetDensity('advanced');
    render(
      <DocsProvider>
        <EvidenceAvailabilityProvider>
          <ScalingSim appModel={runnableAppModel()} />
        </EvidenceAvailabilityProvider>
      </DocsProvider>,
    );

    const heading = screen.getByRole('heading', { name: /what-if executor scaling/i });
    expect(heading).toBeInTheDocument();

    // Expand the card to see the chart
    await user.click(heading.closest('button')!);
    expect(screen.getByRole('img', { name: /estimated makespan/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /evidence: task and core time/i })).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('renders a doc link pointing at the autoscale-bounds anchor', async () => {
    const user = userEvent.setup();
    render(
      <DocsProvider>
        <ScalingSim appModel={runnableAppModel()} />
      </DocsProvider>,
    );

    // Expand the card to see the link
    const heading = screen.getByRole('heading', { name: /what-if executor scaling/i });
    await user.click(heading.closest('button')!);

    const link = screen.getByRole('link', { name: /autoscaling config guide/i });
    expect(link.getAttribute('href')).toContain('#config-autoscale-bounds');
  });

  it('renders the unavailable fallback (not the chart) when there are no run aggregates', () => {
    const model = { ...runnableAppModel(), runAggregates: null };
    render(<EvidenceAvailabilityProvider><ScalingSim appModel={model} /></EvidenceAvailabilityProvider>);

    expect(screen.getByRole('heading', { name: /what-if executor scaling/i })).toBeInTheDocument();
    expect(screen.getByText(/not available/i)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /estimated makespan/i })).not.toBeInTheDocument();
  });

  it('treats an empty aggregate object as unavailable task and core-time evidence', () => {
    const model = runnableAppModel();
    model.runAggregates = {};
    model.evidenceAvailability = {
      schemaVersion: 1,
      entries: [{ key: 'taskCoreTime', state: 'notEmitted', reasonCode: 'noUsableCoreTimeAggregate', summary: 'No usable aggregate was emitted.' }],
    };

    render(<EvidenceAvailabilityProvider><ScalingSim appModel={model} /></EvidenceAvailabilityProvider>);

    expect(screen.getByRole('button', { name: /evidence: task and core time/i })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /estimated makespan/i })).not.toBeInTheDocument();
  });

  it('renders the unavailable fallback when the model has no baseline cores', () => {
    const model = runnableAppModel();
    model.app = { startTime: 0, endTime: 1000, resources: {} };
    model.executors = { added: [], removed: [] };
    render(<EvidenceAvailabilityProvider><ScalingSim appModel={model} /></EvidenceAvailabilityProvider>);

    expect(screen.getByText(/baseline executor\/core capacity is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /estimated makespan/i })).not.toBeInTheDocument();
  });

  it('renders a reason-specific unavailable state when stage timing is unusable', () => {
    const model = runnableAppModel();
    model.stages = new Map([[1, { stageId: 1, submittedAt: 0, completedAt: 0 }]]) as unknown as AppModel['stages'];

    render(<ScalingSim appModel={model} />);

    expect(screen.getByText(/usable stage timing is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /estimated makespan/i })).not.toBeInTheDocument();
  });

  it('shows the concurrent-job-group reliability banner when the run is unreliable', () => {
    store.getState().setWidgetDensity('advanced');
    const model = runnableAppModel();
    model.jobs = new Map<number, Job>([
      [0, { jobId: 0, submissionTime: 0, completionTime: 1500, sqlExecutionId: 1 } as unknown as Job],
      [1, { jobId: 1, submissionTime: 1000, completionTime: 2000, sqlExecutionId: 2 } as unknown as Job],
    ]);
    render(
      <DocsProvider>
        <ScalingSim appModel={model} />
      </DocsProvider>,
    );

    expect(screen.getByText(/concurrent job group/i)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('fits the y-axis domain tightly to the makespan range instead of anchoring at 0', () => {
    // e.g. a 4m10s-7m30s makespan spread should stay a tight band, not get
    // compressed against a 0-10m axis (regression: branch defaulted to
    // Recharts' auto domain, which starts at 0).
    expect(makespanYAxisDomain([250_000, 450_000])).toEqual([230_000, 470_000]);
  });

  it('never lets the y-axis domain go negative for a range close to zero', () => {
    const [min] = makespanYAxisDomain([10, 20]);
    expect(min).toBeGreaterThanOrEqual(0);
  });

  it('exposes a data table matching the predictions, hidden by default, with right-aligned numeric columns', async () => {
    const user = userEvent.setup();
    render(
      <DocsProvider>
        <ScalingSim appModel={runnableAppModel()} />
      </DocsProvider>,
    );

    // Expand the card to see the content
    const heading = screen.getByRole('heading', { name: /what-if executor scaling/i });
    await user.click(heading.closest('button')!);

    const hiddenHeader = screen.queryByRole('columnheader', { name: '% Executors' });
    expect(hiddenHeader?.closest('table')).toHaveClass('sr-only');

    await user.click(screen.getByRole('button', { name: /table/i }));
    const pctHeader = screen.getByRole('columnheader', { name: '% Executors' });
    const coresHeader = screen.getByRole('columnheader', { name: 'Cores' });
    const makespanHeader = screen.getByRole('columnheader', { name: 'Est. makespan' });
    expect(pctHeader).toHaveClass('text-right');
    expect(coresHeader).toHaveClass('text-right');
    expect(makespanHeader).toHaveClass('text-right');
  });

  it('Model-Error caveat, concurrent-job-groups caveat, and evidence marker are Advanced-only', () => {
    store.getState().setWidgetDensity('basic');
    render(
      <DocsProvider>
        <EvidenceAvailabilityProvider>
          <ScalingSim appModel={runnableAppModel()} />
        </EvidenceAvailabilityProvider>
      </DocsProvider>,
    );
    expect(screen.queryByText(/model error:/i)).not.toBeInTheDocument();

    cleanup();
    store.getState().setWidgetDensity('advanced');
    render(
      <DocsProvider>
        <EvidenceAvailabilityProvider>
          <ScalingSim appModel={runnableAppModel()} />
        </EvidenceAvailabilityProvider>
      </DocsProvider>,
    );
    expect(screen.getByText(/model error:/i)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('the unavailable-data fallback card keeps its RowStatusCluster visible at Basic tier', () => {
    store.getState().setWidgetDensity('basic');
    const model = { ...runnableAppModel(), runAggregates: null };
    render(
      <EvidenceAvailabilityProvider>
        <ScalingSim appModel={model} />
      </EvidenceAvailabilityProvider>,
    );
    expect(screen.getByRole('button', { name: /evidence:/i })).toBeInTheDocument();
  });

  it('renders with defaultCollapsed and shows the best-makespan summary when collapsed', () => {
    render(
      <DocsProvider>
        <ScalingSim appModel={runnableAppModel()} />
      </DocsProvider>,
    );

    // The card should have a summary visible (shown when collapsed)
    const summary = screen.getByText(/best case at/i);
    expect(summary).toBeInTheDocument();

    // The summary should show a duration for the best makespan
    const heading = screen.getByRole('heading', { name: /what-if executor scaling/i });
    expect(heading).toBeInTheDocument();
  });

  it('the unavailable fallback has a summary', () => {
    const model = { ...runnableAppModel(), runAggregates: null };
    render(<EvidenceAvailabilityProvider><ScalingSim appModel={model} /></EvidenceAvailabilityProvider>);

    expect(screen.getByText(/not available/i)).toBeInTheDocument();
  });
});
