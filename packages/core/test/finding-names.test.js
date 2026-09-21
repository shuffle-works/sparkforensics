import { describe, it, expect } from 'vitest';
import { FINDING_NAMES, titleCase } from '../src/finding-names.js';
import { DETECTORS } from '../src/detectors.js';

describe('FINDING_NAMES', () => {
  it('has an entry for every DETECTORS type', () => {
    const missing = [...new Set(DETECTORS.map((d) => d.type))].filter((t) => !FINDING_NAMES[t]);
    expect(missing).toEqual([]);
  });

  // broadcastSizing never appears as a real Finding.type (the detector only
  // ever pushes underBroadcast/overBroadcast); the check above can't catch a
  // missing entry for those two, so assert them directly.
  it('has an entry for the real emitted broadcast-sizing finding types', () => {
    expect(FINDING_NAMES.underBroadcast).toBeTruthy();
    expect(FINDING_NAMES.overBroadcast).toBeTruthy();
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
