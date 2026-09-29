import { describe, it, expect } from 'vitest';
import { summarizeComparison } from '../src/comparison-verdict.ts';

function metric(key, label, baseline, candidate, direction) {
  return { key, label, baseline, candidate, delta: candidate - baseline, direction };
}

const noFindings = { introduced: [], resolved: [] };

describe('summarizeComparison', () => {
  it('leads with how much faster or slower the candidate finished', () => {
    expect(summarizeComparison([metric('wallClock', 'Wall-clock duration', 20_000, 15_000, 'improvement')], noFindings))
      .toMatchObject({ title: 'The candidate finished 5.0s faster than the baseline (25%)', tone: 'better' });
    expect(summarizeComparison([metric('wallClock', 'Wall-clock duration', 17_200, 30_100, 'regression')], noFindings))
      .toMatchObject({ title: 'The candidate finished 12.9s slower than the baseline (75%)', tone: 'worse' });
  });

  it('calls a run-time change under 2% about the same', () => {
    expect(summarizeComparison([metric('wallClock', 'Wall-clock duration', 100_000, 101_000, 'regression')], noFindings))
      .toMatchObject({ title: 'The candidate took about as long as the baseline', tone: 'same' });
  });

  it('says so when run time cannot be compared', () => {
    const unavailable = { key: 'wallClock', label: 'Wall-clock duration', baseline: null, candidate: 5, delta: null, direction: 'unavailable' };
    expect(summarizeComparison([unavailable], noFindings).tone).toBe('unknown');
  });

  it('lists cost metrics by direction and leaves volume metrics out', () => {
    const { sentences } = summarizeComparison([
      metric('wallClock', 'Wall-clock duration', 10, 12, 'regression'),
      metric('gcTime', 'GC time', 1, 5, 'regression'),
      metric('diskSpill', 'Disk spill', 9, 2, 'improvement'),
      metric('inputBytes', 'Input read', 10, 99, 'neutral'),
    ], noFindings);
    expect(sentences).toEqual(['Worse in the candidate: GC time.', 'Better in the candidate: Disk spill.']);
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
    expect(sentences).toContain('New or more frequent in the candidate: Garbage collection pressure.');
    expect(sentences).toContain('Less frequent in the candidate: Memory and disk spill.');
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
    expect(sentences).toEqual(['New or more frequent in the candidate: Partition sizing.']);
  });

  it('says nothing about cost metrics when none has values in both runs', () => {
    const unavailable = { key: 'gcTime', label: 'GC time', baseline: null, candidate: null, delta: null, direction: 'unavailable' };
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

  it('leads with a failed candidate, keeping run time as the first sentence', () => {
    const verdict = summarizeComparison(sameTime, noFindings, {
      baseline: { failedJobs: 0, totalJobs: 5 },
      candidate: { failedJobs: 2, totalJobs: 5 },
    });
    expect(verdict).toMatchObject({ title: 'The candidate had 2 of 5 jobs fail (baseline: none)', tone: 'worse' });
    expect(verdict.sentences[0]).toBe('The candidate took about as long as the baseline.');
  });

  it('leads with a failed baseline when the candidate completed', () => {
    expect(summarizeComparison(sameTime, noFindings, {
      baseline: { failedJobs: 1, totalJobs: 4 },
      candidate: { failedJobs: 0, totalJobs: 4 },
    })).toMatchObject({ title: 'The baseline had 1 of 4 jobs fail; the candidate completed', tone: 'better' });
  });

  it('keeps a neutral tone when both runs had as many failed jobs, even if the candidate was faster', () => {
    const verdict = summarizeComparison([metric('wallClock', 'Wall-clock duration', 20_000, 14_000, 'improvement')], noFindings, {
      baseline: { failedJobs: 2, totalJobs: 5 },
      candidate: { failedJobs: 2, totalJobs: 5 },
    });
    expect(verdict).toMatchObject({ title: 'The candidate had 2 of 5 jobs fail (baseline: 2 of 5)', tone: 'same' });
    expect(verdict.sentences[0]).toBe('The candidate finished 6.0s faster than the baseline (30%).');
  });

  it('says a run whose every job failed plainly, not as "1 of 1 jobs"', () => {
    expect(summarizeComparison(sameTime, noFindings, {
      baseline: { failedJobs: 1, totalJobs: 3 },
      candidate: { failedJobs: 1, totalJobs: 1 },
    }).title).toBe("The candidate's only job failed (baseline: 1 of 3)");
    expect(summarizeComparison(sameTime, noFindings, {
      baseline: { failedJobs: 2, totalJobs: 2 },
      candidate: { failedJobs: 3, totalJobs: 3 },
    }).title).toBe("All 3 of the candidate's jobs failed (baseline: all 2 failed)");
    expect(summarizeComparison(sameTime, noFindings, {
      baseline: { failedJobs: 1, totalJobs: 1 },
      candidate: { failedJobs: 0, totalJobs: 1 },
    }).title).toBe("The baseline's only job failed; the candidate completed");
  });

  it('never calls an incomplete run faster: states what each log covers, in a neutral tone', () => {
    const shorter = [metric('wallClock', 'Wall-clock duration', 17_500, 8_400, 'improvement')];
    const verdict = summarizeComparison(shorter, noFindings, {
      baseline: { failedJobs: 0, totalJobs: 3 },
      candidate: { failedJobs: 0, totalJobs: 2, incomplete: true },
    });
    expect(verdict).toMatchObject({ title: "The candidate's log covers 9.1s less run time than the baseline's", tone: 'unknown' });
    expect(verdict.sentences).toContain("The candidate's log has no end-of-run record, so its time covers only what the log captured, not how long the run took.");
    expect(verdict.title).not.toMatch(/faster/);
  });

  it('keeps the run-time headline when both runs completed', () => {
    const verdict = summarizeComparison(sameTime, noFindings, {
      baseline: { failedJobs: 0, totalJobs: 5 },
      candidate: { failedJobs: 0, totalJobs: 5 },
    });
    expect(verdict).toMatchObject({ title: 'The candidate took about as long as the baseline', tone: 'same' });
    expect(verdict.sentences).not.toContain('The candidate took about as long as the baseline.');
  });
});

