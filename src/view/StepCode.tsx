import { createContext, useContext } from 'react';

import { cn } from '@/lib/utils';
import type { ImpactBand } from '@sparkforensics/core/types.ts';
import { IMPACT_TEXT_CLASS } from '@/view/ImpactBadge';

/** Whether step codes show. A host that shows one finding on its own (the docs example) turns them
 * off: no strip, board or summary beside it carries the same code. */
export const StepCodesShownContext = createContext(true);

export function useStepCodesShown(): boolean {
  return useContext(StepCodesShownContext);
}

export interface StepCodeProps {
  /** The verdict step code, such as "F1" (see `stepCodes`). */
  code: string;
  /** Colors the code by this status (the verdict's first step); otherwise muted. */
  impactBand?: ImpactBand;
  className?: string;
}

/** A verdict step's code in mono. The same code marks the verdict step, its
 * Findings row, its bar on the stage strip and its Stage Summary row, so one
 * finding can be followed across the board. */
export function StepCode({ code, impactBand, className }: StepCodeProps) {
  if (!useStepCodesShown()) return null;
  return (
    <span
      data-step-code={code}
      title={`Step ${code} in the verdict`}
      className={cn(
        'shrink-0 font-mono text-xs font-semibold tabular-nums',
        impactBand ? IMPACT_TEXT_CLASS[impactBand] : 'text-muted-foreground',
        className,
      )}
    >
      {code}
    </span>
  );
}
