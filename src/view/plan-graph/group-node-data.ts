import type { Finding } from '@sparkforensics/core/types';

// Data the plan graph's group boxes carry on their flow nodes: layout sizes, labels formatted for
// display and a selection callback. View-only, so it lives with the nodes that render it.

/** A segment box is drawn only for a segment with no stage pair of its own; a
 * paired segment is the inside of its stage box. */
export interface PlanGraphSegmentGroupNodeData {
  width: number;
  height: number;
  /** The nearest strictly paired segment's stage, named in the box's header;
   * null when the plan pairs no segment with any stage. */
  nearestStageId: number | null;
  /** Pre-formatted via `formatDuration` (units.ts) by the caller;
   * null (never 0) when this segment has no attributed duration, which is
   * the usual case for an unpaired segment. */
  durationLabel: string | null;
}

export interface PlanGraphStageGroupNodeData {
  width: number;
  height: number;
  stageId: number;
  /** Every finding on this stage, in full (not just the worst impact band). */
  findings: Finding[];
  /** The summed duration of every segment strictly paired with the stage,
   * pre-formatted via `formatDuration`; null when it has no attributed duration. */
  durationLabel: string | null;
  onSelect?: () => void;
}

/** The focal stage when it has findings but no strictly paired segment: its
 * header alone, drawn above the graph with no box around any node. */
export type PlanGraphUnmatchedStageNodeData = Pick<PlanGraphStageGroupNodeData, 'width' | 'height' | 'stageId' | 'findings' | 'durationLabel'>;
