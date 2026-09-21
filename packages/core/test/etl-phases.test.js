import { describe, it, expect } from 'vitest';
import { attributeEtlPhases } from '../src/etl-phases.js';

function stagesMap(list) { return new Map(list.map((s, i) => [i, { submittedAt: 0, completedAt: 0, inputBytes: 0, shuffleReadBytes: 0, shuffleWriteBytes: 0, outputBytes: 0, ...s }])); }

describe('attributeEtlPhases (Onehouse Spark Analyzer, phase-bucketing only)', () => {
  it('classifies a pure scan stage as Extract', () => {
    const r = attributeEtlPhases(stagesMap([{ submittedAt: 0, completedAt: 100, inputBytes: 500 }]));
    expect(r).toEqual({ extract: 100, transform: 0, load: 0 });
  });

  it('classifies a shuffle stage as Transform', () => {
    const r = attributeEtlPhases(stagesMap([{ submittedAt: 0, completedAt: 200, shuffleReadBytes: 500 }]));
    expect(r).toEqual({ extract: 0, transform: 200, load: 0 });
  });

  it('attributes a shuffle+write stage to BOTH Transform and Load', () => {
    const r = attributeEtlPhases(stagesMap([{ submittedAt: 0, completedAt: 300, shuffleWriteBytes: 10, outputBytes: 20 }]));
    expect(r.transform).toBe(300);
    expect(r.load).toBe(300);
    expect(r.extract).toBe(0);
  });
});
