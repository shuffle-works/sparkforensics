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
        { rule: 'gc', baseCount: 0, candCount: 2 },
        // skew moved from critical to warning: +1 warning, -1 critical, net 0.
        { rule: 'skew', baseCount: 0, candCount: 1 },
      ],
      resolved: [
        { rule: 'skew', baseCount: 1, candCount: 0 },
        { rule: 'spill', baseCount: 3, candCount: 1 },
      ],
    });
    expect(sentences).toContain('New or more frequent in run B: Garbage collection pressure.');
    expect(sentences).toContain('Less frequent in run B: Memory and disk spill.');
    expect(sentences.join(' ')).not.toContain('Task skew');
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

  it('has no drill-in button when there is nowhere to drill into', () => {
    render(<RunComparison model={model as any} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /see where to start in run b/i })).not.toBeInTheDocument();
  });
});
