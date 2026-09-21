import { describe, it, expect } from 'vitest';
import { checkConcurrentJobGroups } from '../src/job-groups.js';

function jobsMap(list) { return new Map(list.map(j => [j.id, j])); }

describe('checkConcurrentJobGroups', () => {
  it('reports reliable when two SQL-execution groups do not overlap', () => {
    const jobs = jobsMap([
      { id: 0, submissionTime: 0, completionTime: 1000, sqlExecutionId: 1 },
      { id: 1, submissionTime: 1000, completionTime: 2000, sqlExecutionId: 2 },
    ]);
    expect(checkConcurrentJobGroups(jobs).wallClockReliable).toBe(true);
  });

  it('reports unreliable when two different groups overlap', () => {
    const jobs = jobsMap([
      { id: 0, submissionTime: 0, completionTime: 1500, sqlExecutionId: 1 },
      { id: 1, submissionTime: 1000, completionTime: 2000, sqlExecutionId: 2 },
    ]);
    const r = checkConcurrentJobGroups(jobs);
    expect(r.wallClockReliable).toBe(false);
    expect(r.overlappingGroupIds.length).toBeGreaterThan(0);
  });

  it('does NOT flag jobs within the same group overlapping (AQE/multi-stage)', () => {
    const jobs = jobsMap([
      { id: 0, submissionTime: 0, completionTime: 1500, sqlExecutionId: 5 },
      { id: 1, submissionTime: 500, completionTime: 2000, sqlExecutionId: 5 },
    ]);
    expect(checkConcurrentJobGroups(jobs).wallClockReliable).toBe(true);
  });

  it('treats jobs with no SQL execution id as singleton groups', () => {
    const jobs = jobsMap([
      { id: 0, submissionTime: 0, completionTime: 1500, sqlExecutionId: null },
      { id: 1, submissionTime: 1000, completionTime: 2000, sqlExecutionId: null },
    ]);
    expect(checkConcurrentJobGroups(jobs).wallClockReliable).toBe(false);
  });

  it('is reliable for an empty or single-group run', () => {
    expect(checkConcurrentJobGroups(new Map()).wallClockReliable).toBe(true);
  });
});
