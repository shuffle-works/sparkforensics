import { describe, it, expect } from 'vitest';
import { Position } from '@xyflow/react';
import { planEdgePath } from '../../src/view/plan-graph/PlanGraphWrappedEdge';

// An edge between rows: the consumer starts the lower row (its source handle on
// its left), the producer ends the upper row (its target handle on its right).
const between = { sourceX: 0, sourceY: 327, sourcePosition: Position.Left, targetX: 1060, targetY: 45, targetPosition: Position.Right };

const points = (path: string) =>
  [...path.matchAll(/(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));

describe('planEdgePath', () => {
  it('runs an edge between rows along the gap, outside both rows, instead of across them', () => {
    const [path] = planEdgePath(between, 186);
    const along = points(path).filter((p) => p.y === 186).map((p) => p.x);
    expect(Math.min(...along)).toBeLessThan(between.sourceX);
    expect(Math.max(...along)).toBeGreaterThan(between.targetX);
    expect(points(path).filter((p) => p.x > between.sourceX && p.x < between.targetX)).toEqual([]);
  });

  it('draws an edge within a row as a curve', () => {
    const [curve] = planEdgePath({ ...between, sourceY: 45 }, undefined);
    expect(curve).toMatch(/C/);
  });
});
