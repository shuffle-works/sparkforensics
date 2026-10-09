// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RunComparison } from '@/view/RunComparison';

const d = (baseline: number, candidate: number) => ({ baseline, candidate, delta: candidate - baseline });
const zero = d(0, 0);

function pair(pairId: string, baseId: number, candId: number, quality: string, score: number, runTime: [number, number], extra: Record<string, unknown> = {}) {
  return {
    pairId, baseStageIds: [baseId], candStageIds: [candId], quality, score,
    deltas: {
      executorRunTime: d(...runTime), executorCpuTime: zero, memoryBytesSpilled: zero, diskBytesSpilled: zero,
      inputBytes: zero, outputBytes: zero, shuffleReadBytes: zero, shuffleWriteBytes: zero, ...extra,
    },
  };
}

const metrics = (executorRunTime: number) => ({
  duration: executorRunTime, memoryBytesSpilled: 0, diskBytesSpilled: 0, jvmGCTime: 0, inputBytes: 0, outputBytes: 0,
  executorRunTime, taskCount: 4, failedTasks: 0,
});
const stage = (id: number, name: string, runTime: number) => ({ id, name, metrics: metrics(runTime) });

const model = {
  baselineLabel: 'base.log', candidateLabel: 'cand.log',
  confidence: 'ok', reason: null, runtimeCoverage: 1,
  metrics: [{ key: 'wallClock', label: 'Wall-clock duration', baseline: 20_000, candidate: 15_000, delta: -5_000, direction: 'improvement' }],
  findings: { introduced: [], resolved: [] },
  stageSkew: [],
  baseStages: [stage(1, 'small stage', 1_000), stage(2, 'big stage', 60_000), stage(5, 'left over 5', 4_000), stage(6, 'left over 6', 5_000), stage(7, 'only in baseline', 800)],
  candStages: [stage(11, 'small stage', 1_100), stage(12, 'big stage', 30_000), stage(8, 'left over 8', 4_000)],
  stagePairs: [
    pair('b1-c11', 1, 11, 'exact', 1, [1_000, 1_100]),
    pair('b2-c12', 2, 12, 'aligned', 0.62, [60_000, 30_000], { diskBytesSpilled: d(2048, 0), outputBytes: d(10, 99) }),
  ],
  unmatched: { baseStageIds: [7], candStageIds: [] },
  replanned: [{
    baseExecutionId: 3, candExecutionId: 4, baseStageIds: [5, 6], candStageIds: [8],
    deltas: { ...pair('x', 0, 0, 'exact', 1, [9_000, 4_000]).deltas },
  }],
};

