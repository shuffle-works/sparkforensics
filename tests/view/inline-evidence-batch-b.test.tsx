// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { emptyAppModel, store } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { InlineEvidenceContext } from '@/view/InlineEvidenceContext';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { AutoscalingChurn } from '@/view/widgets/AutoscalingChurn';
import { ColdStart } from '@/view/widgets/ColdStart';
import { CoreUsageArea } from '@/view/widgets/CoreUsageArea';
import { ExecutorUtilization } from '@/view/widgets/ExecutorUtilization';
import { IncompleteRun } from '@/view/widgets/IncompleteRun';
import { JobFailures } from '@/view/widgets/JobFailures';
import { MemoryUtilization } from '@/view/widgets/MemoryUtilization';
import { RetryWaste } from '@/view/widgets/RetryWaste';
import { RightSizing } from '@/view/widgets/RightSizing';
import { StageFailed } from '@/view/widgets/StageFailed';
import { TaskFailures } from '@/view/widgets/TaskFailures';
import type { AppModel, Finding, TaskData } from '@sparkforensics/core/types.ts';
import { installInterpretation } from './_shared/interpretation';
import { testFinding } from './_shared/finding';

const getTaskData = async (): Promise<TaskData> => ({ metrics: [], fieldNames: [] });

afterEach(() => store.getState().setWidgetDensity('basic'));

/** Renders `ui` the way an in-place evidence panel does, with `stated` ids stated by the line above. */
function renderPanel(ui: ReactElement, stated: string[]) {
  return render(
    <InlineEvidenceContext.Provider value={{ stated: new Set(stated) }}>
      <StageDetailProvider>
        <DocsProvider>{ui}</DocsProvider>
      </StageDetailProvider>
    </InlineEvidenceContext.Provider>,
  );
}

function renderPlain(ui: ReactElement) {
  return render(
    <StageDetailProvider>
      <DocsProvider>{ui}</DocsProvider>
    </StageDetailProvider>,
  );
}

const stageButton = (n: number) => screen.queryByRole('button', { name: `Open details for Stage ${n}` });

describe('StageFailed', () => {
  const catalog = (): Finding[] => [
    testFinding({ type: 'stageFailed', stageId: 3, impactBand: 'critical', id: 'sf-3', valueText: 'OOM in task 7', recommendation: 'This stage attempt failed outright.' }),
    testFinding({ type: 'stageFailed', stageId: 4, impactBand: 'critical', id: 'sf-4', valueText: 'fetch failed', recommendation: 'This stage attempt failed outright.' }),
  ];

  it('drops the stage chip and the restated sentence for a stated finding, keeping the reason; the other finding keeps everything', () => {
    const findings = catalog();
    installInterpretation(findings);
    const { container } = renderPanel(<StageFailed appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />, ['sf-3']);
    expect(stageButton(3)).not.toBeInTheDocument();
    expect(container.textContent).toContain('Reason: OOM in task 7');
    expect(container.textContent).not.toContain('Stage attempt failed outright. Reason: OOM in task 7');
    expect(stageButton(4)).toBeInTheDocument();
    expect(container.textContent).toContain('Stage attempt failed outright. Reason: fetch failed');
  });

  it('is unchanged outside the panel', () => {
    const findings = catalog();
    installInterpretation(findings);
    const { container } = renderPlain(<StageFailed appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />);
    expect(stageButton(3)).toBeInTheDocument();
    expect(container.textContent).toContain('Stage attempt failed outright. Reason: OOM in task 7');
  });
});

