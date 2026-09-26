// @vitest-environment jsdom
import { useState } from 'react';
import { test, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel, store } from '@/store/store';
import { analyze } from '@sparkforensics/core/analyzer.ts';
import { computeCoreLocalityRatio } from '@sparkforensics/core/core-locality-ratio.ts';
import { computeLocalityAreaSeries } from '@sparkforensics/core/core-usage-locality.ts';
import { downsample } from '@/view/charts/downsample';
import { CoreUsageArea } from '@/view/widgets/CoreUsageArea';
import { DocsProvider } from '@/view/DocsContext';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

// Both mocks call through to the real implementation; only the large-series
// test below overrides computeLocalityAreaSeries's return value for one call.
vi.mock('@sparkforensics/core/core-usage-locality.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sparkforensics/core/core-usage-locality.ts')>();
  return { ...actual, computeLocalityAreaSeries: vi.fn(actual.computeLocalityAreaSeries) };
});
vi.mock('@/view/charts/downsample', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/view/charts/downsample')>();
  return { downsample: vi.fn(actual.downsample) };
});

// Raw per-stage fields posted by the worker, not declared on the frozen
// `Stage` type, so the fixture bridges the gap with a cast.
function buildAppModel(overrides: Record<number, Record<string, unknown>> = {}): AppModel {
  const stages = new Map<number, unknown>([
    [
      1,
      {
        stageId: 1,
        submittedAt: 0,
        completedAt: 60_000,
        executorRunTime: 120_000,
        localityStats: [{ locality: 'PROCESS_LOCAL', count: 4 }],
      },
    ],
  ]);
  for (const [id, patch] of Object.entries(overrides)) {
    stages.set(Number(id), { ...(stages.get(Number(id)) as object), ...patch });
  }
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 60_000 },
    stages: stages as unknown as AppModel['stages'],
  };
}

test('renders the WidgetCard heading and a chart region when stages have core-time', async () => {
  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={[]} defaultCollapsed={false} />
    </DocsProvider>,
  );

  expect(screen.getByRole('heading', { name: /core usage/i })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: /concurrent core usage/i })).toBeInTheDocument();
});

test('renders the "approximate: stage-level attribution" subtitle', async () => {
  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={[]} />
    </DocsProvider>,
  );

  expect(screen.getByText(/approximate: stage-level attribution/i)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('renders a doc link pointing at the bottleneck-utilization anchor when no coreLocality finding is present', async () => {
  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={[]} defaultCollapsed={false} />
    </DocsProvider>,
  );

  const link = screen.getByRole('link', { name: /how utilization is measured/i });
  expect(link.getAttribute('href')).toContain('#bottleneck-utilization');
  store.getState().setWidgetDensity('basic');
});

test('drops the doc link in favor of the coreLocality tag badge, which links to the core-locality section of the same page', async () => {
  const catalog: Finding[] = [
    { type: 'coreLocality', stageId: null, impactBand: 'warning', value: 40, recommendation: 'Check locality.' },
  ];
  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={catalog} />
    </DocsProvider>,
  );

  expect(screen.queryByText(/how utilization is measured/i)).not.toBeInTheDocument();
  const badgeLink = screen.getByRole('link', { name: 'LOCAL' });
  expect(badgeLink.getAttribute('href')).toContain('bottleneck-utilization.html#bottleneck-core-locality');
});

test('renders a fallback message and no chart region when no stage has core-time', () => {
  const model = buildAppModel({ 1: { executorRunTime: 0 } });
  render(<CoreUsageArea appModel={model} catalog={[]} />);

  expect(screen.getByRole('heading', { name: /core usage/i })).toBeInTheDocument();
  expect(screen.getByText(/no stage activity/i)).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /learn more/i })).not.toBeInTheDocument();
});

test('downsamples a large bucketed series before handing it to the chart', () => {
  const bigLength = 5000;
  const labels = Array.from({ length: bigLength }, (_, i) => i * 1000);
  const series = {
    PROCESS_LOCAL: new Array(bigLength).fill(1),
    idle: new Array(bigLength).fill(0),
  };
  (computeLocalityAreaSeries as Mock).mockReturnValueOnce({ labels, series });

  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={[]} />
    </DocsProvider>,
  );

  expect(downsample).toHaveBeenCalled();
  const calls = (downsample as Mock).mock.calls;
  const bigCall = calls.find(([points]) => Array.isArray(points) && points.length === bigLength);
  expect(bigCall).toBeDefined();
  const result = (downsample as Mock).mock.results.find(
    (_r, i) => calls[i] === bigCall,
  )?.value as unknown[];
  expect(result.length).toBeLessThanOrEqual(2000);
});