describe('StageComparisonTable', () => {
  it('sorts pairs by absolute run-time change and shows quality and score', () => {
    render(<RunComparison model={model as any} onClose={vi.fn()} />);
    const rows = screen.getAllByTestId('stage-pair-row');
    expect(rows.map((r) => r.getAttribute('data-quality'))).toEqual(['aligned', 'exact']);
    expect(within(rows[0]).getByText('aligned · 0.62')).toBeInTheDocument();
    expect(within(rows[0]).getByText('-30.0s')).toBeInTheDocument();
    expect(within(rows[0]).getByText('-2 KB')).toBeInTheDocument();
    expect(within(rows[1]).getByText('exact · 1.00')).toBeInTheDocument();
  });

  it('shows both runs of a pair side by side without leaving the comparison', async () => {
    const user = userEvent.setup();
    const onDrillIn = vi.fn();
    render(<RunComparison model={model as any} onClose={vi.fn()} onDrillIn={onDrillIn} />);
    await user.click(screen.getByRole('button', { name: 'Compare big stage in both runs' }));
    const dialog = await screen.findByTestId('stage-pair-dialog');
    expect(dialog).toHaveTextContent('aligned match, score 0.62');
    expect(within(dialog).getByText('Baseline · stage 2')).toBeInTheDocument();
    expect(within(dialog).getByText('Candidate · stage 12')).toBeInTheDocument();
    expect(within(dialog).getByRole('row', { name: 'Executor run-time' })).toHaveTextContent('1m 0s30.0s-30.0s');
    expect(onDrillIn).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Open stage 12 in the candidate dashboard' }));
    expect(onDrillIn).toHaveBeenLastCalledWith('candidate', 12);
    await user.click(within(dialog).getByRole('button', { name: 'Open stage 2 in the baseline dashboard' }));
    expect(onDrillIn).toHaveBeenLastCalledWith('baseline', 2);
  });

  it('lists re-planned groups and unmatched stages and opens them in the same dialog', async () => {
    const user = userEvent.setup();
    render(<RunComparison model={model as any} onClose={vi.fn()} onDrillIn={vi.fn()} />);
    const replanned = screen.getByTestId('replanned-stages');
    expect(replanned).toHaveTextContent('Query 3 → 4');
    expect(replanned).toHaveTextContent('Run time: 9.0s → 4.0s');
    await user.click(within(replanned).getByRole('button', { name: /Baseline left over 5 \(5\), left over 6 \(6\) · Candidate left over 8 \(8\)/ }));
    const dialog = await screen.findByTestId('stage-pair-dialog');
    expect(within(dialog).getByText('Baseline · stage 6')).toBeInTheDocument();
    expect(within(dialog).getByText('Candidate · stage 8')).toBeInTheDocument();
    expect(within(dialog).queryByText('Candidate · stage 9')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(within(screen.getByTestId('unmatched-stages')).getByRole('button', { name: /Baseline only in baseline \(7\) · Candidate none/ }));
    expect(await screen.findByText('Baseline · stage 7')).toBeInTheDocument();
  });

  it('labels the metrics columns Baseline and Candidate and keeps the full run names in a tooltip', () => {
    const long = { ...model, baselineLabel: 'a-very-long-baseline-event-log-file-name.ndjson', candidateLabel: 'a-very-long-candidate-event-log-file-name.ndjson' };
    render(<RunComparison model={long as any} onClose={vi.fn()} />);
    const header = screen.getByRole('columnheader', { name: 'Baseline' });
    expect(header).toHaveAttribute('title', long.baselineLabel);
    expect(screen.getByRole('columnheader', { name: 'Candidate' })).toHaveAttribute('title', long.candidateLabel);
  });

  it('says so when nothing paired, and omits the table for a model without pairs', () => {
    const none = { ...model, stagePairs: [], replanned: [], unmatched: { baseStageIds: [1], candStageIds: [2] }, confidence: 'insufficient', reason: 'Too little run time.' };
    const { unmount } = render(<RunComparison model={none as any} onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveAttribute('data-confidence', 'insufficient');
    expect(screen.getByText(/No stages are paired: no stage in one run is similar enough/)).toBeInTheDocument();
    unmount();
    const { stagePairs: _omit, ...legacy } = model;
    render(<RunComparison model={legacy as any} onClose={vi.fn()} />);
    expect(screen.queryByText('Stages compared')).not.toBeInTheDocument();
  });

  it('offers a stage picker with names and ids when nothing paired, and opens the chosen pair', async () => {
    const user = userEvent.setup();
    const none = { ...model, stagePairs: [], replanned: [model.replanned[0]], unmatched: { baseStageIds: [7], candStageIds: [] } };
    render(<RunComparison model={none as any} onClose={vi.fn()} onDrillIn={vi.fn()} />);
    expect(screen.getByText(/planned these queries into a different number of stages/)).toBeInTheDocument();
    const picker = screen.getByTestId('stage-picker');
    const compare = within(picker).getByRole('button', { name: 'Compare pair' });
    expect(compare).toBeDisabled();
    expect(within(picker).getByRole('option', { name: 'Stage 2 · big stage' })).toBeInTheDocument();
    await user.selectOptions(within(picker).getByLabelText('Baseline stage'), '2');
    expect(compare).toBeDisabled();
    await user.selectOptions(within(picker).getByLabelText('Candidate stage'), '12');
    await user.click(compare);
    const dialog = await screen.findByTestId('stage-pair-dialog');
    expect(within(dialog).getByText('Baseline · stage 2')).toBeInTheDocument();
    expect(within(dialog).getByText('Candidate · stage 12')).toBeInTheDocument();
  });

  it('shows no picker when pairs exist', () => {
    render(<RunComparison model={model as any} onClose={vi.fn()} />);
    expect(screen.queryByTestId('stage-picker')).not.toBeInTheDocument();
  });

  it('reveals further rows in chunks', async () => {
    const user = userEvent.setup();
    const many = { ...model, replanned: [], unmatched: { baseStageIds: [], candStageIds: [] },
      stagePairs: Array.from({ length: 30 }, (_, i) => pair(`p${i}`, i, i, 'exact', 1, [100, 100 + i])) };
    render(<RunComparison model={many as any} onClose={vi.fn()} />);
    expect(screen.getAllByTestId('stage-pair-row')).toHaveLength(25);
    await user.click(screen.getByRole('button', { name: /show 5 more/i }));
    expect(screen.getAllByTestId('stage-pair-row')).toHaveLength(30);
  });
});
