import { describe, it, expect } from 'vitest';
import { walkPlanTree } from '../src/plan-tree-walk.js';

const node = (name, children = []) => ({ name, children });

describe('walkPlanTree', () => {
  it('visits pre-order, left-to-right', () => {
    const tree = node('root', [
      node('a', [node('a1')]),
      node('b'),
    ]);
    const visited = [];
    walkPlanTree(tree, (n) => visited.push(n.name));
    expect(visited).toEqual(['root', 'a', 'a1', 'b']);
  });

  it('passes the parent node to visit, null for the root', () => {
    const a1 = node('a1');
    const a = node('a', [a1]);
    const tree = node('root', [a]);
    const parents = new Map();
    walkPlanTree(tree, (n, parent) => parents.set(n.name, parent));
    expect(parents.get('root')).toBe(null);
    expect(parents.get('a')).toBe(tree);
    expect(parents.get('a1')).toBe(a);
  });

  it('without dedupe, revisits a node shared by two parents', () => {
    const shared = node('shared');
    const tree = node('root', [
      node('left', [shared]),
      node('right', [shared]),
    ]);
    const visited = [];
    walkPlanTree(tree, (n) => visited.push(n.name));
    expect(visited.filter(n => n === 'shared')).toHaveLength(2);
  });

  it('with dedupe:true, visits a shared node only once', () => {
    const shared = node('shared');
    const tree = node('root', [
      node('left', [shared]),
      node('right', [shared]),
    ]);
    const visited = [];
    walkPlanTree(tree, (n) => visited.push(n.name), { dedupe: true });
    expect(visited.filter(n => n === 'shared')).toHaveLength(1);
  });

  it('does nothing for a null/undefined root', () => {
    const visit = () => { throw new Error('should not be called'); };
    expect(() => walkPlanTree(null, visit)).not.toThrow();
    expect(() => walkPlanTree(undefined, visit)).not.toThrow();
  });
});