test('exposes a data table matching the chart series, hidden by default', async () => {
  const user = userEvent.setup();
  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={[]} defaultCollapsed={false} />
    </DocsProvider>,
  );

  await user.click(screen.getByRole('button', { name: /table/i }));

  expect(screen.getByRole('columnheader', { name: 'Time (s)' })).toHaveClass('text-right');
  expect(screen.getByRole('columnheader', { name: 'Process-local' })).toHaveClass('text-right');
  expect(screen.getAllByRole('row').length).toBeGreaterThan(1); // header + at least one data row
});

test('is wrapped in React.memo', () => {
  expect((CoreUsageArea as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
});

// Regression: the locality series is memoized (keyed on appModel), so an
// unrelated parent re-render with the same appModel must not recompute it.
test('does not recompute the locality series when an unrelated re-render occurs with the same appModel', async () => {
  const user = userEvent.setup();
  const appModel = buildAppModel();
  const callsBefore = (computeLocalityAreaSeries as Mock).mock.calls.length;

  function Harness() {
    const [, setTick] = useState(0);
    return (
      <DocsProvider>
        <button onClick={() => setTick((t) => t + 1)}>tick</button>
        <CoreUsageArea appModel={appModel} catalog={[]} />
      </DocsProvider>
    );
  }

  render(<Harness />);
  expect((computeLocalityAreaSeries as Mock).mock.calls.length - callsBefore).toBe(1);

  await user.click(screen.getByRole('button', { name: 'tick' }));
  expect((computeLocalityAreaSeries as Mock).mock.calls.length - callsBefore).toBe(1);
});

// Regression: applySnapshot mutates appModel's fields in place, so a
// cached-file switch (same object reference, new activeFileId) must still
// refresh this widget's chart.
test('reflects a new file after appModel is mutated in place and activeFileId changes (cached-file switch)', async () => {
  const appModel = buildAppModel();

  const { rerender } = render(
    <DocsProvider>
      <CoreUsageArea appModel={appModel} catalog={[]} activeFileId="file-a" />
    </DocsProvider>,
  );
  // The locality series recomputation is the observable: it's what the
  // `activeFileId` memo key is there to trigger.
  (computeLocalityAreaSeries as Mock).mockClear();

  // Mimic applySnapshot: mutate the same appModel object's `stages` field in
  // place with a different per-stage core-time profile.
  appModel.stages = new Map([
    [
      2,
      {
        stageId: 2,
        submittedAt: 0,
        completedAt: 60_000,
        executorRunTime: 600_000,
        localityStats: [{ locality: 'PROCESS_LOCAL', count: 4 }],
      },
    ],
  ]) as unknown as AppModel['stages'];

  rerender(
    <DocsProvider>
      <CoreUsageArea appModel={appModel} catalog={[]} activeFileId="file-b" />
    </DocsProvider>,
  );

  expect(computeLocalityAreaSeries as Mock).toHaveBeenCalled();
  const [stagesArg] = (computeLocalityAreaSeries as Mock).mock.lastCall as [{ stageId: number }[]];
  expect(stagesArg.map((s) => s.stageId)).toEqual([2]);
});

test('shows the LOCAL badge, impact band, and recommendation when a coreLocality finding exists in catalog', async () => {
  const catalog: Finding[] = [{
    type: 'coreLocality', stageId: null, impactBand: 'critical',
    metric: 'nonLocalRatio', value: 40,
    recommendation: 'Tasks are running without process- or node-local data placement more than expected, check spark.locality.wait settings and executor/data colocation.',
  }];

  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={catalog} />
    </DocsProvider>,
  );

  expect(screen.getByText('LOCAL')).toBeInTheDocument();
  expect(screen.getByText(/40% non-local/)).toBeInTheDocument();
  expect(screen.getByText(/check spark\.locality\.wait settings/)).toBeInTheDocument();
});

test('renders the core-ms raw-waste figure when a coreLocality finding carries an impactEstimate', async () => {
  const catalog: Finding[] = [{
    type: 'coreLocality', stageId: null, impactBand: 'warning',
    metric: 'nonLocalRatio', value: 20, recommendation: 'x',
    impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 4200, unit: 'coreMs' } },
  }];

  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={catalog} />
    </DocsProvider>,
  );

  // formatRawWaste pins the locale to en-US so the figure doesn't drift with the host locale.
  expect(screen.getByText(`${(4200).toLocaleString('en-US')} core-ms`)).toBeInTheDocument();
});

test('renders no LOCAL badge when catalog has no coreLocality finding; the chart still renders', async () => {
  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={[]} defaultCollapsed={false} />
    </DocsProvider>,
  );

  expect(screen.queryByText('LOCAL')).not.toBeInTheDocument();
  expect(screen.getByRole('img', { name: /concurrent core usage/i })).toBeInTheDocument();
});

