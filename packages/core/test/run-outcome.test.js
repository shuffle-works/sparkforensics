import { describe, it, expect } from 'vitest';
import { FAILURE_REASON_MAX_CHARS, quotesReasonOf, summarizeRunOutcome } from '../src/run-outcome.ts';

function job(id, succeeded, stageIds, exception) {
  return [id, { id, result: succeeded ? 'JobSucceeded' : 'JobFailed', succeeded, stageIds, exception }];
}

function stageFailed(stageId, value) {
  return { type: 'stageFailed', stageId, impactBand: 'critical', value, recommendation: 'Inspect.' };
}

describe('summarizeRunOutcome', () => {
  it("quotes a failed job's own stage before an earlier unrelated stage failure", () => {
    const jobs = new Map([job(1, true, [2]), job(2, false, [5])]);
    const outcome = summarizeRunOutcome(jobs, [stageFailed(2, 'Retried fine'), stageFailed(5, 'Fetch failed\n\tat Frame.run')]);
    expect(outcome).toMatchObject({ failedJobs: 1, totalJobs: 2, reason: 'Fetch failed', reasonStageId: 5 });
  });

  it("falls back to the failed job's exception, and quotes nothing when every job succeeded", () => {
    expect(summarizeRunOutcome(new Map([job(1, false, [3], 'Job aborted')]), []))
      .toMatchObject({ failedJobs: 1, reason: 'Job aborted', reasonStageId: null });
    expect(summarizeRunOutcome(new Map([job(1, true, [2])]), [stageFailed(2, 'Retried fine')]).reason).toBeNull();
  });

  it('shortens a long first line and quotes nothing for a blank one', () => {
    const long = summarizeRunOutcome(new Map([job(1, false, [], 'x'.repeat(FAILURE_REASON_MAX_CHARS + 10))]), []);
    expect(long.reason).toHaveLength(FAILURE_REASON_MAX_CHARS);
    expect(long.reason.endsWith('...')).toBe(true);
    expect(summarizeRunOutcome(new Map([job(1, false, [], '\nat Frame.run')]), []).reason).toBeNull();
  });
});

describe('quotesReasonOf', () => {
  it('ties a job-failure finding to the reason only when exactly one job failed', () => {
    const jobFailure = { type: 'jobFailureRate', stageId: null, impactBand: 'critical', recommendation: 'Inspect.' };
    const one = summarizeRunOutcome(new Map([job(1, false, [5])]), [stageFailed(5, 'Fetch failed')]);
    expect(quotesReasonOf(jobFailure, one)).toBe(true);
    const two = summarizeRunOutcome(new Map([job(1, false, [5]), job(2, false, [6])]), [stageFailed(5, 'Fetch failed')]);
    expect(quotesReasonOf(jobFailure, two)).toBe(false);
  });
});
