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


describe('summarizeComparison with comparability', () => {
  const agree = {
    noiseBand: 0.02,
    conf: { equal: true, differences: [], ignoredKeys: [], withheldKeys: [] },
    plan: { equal: true, unmatched: { baseline: 0, candidate: 0 }, replanned: 0 },
    volume: { inputBytes: {}, outputRows: {}, outputBytes: {}, equal: true },
    capacity: { baseline: {}, candidate: {} },
    caveats: { executors: null, unmatchedStages: null, taskCount: null, queue: null },
    wallClockBridge: {
      wallClock: { baseline: 100, candidate: 149, ratio: 1.49 },
      taskTime: { baseline: 100, candidate: 82, ratio: 0.82 },
      meanExecutors: { baseline: 57, candidate: 32.6, ratio: 0.57 },
      taskShareOfAllocation: { baseline: 0.5, candidate: 0.48, ratio: 0.96 },
      explainedWallClock: 1.49,
    },
  };
  const slower = [metric('wallClock', 'Wall-clock duration', 100_000, 149_000, 'regression')];
  const failed = { baseline: { failedJobs: 0, totalJobs: 5 }, candidate: { failedJobs: 2, totalJobs: 5 } };

  it('keeps the four-tone verdict without the comparability block', () => {
    expect(summarizeComparison(slower, noFindings).tone).toBe('worse');
  });

  it('lets a failed job lead over equivalence', () => {
    expect(summarizeComparison(slower, noFindings, failed, agree).tone).toBe('worse');
  });

  it('leaves an incomplete log neutral', () => {
    const verdict = summarizeComparison(slower, noFindings, {
      baseline: { failedJobs: 0, totalJobs: 5 }, candidate: { failedJobs: 0, totalJobs: 5, incomplete: true },
    }, agree);
    expect(verdict.tone).toBe('unknown');
  });

  it('does not read unknown configuration, a differing plan or differing volume as equivalent', () => {
    for (const change of [
      { conf: { ...agree.conf, equal: null } },
      { plan: { ...agree.plan, equal: false } },
      { volume: { ...agree.volume, equal: false } },
      { volume: { ...agree.volume, equal: null } },
    ]) {
      expect(summarizeComparison(slower, noFindings, undefined, { ...agree, ...change }).tone).toBe('worse');
    }
  });

  it('keeps the wall-clock tone and calls the gap unexplained when no capacity factor moved', () => {
    const still = { ratio: 1 };
    const unexplained = { ...agree, wallClockBridge: { ...agree.wallClockBridge, taskTime: still, meanExecutors: still, taskShareOfAllocation: still } };
    const verdict = summarizeComparison(slower, noFindings, undefined, unexplained);
    expect(verdict.tone).toBe('worse');
    expect(verdict.title).toBe('Same configuration, plan and output. Time differs by 49.0s (49%), and no measured factor explains it.');
  });

  it('says output was not compared and keeps the wall-clock tone when no output figure exists', () => {
    const verdict = summarizeComparison(slower, noFindings, undefined, { ...agree, volume: { ...agree.volume, equal: null } });
    expect(verdict.tone).toBe('worse');
    expect(verdict.title).toMatch(/^Same configuration and plan\. Output was not compared\. Time differs by 49\.0s \(49%\): executors averaged/);
  });

  it('says the wall-clock change is executor availability when mean executors differ past the threshold', () => {
    const plan = { ...agree.plan, equal: false };
    const caveats = { ...agree.caveats, executors: { baseline: 217.2, candidate: 91 } };
    const verdict = summarizeComparison(slower, noFindings, undefined, { ...agree, plan, caveats });
    expect(verdict.sentences).toContain('Mean executors went from 217 to 91, so much of the wall-clock change is executor availability, not the job.');
    const flat = [metric('wallClock', 'Wall-clock duration', 100_000, 100_500, 'regression')];
    expect(summarizeComparison(flat, noFindings, undefined, { ...agree, plan, caveats }).sentences.join(' ')).not.toContain('Mean executors');
  });

  it('names a YARN queue difference, an unset side included', () => {
    const conf = { ...agree.conf, equal: false, differences: [{ key: 'spark.yarn.queue', baseline: null, candidate: 'root.b' }] };
    const caveats = { ...agree.caveats, queue: { baseline: null, candidate: 'root.b' } };
    const verdict = summarizeComparison(slower, noFindings, undefined, { ...agree, conf, caveats });
    expect(verdict.sentences).toContain('The YARN queue differs: unset in the baseline, root.b in the candidate.');
  });

  it('says the plans differ with the unmatched run-time share and the task count change', () => {
    const plan = { ...agree.plan, equal: false };
    const caveats = {
      ...agree.caveats,
      unmatchedStages: { count: 75, of: 264, runtimeShare: 0.12 },
      taskCount: { baseline: 217_607, candidate: 121_679, change: -0.44 },
    };
    const verdict = summarizeComparison(slower, noFindings, undefined, { ...agree, plan, caveats });
    expect(verdict.sentences).toContain("The plans differ: 75 of 264 baseline stages have no match, holding 12% of the baseline's executor run time, and the task count fell 44%. Compare with care.");
    const countOnly = { ...agree.caveats, taskCount: { baseline: 100, candidate: 140, change: 0.4 } };
    expect(summarizeComparison(slower, noFindings, undefined, { ...agree, plan, caveats: countOnly }).sentences)
      .toContain('The plans differ: the task count rose 40%. Compare with care.');
  });

  it('uses the metric rows own noise flag, so a wider caller band reads as the same time', () => {
    const wide = [{ ...slower[0], withinNoise: true }];
    expect(summarizeComparison(wide, noFindings).tone).toBe('same');
  });
});
