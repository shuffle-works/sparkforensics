import { describe, it, expect } from 'vitest';
import { FINDING_NAMES, findingName, recommendationParts, titleCase } from '../src/finding-names.js';
import { FINDING_PRESENTATION } from '../src/finding-presentation.js';

describe('FINDING_NAMES', () => {
  it('is read off FINDING_PRESENTATION', () => {
    expect(FINDING_NAMES.configAudit).toBe(FINDING_PRESENTATION.configAudit.name);
    expect(FINDING_NAMES.underBroadcast).toBe('missed broadcast join');
    expect(FINDING_NAMES).not.toHaveProperty('broadcastSizing');
  });
});

describe('findingName', () => {
  it('falls back to the raw type for a type with no presentation row', () => {
    expect(findingName('skew')).toBe('task skew');
    expect(findingName('notARealDetector')).toBe('notARealDetector');
  });
});

describe('titleCase', () => {
  it('capitalizes the first letter of each word, leaving other casing untouched', () => {
    expect(titleCase('task skew')).toBe('Task Skew');
    expect(titleCase('GC pressure')).toBe('GC Pressure');
    expect(titleCase('shuffle I/O')).toBe('Shuffle I/O');
    expect(titleCase('missed broadcast join')).toBe('Missed Broadcast Join');
  });
});

describe('recommendationParts', () => {
  it('splits a recommendation at its last ": " so a quoted error stays in the measurement', () => {
    expect(recommendationParts('GC consumed only 3.9% of executor run time: reduce spark.executor.memory.'))
      .toEqual({ measured: 'GC consumed only 3.9% of executor run time', fix: 'reduce spark.executor.memory.' });
    expect(recommendationParts('5% of tasks failed (dominant error: FetchFailed): investigate driver logs.'))
      .toEqual({ measured: '5% of tasks failed (dominant error: FetchFailed)', fix: 'investigate driver logs.' });
    expect(recommendationParts('Read by 3 queries. Cache the shared DataFrame.')).toEqual({ measured: null, fix: 'Read by 3 queries. Cache the shared DataFrame.' });
  });
});
