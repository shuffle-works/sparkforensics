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

  it('puts the answer first and offers the candidate as the next step', async () => {
    const user = userEvent.setup();
    const onDrillIn = vi.fn();
    render(<RunComparison model={model as any} onClose={vi.fn()} onDrillIn={onDrillIn} />);

    expect(screen.getByRole('heading', { level: 2, name: 'The candidate finished 5.0s faster than the baseline (25%)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /see where to start in the candidate/i }));
    expect(onDrillIn).toHaveBeenCalledWith('candidate');
  });

  it('heads the verdict with the candidate\'s failed jobs', () => {
    const failed = { ...model, jobOutcomes: { baseline: { failedJobs: 0, totalJobs: 5 }, candidate: { failedJobs: 2, totalJobs: 5 } } };
    render(<RunComparison model={failed as any} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2, name: 'The candidate had 2 of 5 jobs fail (baseline: none)' })).toBeInTheDocument();
    expect(screen.getByTestId('comparison-verdict')).toHaveTextContent('The candidate finished 5.0s faster than the baseline (25%).');
  });

  it('has no drill-in button when there is nowhere to drill into', () => {
    render(<RunComparison model={model as any} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /see where to start in the candidate/i })).not.toBeInTheDocument();
  });
});
