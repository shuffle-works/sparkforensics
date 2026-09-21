import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/** Shared shape for PlanGraphFilterControl and PlanGraphDurationModeControl:
 * both are a single-select radiogroup of small option chips, each with a
 * hover/focus tooltip explaining what it does. */
export function PlanGraphRadioControl<T extends string>({
  ariaLabel,
  name,
  options,
  value,
  onChange,
  trailingContent,
}: {
  ariaLabel: string;
  name: string;
  options: Array<{ value: T; label: string; description: string }>;
  value: T;
  onChange: (value: T) => void;
  trailingContent?: ReactNode;
}) {
  return (
    <TooltipProvider>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" role="radiogroup" aria-label={ariaLabel}>
        {options.map((opt) => (
          <Tooltip key={opt.value}>
            <TooltipTrigger render={<label className="tap-target-comfortable flex min-h-8 items-center gap-1.5 px-1 text-sm" />}>
              <input
                type="radio"
                name={name}
                value={opt.value}
                checked={value === opt.value}
                onChange={() => onChange(opt.value)}
              />
              {opt.label}
            </TooltipTrigger>
            <TooltipContent>{opt.description}</TooltipContent>
          </Tooltip>
        ))}
        {trailingContent}
      </div>
    </TooltipProvider>
  );
}
