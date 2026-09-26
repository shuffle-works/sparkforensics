// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { summarizeComparison, type VerdictMetric } from '@/view/comparison-verdict';
import { RunComparison } from '@/view/RunComparison';

function metric(key: string, label: string, baseline: number, candidate: number, direction: VerdictMetric['direction']): VerdictMetric {
  return { key, label, baseline, candidate, delta: candidate - baseline, direction };
}

const noFindings = { introduced: [], resolved: [] };

describe('summarizeComparison', () => {
  it('leads with how much faster or slower run B finished', () => {
    expect(summarizeComparison([metric('wallClock', 'Wall-clock duration', 20_000, 15_000, 'improvement')], noFindings))
      .toMatchObject({ title: 'Run B finished 5.0s faster than run A (25%)', tone: 'better' });
    expect(summarizeComparison([metric('wallClock', 'Wall-clock duration', 17_200, 30_100, 'regression')], noFindings))
      .toMatchObject({ title: 'Run B finished 12.9s slower than run A (75%)', tone: 'worse' });
  });

  it('calls a run-time change under 2% about the same', () => {
    expect(summarizeComparison([metric('wallClock', 'Wall-clock duration', 100_000, 101_000, 'regression')], noFindings))
      .toMatchObject({ title: 'Run B took about as long as run A', tone: 'same' });
  });

  it('says so when run time cannot be compared', () => {
    const unavailable: VerdictMetric = { key: 'wallClock', label: 'Wall-clock duration', baseline: null, candidate: 5, delta: null, direction: 'unavailable' };
    expect(summarizeComparison([unavailable], noFindings).tone).toBe('unknown');
  });

  it('lists cost metrics by direction and leaves volume metrics out', () => {
    const { sentences } = summarizeComparison([
      metric('wallClock', 'Wall-clock duration', 10, 12, 'regression'),
      metric('gcTime', 'GC time', 1, 5, 'regression'),
      metric('diskSpill', 'Disk spill', 9, 2, 'improvement'),
      metric('inputBytes', 'Input read', 10, 99, 'neutral'),
    ], noFindings);
    expect(sentences).toEqual(['Worse in run B: GC time.', 'Better in run B: Disk spill.']);
  });

  it('nets finding categories across impact bands, so a rule is never both more and less frequent', () => {
    const { sentences } = summarizeComparison([metric('wallClock', 'Wall-clock duration', 10, 10, 'unchanged')], {
      introduced: [
        { type: 'gc', baseCount: 0, candCount: 2 },
        // skew moved from critical to warning: +1 warning, -1 critical, net 0.
        { type: 'skew', baseCount: 0, candCount: 1 },
      ],
      resolved: [
        { type: 'skew', baseCount: 1, candCount: 0 },
        { type: 'spill', baseCount: 3, candCount: 1 },
      ],
    });
    expect(sentences).toContain('New or more frequent in run B: Garbage collection pressure.');
    expect(sentences).toContain('Less frequent in run B: Memory and disk spill.');
    expect(sentences.join(' ')).not.toContain('Task skew');
  });

  it('nets rules that share a category name, so Plan advisor never reads as both', () => {
    const { sentences } = summarizeComparison([metric('wallClock', 'Wall-clock duration', 10, 10, 'unchanged')], {
      introduced: [{ type: 'overBroadcast', baseCount: 0, candCount: 1 }],
      resolved: [{ type: 'smallFiles', baseCount: 2, candCount: 1 }],
    });
    expect(sentences.join(' ')).not.toContain('Plan advisor');
  });

  it('names sub-rule findings by their category, netting sub-rules of one type', () => {
    const { sentences } = summarizeComparison([metric('wallClock', 'Wall-clock duration', 10, 10, 'unchanged')], {
      introduced: [
        { type: 'partitionSizing', baseCount: 0, candCount: 1 },
        { type: 'memoryUtilization', baseCount: 0, candCount: 1 },
      ],
      resolved: [{ type: 'memoryUtilization', baseCount: 1, candCount: 0 }],
    });
    expect(sentences).toEqual(['New or more frequent in run B: Partition sizing.']);
  });

  it('says nothing about cost metrics when none has values in both runs', () => {
    const unavailable: VerdictMetric = { key: 'gcTime', label: 'GC time', baseline: null, candidate: null, delta: null, direction: 'unavailable' };
    const { sentences } = summarizeComparison([metric('wallClock', 'Wall-clock duration', 10, 10, 'unchanged'), unavailable], noFindings);
    expect(sentences).toEqual([]);
  });

  it('leaves cost metrics that moved under 2% out, and says so when all did', () => {
    const { sentences } = summarizeComparison([
      metric('wallClock', 'Wall-clock duration', 100_000, 100_500, 'regression'),
      metric('gcTime', 'GC time', 1_000, 1_010, 'regression'),
      metric('executorRunTime', 'Executor run-time', 50_000, 49_800, 'improvement'),
    ], noFindings);
    expect(sentences).toEqual(['Other measured cost metrics look about the same.']);
  });
});

describe('summarizeComparison with failed jobs', () => {
  const sameTime = [metric('wallClock', 'Wall-clock duration', 100_000, 100_500, 'regression')];

  it('leads with a failed run B, keeping run time as the first sentence', () => {
    const verdict = summarizeComparison(sameTime, noFindings, {
      baseline: { failedJobs: 0, totalJobs: 5 },
      candidate: { failedJobs: 2, totalJobs: 5 },
    });
    expect(verdict).toMatchObject({ title: 'Run B had 2 of 5 jobs fail (run A: none)', tone: 'worse' });
    expect(verdict.sentences[0]).toBe('Run B took about as long as run A.');
  });

  it('leads with a failed run A when run B completed', () => {
    expect(summarizeComparison(sameTime, noFindings, {
      baseline: { failedJobs: 1, totalJobs: 4 },
      candidate: { failedJobs: 0, totalJobs: 4 },
    })).toMatchObject({ title: 'Run A had 1 of 4 jobs fail; run B completed', tone: 'better' });
  });

  it('keeps the run-time headline when both runs completed', () => {
    const verdict = summarizeComparison(sameTime, noFindings, {
      baseline: { failedJobs: 0, totalJobs: 5 },
      candidate: { failedJobs: 0, totalJobs: 5 },
    });
    expect(verdict).toMatchObject({ title: 'Run B took about as long as run A', tone: 'same' });
    expect(verdict.sentences).not.toContain('Run B took about as long as run A.');
  });
});

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
