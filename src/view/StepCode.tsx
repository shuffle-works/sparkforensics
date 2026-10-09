import { cn } from '@/lib/utils';
import { IMPACT_TEXT_CLASS } from '@/view/ImpactBadge';
import type { ImpactTone } from '@/view/impact-presentation';

export interface StepCodeProps {
  /** The verdict step code, such as "F1" (see `stepCodes`). */
  code: string;
  /** Colors the code by this status (the verdict's first step); otherwise muted. */
  impactBand?: ImpactTone;
  className?: string;
}

/** A verdict step's code in mono. The same code marks the verdict step, its
 * Findings row, its bar on the stage strip and its Stage Summary row, so one
 * finding can be followed across the board. */
export function StepCode({ code, impactBand, className }: StepCodeProps) {
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
