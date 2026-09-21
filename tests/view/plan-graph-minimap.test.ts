import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';
import { planGraphMiniMapNodeColor } from '@/view/plan-graph/plan-graph-minimap';
import type { Finding } from '@sparkforensics/core/types.ts';

const planNode = (findings: Partial<Finding>[] = []): Node =>
  ({ id: 'n', type: 'planNode', position: { x: 0, y: 0 }, data: { findings } } as unknown as Node);

describe('planGraphMiniMapNodeColor', () => {
  it('keeps the neutral plan color for a node with no findings', () => {
    expect(planGraphMiniMapNodeColor(planNode())).toBe('var(--plan-aggregate)');
  });

  it('colors a node by its worst finding band', () => {
    expect(planGraphMiniMapNodeColor(planNode([{ impactBand: 'warning' }, { impactBand: 'critical' }]))).toBe('var(--color-critical)');
    expect(planGraphMiniMapNodeColor(planNode([{ impactBand: 'info' }, { impactBand: 'warning' }]))).toBe('var(--color-warning)');
  });

  it('mutes the group boxes so node dots stand out', () => {
    const group = { id: 'segment-0', type: 'segmentGroup', position: { x: 0, y: 0 }, data: {} } as unknown as Node;
    expect(planGraphMiniMapNodeColor(group)).toBe('var(--muted)');
  });
});
