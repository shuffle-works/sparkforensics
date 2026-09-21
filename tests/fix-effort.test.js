import { describe, it, expect } from 'vitest';
import { DETECTORS } from '@sparkforensics/core/detectors.ts';

describe('fixEffort data model', () => {
  it('every DETECTORS entry has a fixEffort tag', () => {
    const missing = DETECTORS.filter((d) => d.fixEffort === undefined).map((d) => d.type);
    expect(missing).toEqual([]);
  });

  it('fixEffort is always one of the three valid tiers', () => {
    const invalid = DETECTORS.filter(
      (d) => !['config', 'code', 'rearchitect'].includes(d.fixEffort),
    );
    expect(invalid).toEqual([]);
  });

  it('informational-only types still carry a fixEffort tag', () => {
    const informationalTypes = ['configAudit', 'stageFailed', 'failures', 'incompleteRun'];
    for (const type of informationalTypes) {
      const entries = DETECTORS.filter((d) => d.type === type);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.fixEffort).toBeDefined();
      }
    }
  });
});
