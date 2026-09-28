import { describe, it, expect } from 'vitest';
import { FINDING_NAMES, findingName, titleCase } from '../src/finding-names.js';
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