describe('TaskFailures', () => {
  const catalog = (): Finding[] => [
    testFinding({ type: 'failures', stageId: 3, impactBand: 'warning', id: 'tf-3', value: 12, failedTasks: 24, dominantError: 'OOM', failureGroups: [], otherFailedTasks: 0 }),
    testFinding({ type: 'failures', stageId: 4, impactBand: 'warning', id: 'tf-4', value: 8, failedTasks: 16, dominantError: 'IOError', failureGroups: [], otherFailedTasks: 0 }),
  ];

  it('drops the stage chip, rate and dominant error for a stated finding, keeping the task count', () => {
    const findings = catalog();
    installInterpretation(findings);
    const { container } = renderPanel(<TaskFailures appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />, ['tf-3']);
    expect(stageButton(3)).not.toBeInTheDocument();
    expect(container.textContent).toContain('24 failed tasks');
    expect(container.textContent).not.toContain('Dominant error: OOM');
    expect(stageButton(4)).toBeInTheDocument();
    expect(container.textContent).toContain('Failure rate: 8% (16 tasks)');
    expect(container.textContent).toContain('Dominant error: IOError');
  });

  it('is unchanged outside the panel', () => {
    const findings = catalog();
    installInterpretation(findings);
    const { container } = renderPlain(<TaskFailures appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />);
    expect(stageButton(3)).toBeInTheDocument();
    expect(container.textContent).toContain('Failure rate: 12% (24 tasks)');
  });
});

