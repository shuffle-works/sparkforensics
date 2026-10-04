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

const model = {
  baselineLabel: 'base.log', candidateLabel: 'cand.log',
  confidence: 'ok', reason: null, runtimeCoverage: 1,
  metrics: [{ key: 'wallClock', label: 'Wall-clock duration', baseline: 20_000, candidate: 15_000, delta: -5_000, direction: 'improvement' }],
  findings: { introduced: [], resolved: [] },
  stageSkew: [],
  baseStages: [{ id: 1, name: 'small stage' }, { id: 2, name: 'big stage' }],
  candStages: [{ id: 11, name: 'small stage' }, { id: 12, name: 'big stage' }],
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

  it('opens the paired stage in the chosen run', async () => {
    const user = userEvent.setup();
    const onDrillIn = vi.fn();
    render(<RunComparison model={model as any} onClose={vi.fn()} onDrillIn={onDrillIn} />);
    const [row] = screen.getAllByTestId('stage-pair-row');
    await user.click(within(row).getByRole('button', { name: 'Open stage 12 in the candidate run' }));
    expect(onDrillIn).toHaveBeenLastCalledWith('candidate', 12);
    await user.click(within(row).getByRole('button', { name: 'Open stage 2 in the baseline run' }));
    expect(onDrillIn).toHaveBeenLastCalledWith('baseline', 2);
  });

  it('lists re-planned groups and unmatched stages with drill-in links', async () => {
    const user = userEvent.setup();
    const onDrillIn = vi.fn();
    render(<RunComparison model={model as any} onClose={vi.fn()} onDrillIn={onDrillIn} />);
    const replanned = screen.getByTestId('replanned-stages');
    expect(replanned).toHaveTextContent('Query 3 → 4');
    expect(replanned).toHaveTextContent('Run time: 9.0s → 4.0s');
    await user.click(within(replanned).getByRole('button', { name: 'Open stage 6 in the baseline run' }));
    expect(onDrillIn).toHaveBeenLastCalledWith('baseline', 6);
    const unmatched = screen.getByTestId('unmatched-stages');
    expect(within(unmatched).getByRole('button', { name: 'Open stage 7 in the baseline run' })).toBeInTheDocument();
  });

  it('says so when nothing paired, and omits the table for a model without pairs', () => {
    const none = { ...model, stagePairs: [], replanned: [], unmatched: { baseStageIds: [1], candStageIds: [2] }, confidence: 'insufficient', reason: 'Too little run time.' };
    const { unmount } = render(<RunComparison model={none as any} onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveAttribute('data-confidence', 'insufficient');
    expect(screen.getByText('No stages are paired between the two runs.')).toBeInTheDocument();
    unmount();
    const { stagePairs: _omit, ...legacy } = model;
    render(<RunComparison model={legacy as any} onClose={vi.fn()} />);
    expect(screen.queryByText('Stages compared')).not.toBeInTheDocument();
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
