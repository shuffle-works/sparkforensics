// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { emptyAppModel, store } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { InlineEvidenceContext } from '@/view/InlineEvidenceContext';
import { GcPressure } from '@/view/widgets/GcPressure';
import { PartitionSizing } from '@/view/widgets/PartitionSizing';
import { ShuffleIO } from '@/view/widgets/ShuffleIO';
import { Skew } from '@/view/widgets/Skew';
import { SlowHost } from '@/view/widgets/SlowHost';
import { Spill } from '@/view/widgets/Spill';
import { SpeculationWaste } from '@/view/widgets/SpeculationWaste';
import { StageShape } from '@/view/widgets/StageShape';
import { StageSlowness } from '@/view/widgets/StageSlowness';
import { Straggler } from '@/view/widgets/Straggler';
import { TinyTask } from '@/view/widgets/TinyTask';
import { installInterpretation } from './_shared/interpretation';
import { testFinding } from './_shared/finding';

const MB = 1024 * 1024;

// Fixture stages carry the runtime shape (id, not the Stage type's stageId), cast to AppModel['stages'].
function appModelOf(stages: Record<number, Record<string, unknown>>): AppModel {
  const map = new Map<number, unknown>(Object.entries(stages).map(([id, fields]) => [Number(id), { id: Number(id), ...fields }]));
  return { ...emptyAppModel(), stages: map as unknown as AppModel['stages'] };
}

/** `stated` is the ids the line above the panel states, or null for a widget outside any panel. */
function renderIn(ui: ReactNode, stated: string[] | null) {
  const body = <DocsProvider>{ui}</DocsProvider>;
  return render(
    stated === null
      ? body
      : <InlineEvidenceContext.Provider value={{ stated: new Set(stated) }}>{body}</InlineEvidenceContext.Provider>,
  );
}

const stageButton = (id: number) => screen.queryByRole('button', { name: `Open details for Stage ${id}` });

afterEach(() => store.setState({ widgetDensity: 'basic' }));

