import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useState } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { AppModel, StageId } from '@sparkforensics/core/types.ts';
import { PlanView, resolvePlanTree } from '@/view/widgets/PlanView';

export interface PlanExplorerProps {
  stageId: StageId;
  appModel: AppModel;
}

/** "Plan context" disclosure: a Collapsible around the shared PlanView.
 * Spill.tsx, Skew.tsx, StageShape.tsx, TinyTask.tsx, ShuffleIO.tsx, and
 * PartitionSizing.tsx are its current callers, rendering it as a direct
 * sibling in the row body: it has no row-expansion toggle of its own, so this
 * trigger sits right there. Renders nothing when PlanView would (no plan tree
 * for this stage). */
export function PlanExplorer({ stageId, appModel }: PlanExplorerProps) {
  const [open, setOpen] = useState(false);
  if (!resolvePlanTree(stageId, appModel)) return null;

  return (
    <div className="space-y-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          aria-expanded={String(open) as 'true' | 'false'}
          className="flex cursor-pointer items-center gap-2 bg-transparent text-left"
        >
          <h3 className="font-heading text-sm font-medium">Plan context</h3>
          {open ? (
            <ChevronUpIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <div className="pt-3">
            <PlanView stageId={stageId} appModel={appModel} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
