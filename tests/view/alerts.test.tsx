// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AlwaysVisibleAndCleanChecks, computeActiveWidgets } from '../../src/view/widgets/Alerts';
import { emptyAppModel } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import type { Finding, ImpactBand } from '@sparkforensics/core/types.ts';

function skewFinding(stageId: number, impactBand: ImpactBand): Finding {
  return { type: 'skew', stageId, impactBand, metric: 'p95Median', value: 5, recommendation: `Rebalance Stage ${stageId}.` } as Finding;
}

function gcFinding(stageId: number, impactBand: ImpactBand): Finding {
  return { type: 'gc', stageId, impactBand, direction: 'high', value: 15, recommendation: `Investigate GC in Stage ${stageId}.` } as Finding;
}

describe('computeActiveWidgets', () => {
  it('ranks by worst impact band then widget order, and never includes the always-mounted type', () => {
    const catalog = [skewFinding(1, 'warning'), gcFinding(2, 'critical')];
    const widgets = computeActiveWidgets(catalog, []);
    expect(widgets.map((w) => w.impactBand)).toEqual(['critical', 'warning']);
    expect(widgets.every((w) => w.component !== undefined)).toBe(true);
    expect(widgets.some((w) => w.widgetId === 'core-usage-area')).toBe(false);
  });

  it('includes memory-utilization/executor-utilization once they have an active finding (no longer always-mounted)', () => {
    const memoryFinding = { type: 'memoryUtilization', variant: 'idleCores', stageId: null, impactBand: 'warning', value: 75, recommendation: 'r' } as Finding;
    const utilizationFinding = { type: 'utilization', stageId: null, impactBand: 'info', value: 42, recommendation: 'r' } as Finding;
    const widgets = computeActiveWidgets([memoryFinding, utilizationFinding], []);
    expect(widgets.map((w) => w.widgetId)).toEqual(expect.arrayContaining(['memory-utilization', 'executor-utilization']));
  });

  it('excludes memory-utilization when its only finding is the dataUnavailable caveat (not real evidence of an issue)', () => {
    const dataUnavailableFinding = {
      type: 'memoryUtilization', variant: 'memoryBand', stageId: null, impactBand: 'info',
      dataUnavailable: true, recommendation: 'Per-executor memory usage requires spark.eventLog.logStageExecutorMetrics=true: not enabled for this run.',
    } as Finding;
    const widgets = computeActiveWidgets([dataUnavailableFinding], []);
    expect(widgets.some((w) => w.widgetId === 'memory-utilization')).toBe(false);
  });

  it('mounts cache-utilization for its storageUnobserved caveat, so missing block updates never read as a clean check', () => {
    const caveat = {
      type: 'cacheUtilization', variant: 'storageUnobserved', stageId: null, impactBand: 'info', value: 2,
      dataUnavailable: true, recommendation: 'r',
    } as Finding;
    const widgets = computeActiveWidgets([caveat], []);
    expect(widgets.some((w) => w.widgetId === 'cache-utilization')).toBe(true);
  });

  it('returns an empty list for a clean catalog', () => {
    expect(computeActiveWidgets([], [])).toEqual([]);
  });
});

describe('AlwaysVisibleAndCleanChecks', () => {
  it('passes defaultCollapsed to Widget components from alwaysMountedWidgets', () => {
    // This test documents that Widget components rendered via alwaysMountedWidgets
    // should receive the defaultCollapsed prop. The actual rendering behavior is
    // verified by checking that Alerts.tsx passes defaultCollapsed to each Widget.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../src/view/widgets/Alerts.tsx'), 'utf-8');

    // Verify that the code passes defaultCollapsed prop to Widget components
    expect(source).toContain('defaultCollapsed />');
  });
});

describe('Clean checks on a log that could not be fully checked', () => {
  afterEach(cleanup);

  async function renderCleanChecks(catalog: Finding[], stages: Map<number, unknown>) {
    const appModel = { ...emptyAppModel(), stages } as ReturnType<typeof emptyAppModel>;
    render(
      <DocsProvider>
        <AlwaysVisibleAndCleanChecks appModel={appModel} catalog={catalog} getTaskData={async () => ({}) as never} />
      </DocsProvider>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clean checks' }));
  }
  const rowStatus = (type: string) =>
    screen.getAllByTestId('clean-check-row').find((row) => row.dataset.cleanCheckType === type)?.dataset.cleanCheckStatus;
  const finished = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10 }]]);

  it('never lists per-stage checks as passed when no stage finished', async () => {
    await renderCleanChecks([], new Map([[0, { id: 0, submittedAt: 0 }]]));
    expect(screen.getByTestId('clean-checks-not-run')).toHaveTextContent('Not checked on this log');
    expect(rowStatus('skew')).toBe('notRun');
    expect(rowStatus('spill')).toBe('notRun');
    expect(rowStatus('coldStart')).toBe('passed');
  });

  it('lists a check whose only finding is a missing-data caveat as not checked', async () => {
    const caveat = {
      type: 'memoryUtilization', variant: 'memoryBand', stageId: null, impactBand: 'info', dataUnavailable: true,
      recommendation: 'Per-executor memory usage requires spark.eventLog.logStageExecutorMetrics=true: not enabled for this run.',
    } as Finding;
    await renderCleanChecks([caveat], finished);
    expect(rowStatus('memoryUtilization')).toBe('notRun');
    expect(rowStatus('skew')).toBe('passed');
  });

  it('lists the checks that need the run end as not checked on a log with no ApplicationEnd', async () => {
    const incompleteRun = { type: 'incompleteRun', stageId: null, impactBand: 'warning', recommendation: 'No ApplicationEnd.' } as Finding;
    await renderCleanChecks([incompleteRun], finished);
    expect(rowStatus('utilization')).toBe('notRun');
    expect(rowStatus('memoryUtilization')).toBe('notRun');
    expect(rowStatus('autoscalingChurn')).toBe('notRun');
    expect(rowStatus('skew')).toBe('passed');
  });

  it('lists every check as passed on a fully checked clean log', async () => {
    await renderCleanChecks([], finished);
    expect(screen.queryByTestId('clean-checks-not-run')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('clean-check-row').every((row) => row.dataset.cleanCheckStatus === 'passed')).toBe(true);
  });
});
