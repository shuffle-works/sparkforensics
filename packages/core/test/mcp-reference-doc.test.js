import { describe, it, expect } from 'vitest';
import { getReferenceDoc } from '../src/mcp-tools.ts';

describe('getReferenceDoc', () => {
  it('returns a general chapter by its page anchor', () => {
    const doc = getReferenceDoc('#joins');
    expect(doc.anchor).toBe('joins');
    expect(doc.content.length).toBeGreaterThan(0);
    expect(doc.title.length).toBeGreaterThan(0);
  });
  it('resolves a metric sub-anchor to its owning page (metrics)', () => {
    expect(getReferenceDoc('#metric-task-duration').anchor).toBe('metrics');
  });
  it('returns a bottleneck doc from the tuning store', () => {
    expect(getReferenceDoc('#bottleneck-skew').content).toMatch(/\S/);
  });
  it('throws on an unknown anchor', () => {
    expect(() => getReferenceDoc('#nonsense')).toThrow();
  });
});