describe('RetryWaste', () => {
  const catalog = (): Finding[] => [
    testFinding({ type: 'retryWaste', stageId: 3, impactBand: 'warning', id: 'rw-3', value: 40_000, extended: '5 task attempts were superseded by a later retry, wasting 40s of executor time. Check driver logs.' }),
    testFinding({ type: 'retryWaste', stageId: 4, impactBand: 'warning', id: 'rw-4', value: 50_000 }),
  ];

  it('drops the stage chip and the wasted-time line for a stated finding; the other finding keeps both', () => {
    const findings = catalog();
    installInterpretation(findings);
    const { container } = renderPanel(<RetryWaste appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />, ['rw-3']);
    expect(stageButton(3)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('Wasted 40.0s');
    expect(stageButton(4)).toBeInTheDocument();
    expect(container.textContent).toContain('Wasted 50.0s of executor time.');
  });

  it('renders no row for a stated finding at Basic, and only its Advanced extension at Advanced', () => {
    const findings = [catalog()[0]];
    installInterpretation(findings);
    const basic = renderPanel(<RetryWaste appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />, ['rw-3']);
    expect(basic.container.querySelector('li')).toBeNull();
    basic.unmount();
    store.getState().setWidgetDensity('advanced');
    const advanced = renderPanel(<RetryWaste appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />, ['rw-3']);
    expect(advanced.container.textContent).toContain('5 task attempts were superseded by a later retry.');
    expect(advanced.container.textContent).not.toContain('Wasted');
  });

  it('is unchanged outside the panel', () => {
    const findings = catalog();
    installInterpretation(findings);
    const { container } = renderPlain(<RetryWaste appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />);
    expect(stageButton(3)).toBeInTheDocument();
    expect(container.textContent).toContain('Wasted 40.0s of executor time.');
  });
});

describe('JobFailures', () => {
  const catalog = (): Finding[] => [
    testFinding({ type: 'jobFailureRate', stageId: null, impactBand: 'critical', id: 'jf', value: 25, failedJobs: 2, totalJobs: 8, failedTasks: 10, totalTasks: 100, taskFailureRate: 10 }),
  ];

  it('drops the job counts the sentence states but keeps the rate and the task context', () => {
    const findings = catalog();
    installInterpretation(findings);
    store.getState().setWidgetDensity('advanced');
    const { container } = renderPanel(<JobFailures appModel={emptyAppModel()} catalog={findings} getTaskData={getTaskData} defaultCollapsed={false} />, ['jf']);
    expect(container.textContent).toContain('Failure rate: 25%');
    expect(container.textContent).not.toContain('2 of 8 completed jobs)');
    expect(container.textContent).toContain('Task-failure context: 10 of 100 tasks failed (10%).');
  });

  it('keeps the counts when the finding is not stated, and outside the panel', () => {
    const findings = catalog();
    installInterpretation(findings);
    const panel = renderPanel(<JobFailures appModel={emptyAppModel()} catalog={findings} getTaskData={getTaskData} defaultCollapsed={false} />, []);
    expect(panel.container.textContent).toContain('Failure rate: 25% (2 of 8 completed jobs)');
    panel.unmount();
    const plain = renderPlain(<JobFailures appModel={emptyAppModel()} catalog={findings} getTaskData={getTaskData} defaultCollapsed={false} />);
    expect(plain.container.textContent).toContain('Failure rate: 25% (2 of 8 completed jobs)');
  });
});

describe('ColdStart', () => {
  const catalog = (): Finding[] => [
    testFinding({ type: 'coldStart', stageId: null, impactBand: 'warning', id: 'cs-1', value: 45 }),
    testFinding({ type: 'coldStart', stageId: null, impactBand: 'info', id: 'cs-2', value: 20 }),
  ];

  it('renders no row for a stated finding; the other finding keeps its wait', () => {
    const findings = catalog();
    installInterpretation(findings);
    const { container } = renderPanel(<ColdStart appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />, ['cs-1']);
    expect(screen.queryByText('45s')).not.toBeInTheDocument();
    expect(screen.getByText('20s')).toBeInTheDocument();
    expect(container.querySelectorAll('li')).toHaveLength(1);
  });

  it('is unchanged outside the panel', () => {
    const findings = catalog();
    installInterpretation(findings);
    renderPlain(<ColdStart appModel={emptyAppModel()} catalog={findings} defaultCollapsed={false} />);
    expect(screen.getByText('45s')).toBeInTheDocument();
    expect(screen.getByText('20s')).toBeInTheDocument();
  });
});

describe('IncompleteRun', () => {
  const catalog = (): Finding[] => [
    testFinding({ type: 'incompleteRun', stageId: null, impactBand: 'warning', id: 'ir', recommendation: 'This event log never recorded an ApplicationEnd event.' }),
  ];

  it('renders no body for a stated finding', () => {
    const findings = catalog();
    installInterpretation(findings);
    const { container } = renderPanel(<IncompleteRun appModel={emptyAppModel()} catalog={findings} getTaskData={getTaskData} defaultCollapsed={false} />, ['ir']);
    expect(container.textContent).not.toContain('ApplicationEnd event');
  });

  it('keeps the event line and the recommendation when not stated, and outside the panel', () => {
    const findings = catalog();
    installInterpretation(findings);
    const panel = renderPanel(<IncompleteRun appModel={emptyAppModel()} catalog={findings} getTaskData={getTaskData} defaultCollapsed={false} />, []);
    expect(panel.container.textContent).toContain('ApplicationEnd event: missing');
    panel.unmount();
    const plain = renderPlain(<IncompleteRun appModel={emptyAppModel()} catalog={findings} getTaskData={getTaskData} defaultCollapsed={false} />);
    expect(plain.container.textContent).toContain('ApplicationEnd event: missing');
    expect(plain.container.textContent).toContain('This event log never recorded an ApplicationEnd event.');
  });
});

describe('AutoscalingChurn', () => {
  const appModel = (): AppModel => ({
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 120_000 } as AppModel['app'],
    executors: {
      added: [{ timestamp: 0 }, { timestamp: 60_000 }] as unknown as AppModel['executors']['added'],
      removed: [{ timestamp: 90_000 }] as unknown as AppModel['executors']['removed'],
    },
  });
  const catalog = (): Finding[] => [testFinding({ type: 'autoscalingChurn', stageId: null, impactBand: 'warning', id: 'ac', value: 60 })];

  it('drops the short-lived share for a stated finding but keeps the tuning link and the chart', () => {
    const findings = catalog();
    installInterpretation(findings);
    const { container } = renderPanel(<AutoscalingChurn appModel={appModel()} catalog={findings} defaultCollapsed={false} />, ['ac']);
    expect(container.textContent).not.toContain('Short-lived share of removed executors');
    expect(screen.getByRole('link', { name: /Tuning executorIdleTimeout/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /added and remove/i })).toBeInTheDocument();
  });

  it('keeps the share when not stated, and outside the panel', () => {
    const findings = catalog();
    installInterpretation(findings);
    const panel = renderPanel(<AutoscalingChurn appModel={appModel()} catalog={findings} defaultCollapsed={false} />, []);
    expect(panel.container.textContent).toContain('Short-lived share of removed executors: 60%');
    panel.unmount();
    const plain = renderPlain(<AutoscalingChurn appModel={appModel()} catalog={findings} defaultCollapsed={false} />);
    expect(plain.container.textContent).toContain('Short-lived share of removed executors: 60%');
  });
});