describe('Spill in an evidence panel', () => {
  const stages = {
    1: { name: 'sort at A.scala:1', memoryBytesSpilled: 600 * MB, diskBytesSpilled: 100 * MB, spillClassification: 'skew', sqlExecutionId: null },
    2: { name: 'sort at B.scala:2', memoryBytesSpilled: 300 * MB, diskBytesSpilled: 50 * MB, spillClassification: 'skew', sqlExecutionId: null },
  };
  const make = (id: string, stageId: number) => testFinding({
    type: 'spill', id, stageId, impactBand: 'warning', value: 300 * MB,
    spillToInputRatio: 2, wideRows: false, reads: 'input',
    operators: [{ nodeId: '3', name: 'Sort', spillBytes: 300 * MB, arguments: '[k ASC]' }],
  }) as Finding;
  const run = (stated: string[] | null) => {
    const [a, b] = [make('a', 1), make('b', 2)];
    installInterpretation([a, b]);
    return renderIn(<Spill appModel={appModelOf(stages)} catalog={[a, b]} getTaskData={vi.fn()} defaultCollapsed={false} />, stated);
  };

  it('drops the stage chip, the memory spill and the operator and ratio lines of the stated finding only', () => {
    run(['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(stageButton(2)).toBeInTheDocument();
    expect(screen.getAllByText(/Memory spilled:/)).toHaveLength(1);
    expect(screen.getAllByText(/Spilled by/)).toHaveLength(1);
    expect(screen.getAllByText(/Memory spill is 2x/)).toHaveLength(1);
  });

  it('keeps the disk spill and the operator arguments of the stated finding', () => {
    run(['a']);
    expect(screen.getAllByText(/Disk:/)).toHaveLength(2);
    expect(screen.getAllByText(/Sort 3.*\[k ASC\]/)).toHaveLength(2);
  });

  it('keeps everything outside a panel and when the line states none of the findings', () => {
    for (const stated of [null, []]) {
      const { unmount } = run(stated);
      expect(stageButton(1)).toBeInTheDocument();
      expect(screen.getAllByText(/Memory spilled:/)).toHaveLength(2);
      expect(screen.getAllByText(/Spilled by/)).toHaveLength(2);
      unmount();
    }
  });
});

describe('ShuffleIO in an evidence panel', () => {
  const stages = {
    1: { name: 'join at A.scala:1', shuffleReadBytes: 286 * MB, shuffleWriteBytes: 10 * MB, taskCount: 200 },
    2: { name: 'join at B.scala:2', shuffleReadBytes: 100 * MB, shuffleWriteBytes: 5 * MB, taskCount: 100 },
  };
  const make = (id: string, stageId: number, value: number) =>
    testFinding({ type: 'shuffle', id, stageId, impactBand: 'info', value, partitions: 'sufficient' }) as Finding;
  const run = (stated: string[] | null) => {
    const [a, b] = [make('a', 1, 286 * MB), make('b', 2, 100 * MB)];
    installInterpretation([a, b]);
    return renderIn(<ShuffleIO appModel={appModelOf(stages)} catalog={[a, b]} getTaskData={vi.fn()} defaultCollapsed={false} />, stated);
  };

  it('drops the stage chip (pill and header) and the shuffle read of the stated finding, keeping its write and name', () => {
    run(['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    // One pill and one header chip for the stage the line above does not state.
    expect(screen.getAllByRole('button', { name: 'Open details for Stage 2' })).toHaveLength(2);
    expect(screen.getAllByText(/Shuffle read:/)).toHaveLength(1);
    expect(screen.getAllByText(/Write:/)).toHaveLength(2);
    expect(screen.getByText('join at A.scala:1')).toBeInTheDocument();
    expect(screen.getAllByText(/tasks read a median of/)).toHaveLength(1);
  });

  it('renders no pill row when every finding is stated', () => {
    const a = make('a', 1, 286 * MB);
    installInterpretation([a]);
    const { container } = renderIn(<ShuffleIO appModel={appModelOf(stages)} catalog={[a]} getTaskData={vi.fn()} defaultCollapsed={false} />, ['a']);
    expect(container.querySelector('button[aria-label^="Open details"]')).toBeNull();
    expect(container.querySelector('.flex-wrap.items-center.gap-1\\.5')).toBeNull();
  });

  it('keeps everything outside a panel and when the line states none of the findings', () => {
    for (const stated of [null, []]) {
      const { unmount } = run(stated);
      // One pill and one header chip per stage.
      expect(screen.getAllByRole('button', { name: 'Open details for Stage 1' })).toHaveLength(2);
      expect(screen.getAllByText(/Shuffle read:/)).toHaveLength(2);
      expect(screen.queryByText(/tasks read a median of/)).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('PartitionSizing in an evidence panel', () => {
  const stages = { 1: { name: 'agg at A.scala:1', taskCount: 4 }, 2: { name: 'agg at B.scala:2', taskCount: 4 } };
  const skewed = (id: string, stageId: number) =>
    testFinding({ type: 'partitionSizing', id, stageId, impactBand: 'warning', rule: 'shufflePartitionSkew', value: 600 * MB }) as Finding;
  const lowPar = (id: string, stageId: number) =>
    testFinding({ type: 'partitionSizing', id, stageId, impactBand: 'warning', rule: 'lowShuffleParallelism', value: 4 }) as Finding;
  const run = (catalog: Finding[], stated: string[] | null) => {
    installInterpretation(catalog);
    return renderIn(<PartitionSizing appModel={appModelOf(stages)} catalog={catalog} defaultCollapsed={false} />, stated);
  };

  it('drops the stage chip and the label of the stated finding, keeping the other findings on that stage and other stages', () => {
    run([skewed('a', 1), lowPar('b', 1), skewed('c', 2)], ['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(stageButton(2)).toBeInTheDocument();
    expect(screen.getAllByText(/Largest partition/)).toHaveLength(1);
    expect(screen.getAllByText(/tasks carrying the shuffle/)).toHaveLength(1);
    expect(screen.getByText('agg at A.scala:1')).toBeInTheDocument();
  });

  it('leaves the stage name alone when the only finding is stated', () => {
    const { container } = run([skewed('a', 1)], ['a']);
    expect(screen.getByText('agg at A.scala:1')).toBeInTheDocument();
    expect(container.querySelector('ul')).toBeNull();
  });

  it('renders no row for a stated finding on a stage with no name', () => {
    installInterpretation([skewed('a', 1)]);
    const { container } = renderIn(
      <PartitionSizing appModel={appModelOf({ 1: { taskCount: 4 } })} catalog={[skewed('a', 1)]} defaultCollapsed={false} />,
      ['a'],
    );
    expect(container.querySelector('ul')).toBeNull();
    expect(stageButton(1)).not.toBeInTheDocument();
  });

  it('keeps everything outside a panel', () => {
    run([skewed('a', 1), lowPar('b', 1)], null);
    expect(stageButton(1)).toBeInTheDocument();
    expect(screen.getAllByText(/Largest partition/)).toHaveLength(1);
    expect(screen.getAllByText(/tasks carrying the shuffle/)).toHaveLength(1);
  });
});

describe('GcPressure in an evidence panel', () => {
  const stages = { 1: { name: 'agg at A.scala:1', executorRunTime: 60_000 }, 2: { name: 'agg at B.scala:2', executorRunTime: 120_000 } };
  const make = (id: string, stageId: number, value: number) =>
    testFinding({ type: 'gc', id, stageId, impactBand: 'warning', value }) as Finding;
  const run = (stated: string[] | null) => {
    const [a, b] = [make('a', 1, 45), make('b', 2, 30)];
    installInterpretation([a, b]);
    return renderIn(<GcPressure appModel={appModelOf(stages)} catalog={[a, b]} defaultCollapsed={false} />, stated);
  };

  it('drops the stage chip and the GC share of the stated finding, keeping its executor run time', () => {
    run(['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(stageButton(2)).toBeInTheDocument();
    expect(screen.queryByText('45%')).not.toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.getAllByText(/Executor run time:/)).toHaveLength(2);
    expect(screen.getByText('agg at A.scala:1')).toBeInTheDocument();
  });

  it('keeps everything outside a panel', () => {
    run(null);
    expect(stageButton(1)).toBeInTheDocument();
    expect(screen.getByText('45%')).toBeInTheDocument();
  });

  it('renders no header for a stated finding on a stage with no name', () => {
    const a = make('a', 1, 45);
    installInterpretation([a]);
    renderIn(<GcPressure appModel={appModelOf({ 1: { executorRunTime: 60_000 } })} catalog={[a]} defaultCollapsed={false} />, ['a']);
    expect(screen.queryByText('Stage 1')).not.toBeInTheDocument();
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(screen.getByText(/Executor run time:/)).toBeInTheDocument();
  });
});

describe('StageSlowness in an evidence panel', () => {
  const stages = { 1: { name: 'map at A.scala:1' }, 2: { name: 'map at B.scala:2' } };
  const make = (id: string, stageId: number, value: number) =>
    testFinding({ type: 'stageSlowness', id, stageId, impactBand: 'info', value }) as Finding;
  const run = (stated: string[] | null, model = stages) => {
    const [a, b] = [make('a', 1, 20), make('b', 2, 30)];
    installInterpretation([a, b]);
    return renderIn(<StageSlowness appModel={appModelOf(model)} catalog={[a, b]} defaultCollapsed={false} />, stated);
  };

  it('drops the stage chip and the duration of the stated finding, keeping its stage name', () => {
    run(['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(stageButton(2)).toBeInTheDocument();
    expect(screen.queryByText('20m stage duration')).not.toBeInTheDocument();
    expect(screen.getByText('30m stage duration')).toBeInTheDocument();
    expect(screen.getByText('map at A.scala:1')).toBeInTheDocument();
  });

  it('renders no row for a stated finding on a stage with no name', () => {
    const { container } = run(['a'], { 1: {}, 2: { name: 'map at B.scala:2' } } as never);
    expect(container.querySelectorAll('li')).toHaveLength(1);
  });

  it('keeps everything outside a panel', () => {
    run(null);
    expect(stageButton(1)).toBeInTheDocument();
    expect(screen.getByText('20m stage duration')).toBeInTheDocument();
  });
});

describe('Straggler in an evidence panel', () => {
  const stages = { 1: { name: 'map at A.scala:1' }, 2: { name: 'map at B.scala:2' } };
  const make = (id: string, stageId: number) => testFinding({
    type: 'straggler', id, stageId, impactBand: 'info', metric: 'stragglerShare', value: 12, unit: 'pct',
    cause: 'gc', causeSharePct: 60,
  }) as Finding;
  const run = (stated: string[] | null, model = stages) => {
    const [a, b] = [make('a', 1), make('b', 2)];
    installInterpretation([a, b]);
    return renderIn(<Straggler appModel={appModelOf(model)} catalog={[a, b]} getTaskData={() => Promise.reject(new Error('task data is not fetched'))} defaultCollapsed={false} />, stated);
  };

  it('drops the stage chip, the straggler figure and the cause of the stated finding, keeping its stage name', () => {
    run(['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(stageButton(2)).toBeInTheDocument();
    expect(screen.getAllByText(/of tasks straggled/)).toHaveLength(1);
    expect(screen.getAllByText(/GC \(60% of their extra time\)/)).toHaveLength(1);
    expect(screen.getByText('map at A.scala:1')).toBeInTheDocument();
  });

  it('keeps the task duration spread of a stated finding on a stage with no name', () => {
    const { container } = run(['a'], { 1: {}, 2: { name: 'map at B.scala:2' } } as never);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /show task detail/i })).toHaveLength(2);
  });

  it('shows the straggling task count and the stage task spread only in a panel', () => {
    const a = testFinding({
      type: 'straggler', id: 'a', stageId: 1, impactBand: 'info', metric: 'stragglerShare', value: 12, unit: 'pct', stragglerCount: 6,
    }) as Finding;
    installInterpretation([a]);
    const model = appModelOf({ 1: { name: 'map at A.scala:1', taskDurationP50: 100, taskDurationP95: 400, taskDurationMax: 900 } });
    const ui = <Straggler appModel={model} catalog={[a]} getTaskData={() => Promise.reject(new Error('task data is not fetched'))} defaultCollapsed={false} />;
    const { unmount } = renderIn(ui, ['a']);
    expect(screen.getByText("6 straggling tasks, over 4\u00d7 the stage's median task duration.")).toBeInTheDocument();
    expect(screen.getByText(/P50 100ms/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show task detail/i })).toBeInTheDocument();
    unmount();
    renderIn(ui, null);
    expect(screen.queryByText(/straggling tasks/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show task detail/i })).not.toBeInTheDocument();
  });

  it('keeps everything outside a panel', () => {
    run(null);
    expect(stageButton(1)).toBeInTheDocument();
    expect(screen.getAllByText(/GC \(60% of their extra time\)/)).toHaveLength(2);
  });
});

describe('SlowHost in an evidence panel', () => {
  const stages = { 1: { name: 'map at A.scala:1' }, 2: { name: 'map at B.scala:2' } };
  const meanRatio = (id: string, stageId: number) => testFinding({
    type: 'slowHost', id, stageId, impactBand: 'warning', metric: 'hostMeanRatio', value: 3, host: 'host-a', hostTaskShare: 0.2,
  }) as Finding;
  const durationShare = (id: string, stageId: number, host: string) => testFinding({
    type: 'slowHost', id, stageId, impactBand: 'warning', metric: 'hostDurationShare', value: 0.6, host, hostTaskShare: 0.25, variant: 'durationShare',
  }) as Finding;
  const multiDim = (id: string, stageId: number) => testFinding({
    type: 'slowHost', id, stageId, impactBand: 'warning', metric: 'execMaxMedianRatio', value: 4, executorId: '7', dimension: 'inputBytes', variant: 'multiDim',
  }) as Finding;
  const run = (catalog: Finding[], stated: string[] | null, model: Record<number, Record<string, unknown>> = stages) => {
    installInterpretation(catalog);
    return renderIn(<SlowHost appModel={appModelOf(model)} catalog={catalog} defaultCollapsed={false} />, stated);
  };

  it('drops the stage chip but keeps the host figure its sentence does not state', () => {
    run([meanRatio('a', 1), meanRatio('b', 2)], ['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(stageButton(2)).toBeInTheDocument();
    expect(screen.getAllByText(/median task time \(20% of tasks\)/).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps only the share of tasks for a host-duration-share finding', () => {
    run([durationShare('a', 1, 'host-a'), durationShare('b', 2, 'host-b')], ['a']);
    expect(screen.getByText('25% of tasks ran on host-a')).toBeInTheDocument();
    expect(screen.queryByText(/host-a: .* of this stage's task time/)).not.toBeInTheDocument();
    expect(screen.getByText(/host-b: .* of this stage's task time/)).toBeInTheDocument();
  });

  it('keeps only the stage name for a stated executor-deviation finding', () => {
    const { container } = run([multiDim('a', 1), multiDim('b', 2)], ['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(screen.getByText('map at A.scala:1')).toBeInTheDocument();
    expect(screen.getAllByText(/Executor 7:/).length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders no row for a stated executor-deviation finding on a stage with no name', () => {
    const { container } = run([multiDim('a', 1), multiDim('b', 2)], ['a'], { 1: {}, 2: { name: 'map at B.scala:2' } });
    expect(container.querySelectorAll('li')).toHaveLength(1);
  });

  it('shows the deviating executor\'s raw measurement only in a panel', () => {
    const a = testFinding({
      type: 'slowHost', id: 'a', stageId: 1, impactBand: 'warning', metric: 'execMaxMedianRatio', value: 4, executorId: '7', dimension: 'taskTime',
      variant: 'multiDim', execMaxValue: 9000, executorCount: 3, taskCount: 200,
    }) as Finding;
    run([a], ['a']);
    expect(screen.getByText('Executor 7: 9.0s of task time, the most of 3 executors (200 tasks in the stage).')).toBeInTheDocument();
  });

  it('keeps everything outside a panel', () => {
    run([multiDim('a', 1)], null);
    expect(stageButton(1)).toBeInTheDocument();
    expect(screen.getAllByText(/Executor 7:/).length).toBeGreaterThanOrEqual(1);
  });
});

describe('SpeculationWaste in an evidence panel', () => {
  const stages = { 1: { name: 'map at A.scala:1' }, 2: { name: 'map at B.scala:2' } };
  const make = (id: string, stageId: number, value: number) =>
    testFinding({ type: 'speculationWaste', id, stageId, impactBand: 'warning', value }) as Finding;
  const run = (stated: string[] | null, model: Record<number, Record<string, unknown>> = stages) => {
    const [a, b] = [make('a', 1, 120_000), make('b', 2, 300_000)];
    installInterpretation([a, b]);
    return renderIn(<SpeculationWaste appModel={appModelOf(model)} catalog={[a, b]} defaultCollapsed={false} />, stated);
  };

  it('drops the stage chip and the discarded time of the stated finding, keeping its stage name', () => {
    run(['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(stageButton(2)).toBeInTheDocument();
    expect(screen.queryByText(formatDuration(120_000))).not.toBeInTheDocument();
    expect(screen.getByText(formatDuration(300_000))).toBeInTheDocument();
    expect(screen.getByText('map at A.scala:1')).toBeInTheDocument();
  });

  it('shows the speculative task count of the stated finding', () => {
    run(['a'], { 1: { name: 'map at A.scala:1', taskCount: 200, speculativeTasks: 5, speculationWastedAttempts: 6 }, 2: { name: 'map at B.scala:2' } });
    expect(screen.getByText('5 of 200 tasks ran speculatively; 6 attempts were discarded.')).toBeInTheDocument();
  });

  it('keeps everything outside a panel, without the speculative task count', () => {
    run(null, { 1: { name: 'map at A.scala:1', taskCount: 200, speculativeTasks: 5, speculationWastedAttempts: 6 }, 2: { name: 'map at B.scala:2' } });
    expect(stageButton(1)).toBeInTheDocument();
    expect(screen.getByText(formatDuration(120_000))).toBeInTheDocument();
    expect(screen.queryByText(/tasks ran speculatively/)).not.toBeInTheDocument();
  });
});

describe('the stage-finding boards (Skew, StageShape, TinyTask) in an evidence panel', () => {
  const stages = {
    1: { name: 'map at A.scala:1', taskDurationP50: 10, taskDurationP95: 1000, taskDurationMax: 2000 },
    2: { name: 'map at B.scala:2', taskDurationP50: 10, taskDurationP95: 1000, taskDurationMax: 2000 },
  };
  const skew = (id: string, stageId: number, confidence?: string) =>
    testFinding({ type: 'skew', id, stageId, impactBand: 'warning', metric: 'p95/p50', value: 4, confidence }) as Finding;
  const tiny = (id: string, stageId: number) =>
    testFinding({ type: 'tinyTask', id, stageId, impactBand: 'info', metric: 'taskDurationP50', value: 10 }) as Finding;
  const shape = (id: string, stageId: number) =>
    testFinding({ type: 'stageShape', id, stageId, impactBand: 'info', rule: 'dataExplosion', value: 12 }) as Finding;
  const props = (catalog: Finding[]) => ({ appModel: appModelOf(stages), catalog, getTaskData: vi.fn(), defaultCollapsed: false });

  it('Skew drops the stage chip and the label of the stated finding, keeping the task-duration line and the detail toggle', () => {
    const catalog = [skew('a', 1), skew('b', 2)];
    installInterpretation(catalog);
    renderIn(<Skew {...props(catalog)} />, ['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(stageButton(2)).toBeInTheDocument();
    expect(screen.getAllByText(/p95\/p50: 4/)).toHaveLength(1);
    expect(screen.getAllByText(/P50 .* P95 /)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /task detail/i })).toHaveLength(2);
    expect(screen.getByText('map at A.scala:1')).toBeInTheDocument();
  });

  it('Skew keeps the confidence marker of a stated finding at the Advanced density', () => {
    store.setState({ widgetDensity: 'advanced' });
    const catalog = [skew('a', 1, 'low')];
    installInterpretation(catalog);
    renderIn(<Skew {...props(catalog)} />, ['a']);
    expect(screen.getByText(/low confidence/)).toBeInTheDocument();
    expect(screen.queryByText(/p95\/p50: 4/)).not.toBeInTheDocument();
  });

  it('Skew keeps everything outside a panel', () => {
    const catalog = [skew('a', 1), skew('b', 2)];
    installInterpretation(catalog);
    renderIn(<Skew {...props(catalog)} />, null);
    expect(stageButton(1)).toBeInTheDocument();
    expect(screen.getAllByText(/p95\/p50: 4/)).toHaveLength(2);
  });

  it('StageShape drops the label of the stated finding and keeps the other findings on the stage', () => {
    const catalog = [shape('a', 1), tiny('x', 1)];
    installInterpretation(catalog);
    renderIn(<StageShape {...props(catalog)} />, ['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(screen.queryByText(/Data explosion/)).not.toBeInTheDocument();
  });

  it('StageShape keeps its label outside a panel', () => {
    const catalog = [shape('a', 1)];
    installInterpretation(catalog);
    renderIn(<StageShape {...props(catalog)} />, null);
    expect(screen.getByText(/Data explosion/)).toBeInTheDocument();
  });

  it('TinyTask drops its label and the P50 its sentence states, keeping P95 and Max', () => {
    const catalog = [tiny('a', 1), tiny('b', 2)];
    installInterpretation(catalog);
    renderIn(<TinyTask {...props(catalog)} />, ['a']);
    expect(stageButton(1)).not.toBeInTheDocument();
    expect(screen.getAllByText(/across many small tasks/)).toHaveLength(1);
    // One full P50/P95/Max line (stage 2) and one without its P50 (stage 1).
    expect(screen.getAllByText(/P95 /)).toHaveLength(2);
    expect(screen.getAllByText(/P50 .* P95 /)).toHaveLength(1);
  });

  it('TinyTask keeps everything outside a panel', () => {
    const catalog = [tiny('a', 1)];
    installInterpretation(catalog);
    renderIn(<TinyTask {...props(catalog)} />, null);
    expect(screen.getByText(/across many small tasks/)).toBeInTheDocument();
    expect(screen.getByText(/P50 .* P95 /)).toBeInTheDocument();
  });
});