test('renders a per-stage non-local breakdown whenever any non-local tasks exist, regardless of threshold', async () => {
  const model = buildAppModel({
    1: {
      id: 1,
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 8 },
        { locality: 'ANY', count: 2 },
      ],
    },
  });

  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <CoreUsageArea appModel={model} catalog={[]} />
    </DocsProvider>,
  );

  expect(screen.getByText(/Stage 1: 20% non-local \(2\/10 tasks\)/)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('paginates the non-local-stage breakdown 6-at-a-time with Previous/Next controls', async () => {
  const user = userEvent.setup();
  const overrides: Record<number, Record<string, unknown>> = {};
  for (let i = 1; i <= 7; i++) {
    overrides[i] = {
      id: i,
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 8 },
        { locality: 'ANY', count: 2 },
      ],
    };
  }
  const model = buildAppModel(overrides);

  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <CoreUsageArea appModel={model} catalog={[]} defaultCollapsed={false} />
    </DocsProvider>,
  );

  expect(screen.getAllByText(/% non-local/)).toHaveLength(6);
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getAllByText(/% non-local/)).toHaveLength(1);
  store.getState().setWidgetDensity('basic');
});

test('shows the idle-core cross-link when a memoryUtilization idleCores finding coexists in catalog', async () => {
  const catalog: Finding[] = [
    { type: 'coreLocality', stageId: null, impactBand: 'warning', metric: 'nonLocalRatio', value: 20, recommendation: 'x' },
    { type: 'memoryUtilization', variant: 'idleCores', stageId: null, impactBand: 'warning', metric: 'idleCoreRate', value: 75, recommendation: 'y' },
  ];

  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={catalog} />
    </DocsProvider>,
  );

  expect(screen.getByText(/Idle cores also flagged/)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

// Build both the finding (via the real analyze()) and the appModel stage data
// from one shared fixture, so a divergence between the widget's live
// computeCoreLocalityRatio and the finding's stored value is caught here.
test('the rendered finding value and the widget\'s own locality computation agree on the same fixture', async () => {
  // Full stage shape so analyze() runs its whole detector roster; only the locality fields are tuned.
  const stage = {
    id: 1, name: 'test', submittedAt: 0, completedAt: 60_000,
    taskCount: 100, failedTasks: 0,
    shuffleReadBytes: 0, shuffleWriteBytes: 0, fetchWaitTime: 0,
    memoryBytesSpilled: 0, diskBytesSpilled: 0,
    jvmGCTime: 0, executorRunTime: 120_000,
    inputBytes: 0, outputBytes: 0,
    sqlExecutionId: null,
    taskDurationP50: 100, taskDurationP95: 100, taskDurationMax: 100,
    gcPct: 0,
    spillClassification: 'unclassified' as const,
    parentIds: [], hostStats: [], speculativeTasks: 0,
    failureReasons: [], stragglerCount: 0,
    wastedAttempts: 0, retryWasteMs: 0,
    speculationWastedAttempts: 0, speculationWasteMs: 0,
    spillMemP50: 0, spillMemMax: 0, spillDiskP50: 0, spillDiskMax: 0,
    localityStats: [
      { locality: 'PROCESS_LOCAL', count: 80 },
      { locality: 'ANY', count: 20 },
    ],
  };
  const app = { id: 'app_1', name: 'test', startTime: 0, endTime: 60_000, sparkVersion: '3.4.0', config: {} };
  const stages = new Map([[1, stage]]);

  const catalog = analyze(app, stages, [], [], new Map());
  const finding = catalog.find((f) => f.type === 'coreLocality') as Finding;
  expect(finding).toBeTruthy();

  const liveRatio = computeCoreLocalityRatio([stage]);
  // Sanity: the fixture actually produces the ratio, guarding against silent drift.
  expect(Math.round((liveRatio.ratio ?? 0) * 100)).toBe(20);

  const appModel = { ...emptyAppModel(), app, stages: stages as unknown as AppModel['stages'] };
  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <CoreUsageArea appModel={appModel} catalog={catalog} />
    </DocsProvider>,
  );


  // The stored finding's value (as `analyze()` computed and persisted it)...
  expect(screen.getByText(`${finding.value}% non-local`)).toBeInTheDocument();
  // ...must match the widget's own live `computeCoreLocalityRatio` call, not
  // just an independently-authored number.
  expect(finding.value).toBe(Math.round((liveRatio.ratio ?? 0) * 100));
  const [topStage] = liveRatio.topStages;
  expect(
    screen.getByText(`Stage ${topStage.stageId}: ${Math.round(topStage.ratio * 100)}% non-local (${topStage.nonLocalTasks}/${topStage.taskCount} tasks)`),
  ).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('does not show the idle-core cross-link when no memoryUtilization idleCores finding is present', async () => {
  const catalog: Finding[] = [
    { type: 'coreLocality', stageId: null, impactBand: 'warning', metric: 'nonLocalRatio', value: 20, recommendation: 'x' },
  ];

  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={catalog} />
    </DocsProvider>,
  );

  expect(screen.queryByText(/Idle cores also flagged/)).not.toBeInTheDocument();
});

test('shows a confidence caveat when the coreLocality finding carries one', async () => {
  const catalog: Finding[] = [{
    type: 'coreLocality', stageId: null, impactBand: 'warning',
    metric: 'nonLocalRatio', value: 20, recommendation: 'x',
    confidence: 'low',
    validationRequired: 'This finding is gated by 15%/35% non-local-ratio thresholds (and a 50-task minimum), our own noise floor for this metric.',
  }];

  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={catalog} />
    </DocsProvider>,
  );

  const caveat = screen.getByText(/low confidence/i);
  expect(caveat).toBeInTheDocument();
  expect(caveat).toHaveAttribute(
    'title',
    'This finding is gated by 15%/35% non-local-ratio thresholds (and a 50-task minimum), our own noise floor for this metric.',
  );
  store.getState().setWidgetDensity('basic');
});

test('the approximation caption, confidence marker, and idle-core cross-link are hidden in basic mode', async () => {
  const catalog: Finding[] = [
    { type: 'coreLocality', stageId: null, impactBand: 'warning', metric: 'nonLocalRatio', value: 40, recommendation: 'Check locality.', confidence: 'low', validationRequired: 'Threshold-gated finding.' },
    { type: 'memoryUtilization', variant: 'idleCores', stageId: null, impactBand: 'warning', metric: 'idleCoreRate', value: 75, recommendation: 'y' },
  ];

  store.getState().setWidgetDensity('basic');
  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={catalog} />
    </DocsProvider>,
  );

  expect(screen.queryByText(/approximate: stage-level attribution/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/idle cores also flagged/i)).not.toBeInTheDocument();

  store.getState().setWidgetDensity('basic');
});

