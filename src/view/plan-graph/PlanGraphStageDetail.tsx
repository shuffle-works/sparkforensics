import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { PlanGraphInspector } from '@/view/plan-graph/PlanGraphInspector';
import { useNarrowViewport } from '@/view/plan-graph/useNarrowViewport';
import { StageFindings } from '@/view/widgets/StageFindings';
import type { Finding, Stage } from '@sparkforensics/core/types.ts';

/** The findings of one stage, in the inspector slot of the plan graph: the same
 * block the stage detail dialog opens with, so the graph stays on screen. The
 * button opens the full dialog for the task histogram, I/O and plan sections.
 * Focus moves into the panel when it opens and back to `entryRef`, the chip or
 * title that opened it, when it closes. */
export function PlanGraphStageDetail({
  stage,
  catalog,
  showInfo,
  entryRef,
  onOpenFullDetails,
  onClose,
}: {
  stage: Stage;
  catalog: Finding[];
  showInfo: boolean;
  entryRef: RefObject<HTMLElement | null>;
  onOpenFullDetails: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const sheet = useNarrowViewport();

  // Also runs when another stage's entry is chosen while the panel is open.
  useLayoutEffect(() => {
    panelRef.current?.focus();
  }, [stage.id]);

  // Layout effect: on unmount the panel is still in the DOM here, so focus that
  // sits elsewhere (a node the user clicked) is left alone.
  useLayoutEffect(
    () => () => {
      if (panelRef.current?.contains(document.activeElement)) entryRef.current?.focus();
    },
    [entryRef],
  );

  return (
    <PlanGraphInspector
      ref={panelRef}
      tabIndex={-1}
      data-testid="plan-stage-detail"
      aria-label={`Stage ${stage.id} findings`}
      title={<h2 className="min-w-0 break-words text-sm font-semibold">Stage {stage.id}</h2>}
      closeLabel="Close stage findings"
      sheet={sheet}
      dockWidth="w-96"
      onClose={onClose}
    >
      <Button type="button" variant="outline" size="sm" onClick={onOpenFullDetails}>
        Open full stage details
      </Button>
      <StageFindings stage={stage} catalog={catalog} showInfo={showInfo} />
    </PlanGraphInspector>
  );
}