describe('ExecutorUtilization', () => {
  const measured = { appDurationMs: 10_000, totalCores: 2, allocatedCoreMs: 100_000, cpuUtilizationPct: 12 };
  const catalog = (): Finding[] => [
    testFinding({ type: 'utilization', stageId: null, impactBand: 'warning', id: 'u-1', value: 30, utilizationFraction: 0.3, metric: 'avgUtilization', ...measured }),
    testFinding({ type: 'utilization', stageId: null, impactBand: 'info', id: 'u-2', value: 55, utilizationFraction: 0.55, metric: 'avgUtilization', ...measured }),
  ];

  it('drops the stated average but keeps the core-time breakdown; the other finding keeps its figure', () => {
    const findings = catalog();
    installInterpretation(findings);
    renderPanel(<ExecutorUtilization catalog={findings} defaultCollapsed={false} />, ['u-1']);
    expect(screen.queryByText('30%')).not.toBeInTheDocument();
    expect(screen.getByText(/2 cores at peak over 10\.0s: 100\.0 core-s allocated, 30\.0 core-s busy, 70\.0 core-s idle\. CPU time was 12% of the allocation\./)).toBeInTheDocument();
    expect(screen.getByText('55%')).toBeInTheDocument();
  });

  it('is unchanged outside the panel', () => {
    const findings = catalog();
    installInterpretation(findings);
    renderPlain(<ExecutorUtilization catalog={findings} defaultCollapsed={false} />);
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.getByText('55%')).toBeInTheDocument();
    expect(screen.queryByText(/cores at peak/)).not.toBeInTheDocument();
  });
});

