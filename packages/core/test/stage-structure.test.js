import { describe, it, expect } from 'vitest';
import { attributeNames, structuralKey, detailTokens, jaccard } from '../src/stage-structure.js';

const node = (name, detail, children = []) => ({ name, detail, metrics: [], children });

describe('attributeNames', () => {
  it('lists each attribute once, sorted, without ids or literals', () => {
    expect(attributeNames('Project [b#12L, a#3, sum(c#9) AS s#4, 42, "x"]')).toEqual(['a', 'b', 'c', 's']);
    expect(attributeNames('Filter (amount#1 > 5)')).toEqual(attributeNames('Filter (amount#8 > 70)'));
  });
});

describe('structuralKey', () => {
  it('is the same for a column list in another order and with other ids', () => {
    const a = [node('Expand', '[[a#1, b#2, 0]], [a#1, b#2, gid#5]')];
    const b = [node('Expand', '[[b#7, a#9, 1]], [gid#3, b#7, a#9]')];
    expect(structuralKey(a)).toBe(structuralKey(b));
  });

  it('differs for another operator, another attribute, or another tree shape', () => {
    const leaf = node('Scan', '[a#1]'), filter = node('Filter', 'a#1 > 1');
    const flat = [leaf, filter];
    const nested = [{ ...filter, children: [leaf] }, leaf];
    expect(structuralKey([node('Scan', '[a#1]')])).not.toBe(structuralKey([node('Scan', '[b#1]')]));
    expect(structuralKey([node('Scan', '[a#1]')])).not.toBe(structuralKey([node('Sort', '[a#1]')]));
    expect(structuralKey(flat)).not.toBe(structuralKey(nested));
  });

  it('ignores literals, paths and file counts in the node text', () => {
    const a = [node('Scan parquet', 'Location: InMemoryFileIndex(4 paths)[/in/a], [a#1], x > 5')];
    const b = [node('Scan parquet', 'Location: InMemoryFileIndex(9 paths)[/in/b], [a#1], x > 7')];
    expect(structuralKey(a)).toBe(structuralKey(b));
  });

  it('skips codegen plumbing and is null when nothing else is attributed', () => {
    expect(structuralKey([node('WholeStageCodegen (3)', ''), node('Filter', 'a#1')])).toBe(structuralKey([node('Filter', 'a#1')]));
    expect(structuralKey([node('WholeStageCodegen (3)', ''), node('InputAdapter', '')])).toBeNull();
    expect(structuralKey([])).toBeNull();
  });

  it('does not depend on the order of sibling subtrees', () => {
    const x = node('Scan', '[x#1]'), y = node('Scan', '[y#2]');
    expect(structuralKey([node('Join', '[x#1], [y#2]', [x, y]), x, y])).toBe(structuralKey([node('Join', '[x#1], [y#2]', [y, x]), x, y]));
  });
});

describe('detailTokens and jaccard', () => {
  it('shares nearly every token between two stages that differ in one literal', () => {
    const a = detailTokens('save at X.java:0', [node('Filter', 'amount#1 > 5 AND region#2 = north')], (s) => s);
    const b = detailTokens('save at X.java:0', [node('Filter', 'amount#1 > 7 AND region#2 = north')], (s) => s);
    expect(jaccard(a, b)).toBeGreaterThan(0.6);
    expect(jaccard(a, a)).toBe(1);
  });

  it('counts a repeated element as often as both sides repeat it and treats two empty sides as equal', () => {
    expect(jaccard(['a', 'a', 'b'], ['a', 'b'])).toBeCloseTo(2 / 3);
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(['a'], [])).toBe(0);
  });
});
