import { describe, it, expect } from 'vitest';
import { matchesFindingFilterCriteria, singleStageId } from '../src/finding-filter-predicate.ts';

describe('stage criterion', () => {
  it('reads a finding stage from stageId, or from a one-entry stageIds', () => {
    expect(singleStageId({ stageId: 2 })).toBe(2);
    expect(singleStageId({ stageId: null, stageIds: [3] })).toBe(3);
    expect(singleStageId({ stageId: null, stageIds: [3, 4] })).toBeNull();
    expect(singleStageId({ stageId: null })).toBeNull();
  });

  it('matches only on the row\'s own stageId, leaving the dashboard filter bar unchanged', () => {
    const row = { impactBand: 'info', type: 'smallFiles', stageId: null, stageIds: [3] };
    expect(matchesFindingFilterCriteria(row, { stageId: 3 })).toBe(false);
    expect(matchesFindingFilterCriteria({ ...row, stageId: 3 }, { stageId: 3 })).toBe(true);
  });
});