describe('MemoryUtilization', () => {
  const catalog = (): Finding[] => [
    testFinding({ type: 'memoryUtilization', variant: 'idleCores', stageId: null, impactBand: 'warning', id: 'm-idle', metric: 'idleCoreRate', value: 75, allocatedMBSeconds: 40_000 }),
    testFinding({ type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned', stageId: null, executorId: '7', impactBand: 'info', id: 'm-band', metric: 'heapUsedRatio', value: 20, heap: 1024 ** 3, allocatedBytes: 5 * 1024 ** 3, executorCount: 4, recommendation: 'The busiest of 4 sampled executors peaked at 20% of allocated heap: reduce it.' }),
    testFinding({ type: 'memoryUtilization', variant: 'wasteModel', stageId: null, impactBand: 'info', id: 'm-waste', metric: 'wastedMBSeconds', value: 12345, allocatedMBSeconds: 50_000 }),
  ];

  it('drops the stated figures and keeps the measurements behind each', () => {
    const findings = catalog();
    installInterpretation(findings);
    store.getState().setWidgetDensity('advanced');
    const { container } = renderPanel(<MemoryUtilization catalog={findings} defaultCollapsed={false} />, ['m-idle', 'm-band', 'm-waste']);
    expect(screen.getByText('Executor 7')).toBeInTheDocument();
    expect(container.textContent).not.toContain('of available core-time idle');
    expect(container.textContent).not.toContain('of allocated heap used');
    expect(container.textContent).not.toContain('The busiest of 4 sampled executors');
    expect(container.textContent).not.toContain('wasted');
    expect(container.textContent).toContain('40,000 MB-s of executor memory-time allocated.');
    expect(container.textContent).toMatch(/Peak heap .* of .* allocated, across 4 sampled executors\./);
    expect(container.textContent).toContain('50,000 MB-s of executor memory-time allocated, 37,655 MB-s used.');
  });

  it('keeps every figure of a finding the line above does not state', () => {
    const findings = catalog();
    installInterpretation(findings);
    const { container } = renderPanel(<MemoryUtilization catalog={findings} defaultCollapsed={false} />, ['m-band']);
    expect(container.textContent).toContain('Idle cores');
    expect(container.textContent).toContain('75% of available core-time idle');
    expect(container.textContent).toContain('Memory waste');
    expect(container.textContent).toContain('Executor 7');
    expect(container.textContent).not.toContain('20% of allocated heap used');
  });

  it('is unchanged outside the panel', () => {
    const findings = catalog();
    installInterpretation(findings);
    const { container } = renderPlain(<MemoryUtilization catalog={findings} defaultCollapsed={false} />);
    expect(container.textContent).toContain('20% of allocated heap used: over-provisioned');
    expect(container.textContent).toContain('75% of available core-time idle');
  });
});

describe('RightSizing', () => {
  const catalog = (): Finding[] => [
    testFinding({ type: 'rightSizing', stageId: null, impactBand: 'warning', id: 'rs', value: 8, observedCores: 32, observedActiveMs: 600_000, modeledActiveMs: 640_000, modelErrorPct: 4 }),
  ];

  it('renders no row for a stated finding at Basic, and only the model error at Advanced', () => {
    const findings = catalog();
    installInterpretation(findings);
    const basic = renderPanel(<RightSizing catalog={findings} defaultCollapsed={false} />, ['rs']);
    expect(basic.container.textContent).not.toContain('would be enough');
    expect(basic.container.textContent).not.toContain('Model error');
    basic.unmount();
    store.getState().setWidgetDensity('advanced');
    const advanced = renderPanel(<RightSizing catalog={findings} defaultCollapsed={false} />, ['rs']);
    expect(advanced.container.textContent).toContain('Model error at 32 cores: 4%.');
    expect(advanced.container.textContent).not.toContain('would be enough');
    expect(advanced.container.textContent).not.toContain('The model predicts');
  });

  it('keeps the headline and durations when not stated, and outside the panel', () => {
    const findings = catalog();
    installInterpretation(findings);
    const panel = renderPanel(<RightSizing catalog={findings} defaultCollapsed={false} />, []);
    expect(panel.container.textContent).toContain('8 of 32 cores would be enough');
    panel.unmount();
    const plain = renderPlain(<RightSizing catalog={findings} defaultCollapsed={false} />);
    expect(plain.container.textContent).toContain('8 of 32 cores would be enough');
    expect(plain.container.textContent).toContain('The model predicts');
  });
});

describe('CoreUsageArea', () => {
  const appModel = (): AppModel => ({
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 60_000 } as AppModel['app'],
    stages: new Map<number, unknown>([
      [1, { stageId: 1, submittedAt: 0, completedAt: 60_000, executorRunTime: 120_000, localityStats: [{ locality: 'PROCESS_LOCAL', count: 4 }] }],
    ]) as unknown as AppModel['stages'],
  });
  const catalog = (): Finding[] => [
    testFinding({ type: 'coreLocality', stageId: null, impactBand: 'critical', id: 'cl', metric: 'nonLocalRatio', value: 40, nonLocalTaskCount: 0, recommendation: '40% of tasks (0) ran without process- or node-local data placement.' }),
  ];

  it('drops the non-local line and generic fix for a stated finding but keeps the chart', () => {
    const findings = catalog();
    installInterpretation(findings, appModel());
    const { container } = renderPanel(<CoreUsageArea catalog={findings} defaultCollapsed={false} />, ['cl']);
    expect(container.textContent).not.toContain('40% non-local');
    expect(screen.getByRole('img', { name: /concurrent core usage/i })).toBeInTheDocument();
  });

  it('keeps the non-local line when not stated, and outside the panel', () => {
    const findings = catalog();
    installInterpretation(findings, appModel());
    const panel = renderPanel(<CoreUsageArea catalog={findings} defaultCollapsed={false} />, []);
    expect(panel.container.textContent).toContain('40% non-local');
    panel.unmount();
    const plain = renderPlain(<CoreUsageArea catalog={findings} defaultCollapsed={false} />);
    expect(plain.container.textContent).toContain('40% non-local');
  });
});
