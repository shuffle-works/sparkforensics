// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel, store } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { JobFailures } from '@/view/widgets/JobFailures';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    type: 'jobFailureRate', stageId: null, impactBand: 'warning',
    metric: 'jobFailureRate', value: 30, failedJobs: 3, totalJobs: 10,
    failedTasks: 12, totalTasks: 200, taskFailureRate: 6,
    recommendation: 'Inspect the driver log',
    docAnchor: '#bottleneck-job-failure-rate',
    ...overrides,
  };
}

function buildAppModel(jobs: [number, Record<string, unknown>][] = []): AppModel {
  return { ...emptyAppModel(), jobs: new Map(jobs) as unknown as AppModel['jobs'] };
}

function renderWidget(appModel: AppModel, catalog: Finding[]) {
  return render(
    <DocsProvider>
      <JobFailures appModel={appModel} catalog={catalog} getTaskData={() => Promise.reject()} />
    </DocsProvider>,
  );
}

test('renders the WidgetCard heading', () => {
  renderWidget(buildAppModel(), [finding()]);
  expect(screen.getByRole('heading', { name: 'Job Failures' })).toBeInTheDocument();
});

test('shows the JOBS tag badge with the finding impact band', () => {
  renderWidget(buildAppModel(), [finding({ impactBand: 'critical' })]);
  expect(screen.getByText('JOBS')).toBeInTheDocument();
});

test('shows the failure-rate summary and task-failure context', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  renderWidget(buildAppModel(), [finding()]);

  // Expand the card to see the detailed content
  const cardToggle = screen.getByRole('button', { name: 'Job Failures' });
  await user.click(cardToggle);

  expect(screen.getByText(/Failure rate:/)).toBeInTheDocument();
  expect(screen.getByText(/3 of 10 completed jobs/)).toBeInTheDocument();
  // Task-failure context is Advanced-only: a derived, secondary statistic
  // restating the same problem at task granularity.
  expect(screen.getByText(/12 of 200 tasks failed/)).toBeInTheDocument();
  expect(screen.getByText('Inspect the driver log')).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('hides the task-failure context line at Basic density', async () => {
  const user = userEvent.setup();
  renderWidget(buildAppModel(), [finding()]);

  const cardToggle = screen.getByRole('button', { name: 'Job Failures' });
  await user.click(cardToggle);

  expect(screen.getByText(/Failure rate:/)).toBeInTheDocument();
  expect(screen.queryByText(/tasks failed/)).not.toBeInTheDocument();
});

test('renders nothing when no jobFailureRate finding is present', () => {
  const appModel = buildAppModel([
    [1, { jobId: 1, result: 'JobSucceeded', succeeded: true }],
    [2, { jobId: 2, result: 'JobSucceeded', succeeded: true }],
  ]);
  const { container } = renderWidget(appModel, [{ type: 'spill', stageId: 1, impactBand: 'warning' }]);
  expect(container).toBeEmptyDOMElement();
});

test('renders nothing regardless of completed-job data, when the catalog has no jobFailureRate finding', () => {
  const appModel = buildAppModel([
    [1, { jobId: 1, result: 'JobSucceeded', succeeded: true }],
    [2, { jobId: 2, result: 'JobFailed', succeeded: false }],
    [3, { jobId: 3, result: 'JobSucceeded', succeeded: true }],
    [4, { jobId: 4, result: 'JobSucceeded', succeeded: true }],
    // Still running: no `result`, so it is excluded from the denominator.
    [5, { jobId: 5 }],
  ]);
  const { container } = renderWidget(appModel, []);
  expect(container).toBeEmptyDOMElement();
});

test('renders the core-hours raw-waste figure when the jobFailureRate finding carries an impactEstimate', async () => {
  renderWidget(buildAppModel(), [finding({
    impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 1.5, unit: 'coreHours' } },
  })]);
  expect(screen.getByText('1.5 core-h')).toBeInTheDocument();
});

test('shows the recommendation unconditionally, with no toggle to hide it', async () => {
  const user = userEvent.setup();
  renderWidget(buildAppModel(), [finding({ recommendation: 'Inspect the driver log for job failures.' })]);

  // Expand the card first since it starts collapsed with the summary
  const cardToggle = screen.getByRole('button', { name: 'Job Failures' });
  await user.click(cardToggle);

  expect(screen.getByText(/Failure rate:/)).toBeInTheDocument();
  expect(screen.getByText('Inspect the driver log for job failures.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /recommendation/i })).not.toBeInTheDocument();
});

test('renders no domain-specific copy', () => {
  const { container } = renderWidget(buildAppModel(), [finding()]);
  expect(container.textContent).not.toMatch(/scanntech|retail|cpg|latin america/i);
});

test('card defaults collapsed with the job-failure-rate summary', async () => {
  const user = userEvent.setup();
  renderWidget(buildAppModel(), [finding()]);

  // Card starts collapsed: aria-expanded="false"
  const toggle = screen.getByRole('button', { name: 'Job Failures' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // Summary should be visible when collapsed
  expect(screen.getByText(/3 of 10 completed jobs failed/)).toBeInTheDocument();

  // After expanding, aria-expanded="true" and the detailed content is visible
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText(/Failure rate:/)).toBeInTheDocument();
});
