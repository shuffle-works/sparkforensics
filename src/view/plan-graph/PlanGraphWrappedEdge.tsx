import { BaseEdge, getBezierPath, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

/** Data on an edge between two rows of a wrapped layout (set in PlanGraphCanvas). */
export interface WrappedEdgeData {
  /** y of the gap between the rows, which the edge runs along. */
  rowGapY?: number;
  [key: string]: unknown;
}

/** An edge's path: a bezier, or, between two rows of a wrapped layout, a
 * stepped path that leaves its node sideways and crosses along the gap between
 * the rows instead of cutting over them. */
export function planEdgePath(
  { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: Pick<EdgeProps, 'sourceX' | 'sourceY' | 'targetX' | 'targetY' | 'sourcePosition' | 'targetPosition'>,
  rowGapY: number | undefined,
): [path: string, labelX: number, labelY: number] {
  const [path, labelX, labelY] = rowGapY == null
    ? getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
    : getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, centerY: rowGapY });
  return [path, labelX, labelY];
}

/** A plain (unweighted) edge between two rows of a wrapped layout. */
export function PlanGraphWrappedEdge({ markerEnd, data, ...props }: EdgeProps) {
  const [path] = planEdgePath(props, (data as WrappedEdgeData | undefined)?.rowGapY);
  return <BaseEdge path={path} markerEnd={markerEnd} />;
}
