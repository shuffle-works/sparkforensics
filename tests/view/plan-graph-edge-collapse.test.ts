import { describe, it, expect } from 'vitest';
import { collapseHiddenEdges } from '@/view/PlanGraphRoute';
import type { PlanGraphEdge } from '@sparkforensics/core/types.ts';

describe('collapseHiddenEdges', () => {
  it('keeps an edge unchanged when both endpoints are visible', () => {
    const edges: PlanGraphEdge[] = [{ id: 'a->b', source: 'a', target: 'b' }];
    const result = collapseHiddenEdges(edges, new Set(['a', 'b']));
    expect(result).toEqual([{ id: 'a=>b', source: 'a', target: 'b' }]);
  });

  it('reconnects two visible nodes across one hidden node in between', () => {
    // a (visible) -> h (hidden) -> b (visible)
    const edges: PlanGraphEdge[] = [
      { id: 'a->h', source: 'a', target: 'h' },
      { id: 'h->b', source: 'h', target: 'b' },
    ];
    const result = collapseHiddenEdges(edges, new Set(['a', 'b']));
    expect(result).toEqual([{ id: 'a=>b', source: 'a', target: 'b' }]);
  });

  it('reconnects across a chain of several consecutive hidden nodes', () => {
    // a (visible) -> h1 -> h2 -> h3 -> b (visible)
    const edges: PlanGraphEdge[] = [
      { id: 'a->h1', source: 'a', target: 'h1' },
      { id: 'h1->h2', source: 'h1', target: 'h2' },
      { id: 'h2->h3', source: 'h2', target: 'h3' },
      { id: 'h3->b', source: 'h3', target: 'b' },
    ];
    const result = collapseHiddenEdges(edges, new Set(['a', 'b']));
    expect(result).toEqual([{ id: 'a=>b', source: 'a', target: 'b' }]);
  });

  it('fans out to every visible descendant when a hidden node has multiple visible children', () => {
    // a (visible) -> h (hidden) -> b (visible), h (hidden) -> c (visible)
    const edges: PlanGraphEdge[] = [
      { id: 'a->h', source: 'a', target: 'h' },
      { id: 'h->b', source: 'h', target: 'b' },
      { id: 'h->c', source: 'h', target: 'c' },
    ];
    const result = collapseHiddenEdges(edges, new Set(['a', 'b', 'c']));
    expect(result).toEqual(
      expect.arrayContaining([
        { id: 'a=>b', source: 'a', target: 'b' },
        { id: 'a=>c', source: 'a', target: 'c' },
      ]),
    );
    expect(result).toHaveLength(2);
  });

  it('drops edges entirely orphaned on both sides (no visible ancestor to reconnect through)', () => {
    // h1 (hidden, root) -> h2 (hidden) -- nothing visible above or below
    const edges: PlanGraphEdge[] = [{ id: 'h1->h2', source: 'h1', target: 'h2' }];
    const result = collapseHiddenEdges(edges, new Set());
    expect(result).toEqual([]);
  });
});