test('the approximation caption, confidence marker, and idle-core cross-link are visible in advanced mode', async () => {
  const catalog: Finding[] = [
    { type: 'coreLocality', stageId: null, impactBand: 'warning', metric: 'nonLocalRatio', value: 40, recommendation: 'Check locality.', confidence: 'low', validationRequired: 'Threshold-gated finding.' },
    { type: 'memoryUtilization', variant: 'idleCores', stageId: null, impactBand: 'warning', metric: 'idleCoreRate', value: 75, recommendation: 'y' },
  ];

  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <CoreUsageArea appModel={buildAppModel()} catalog={catalog} />
    </DocsProvider>,
  );

  // Elements are visible even without expanding the widget
  expect(screen.getByText(/approximate: stage-level attribution/i)).toBeInTheDocument();
  expect(screen.getByText(/low confidence/i)).toBeInTheDocument();
  expect(screen.getByText(/idle cores also flagged/i)).toBeInTheDocument();

  store.getState().setWidgetDensity('basic');
});

test('defaults collapsed with a peak-cores summary', () => {
  const appModel = buildAppModel();
  render(
    <DocsProvider>
      <CoreUsageArea appModel={appModel} catalog={[]} defaultCollapsed={true} />
    </DocsProvider>,
  );

  // When collapsed, the summary shows the peak cores figure
  expect(screen.getByText(/\d+(\.\d)? cores/)).toBeInTheDocument();
  expect(screen.getByText(/busy at the peak, by locality/)).toBeInTheDocument();

  // Chart is hidden when collapsed
  expect(screen.queryByRole('img', { name: /concurrent core usage/i })).not.toBeInTheDocument();
});

test('a run shorter than one chart bucket reports its real busy cores, not a figure diluted to "0 cores"', () => {
  // 20s of task time packed into a 10s stage (2 busy cores) in a 17s run: the
  // 60s bucket covers only 17s of the run, so the peak is 2 x 10/17 = 1.2 cores.
  const appModel = { ...buildAppModel({ 1: { completedAt: 10_000, executorRunTime: 20_000 } }), app: { startTime: 0, endTime: 17_000 } };
  render(
    <DocsProvider>
      <CoreUsageArea appModel={appModel as AppModel} catalog={[]} defaultCollapsed={true} />
    </DocsProvider>,
  );
  expect(screen.getByText('1.2 cores')).toBeInTheDocument();
});
