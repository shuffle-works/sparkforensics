// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RunComparison } from '@/view/RunComparison';

describe('RunComparison verdict', () => {
  const model = {
    baselineLabel: 'base.log', candidateLabel: 'cand.log',
    confidence: 'ok', reason: null, matchedCoverage: 1,
    metrics: [{ key: 'wallClock', label: 'Wall-clock duration', baseline: 20_000, candidate: 15_000, delta: -5_000, direction: 'improvement' }],
    findings: { introduced: [], resolved: [] },
    stageSkew: [],
  };

  it('puts the answer first and offers run B as the next step', async () => {
    const user = userEvent.setup();
    const onDrillIn = vi.fn();
    render(<RunComparison model={model as any} onClose={vi.fn()} onDrillIn={onDrillIn} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Run B finished 5.0s faster than run A (25%)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /see where to start in run b/i }));
    expect(onDrillIn).toHaveBeenCalledWith('candidate');
  });

  it('heads the verdict with run B\'s failed jobs', () => {
    const failed = { ...model, jobOutcomes: { baseline: { failedJobs: 0, totalJobs: 5 }, candidate: { failedJobs: 2, totalJobs: 5 } } };
    render(<RunComparison model={failed as any} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Run B had 2 of 5 jobs fail (run A: none)' })).toBeInTheDocument();
    expect(screen.getByTestId('comparison-verdict')).toHaveTextContent('Run B finished 5.0s faster than run A (25%).');
  });

  it('has no drill-in button when there is nowhere to drill into', () => {
    render(<RunComparison model={model as any} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /see where to start in run b/i })).not.toBeInTheDocument();
  });
});
