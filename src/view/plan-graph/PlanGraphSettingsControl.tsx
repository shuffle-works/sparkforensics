import { Settings } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { PlanGraphFilterControl } from '@/view/plan-graph/PlanGraphFilterControl';
import { PlanGraphDurationModeControl } from '@/view/plan-graph/PlanGraphDurationModeControl';
import { cn } from '@/lib/utils';
import type { PlanGraphDurationMode, PlanGraphFilterMode } from '@sparkforensics/core/types.ts';

export interface PlanGraphSettingsControlProps {
  filterMode: PlanGraphFilterMode;
  onFilterModeChange: (mode: PlanGraphFilterMode) => void;
  hiddenCount: number;
  emptyFilterModes?: ReadonlySet<PlanGraphFilterMode>;
  durationMode: PlanGraphDurationMode;
  onDurationModeChange: (mode: PlanGraphDurationMode) => void;
  /** Icon-only trigger (aria-label "Settings") for the vertical control rail;
   * default is the labeled "Settings" button. */
  iconOnly?: boolean;
}

/** The node-category filter and the duration-attribution scope in one popover.
 * A Popover, not a Menu, so changing the first control does not close it before
 * the second is changed. */
export function PlanGraphSettingsControl({
  filterMode,
  onFilterModeChange,
  hiddenCount,
  emptyFilterModes,
  durationMode,
  onDurationModeChange,
  iconOnly = false,
}: PlanGraphSettingsControlProps) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={iconOnly ? 'Settings' : undefined}
        title={iconOnly ? 'Settings' : undefined}
        className={cn(
          buttonVariants({ variant: 'ghost', size: iconOnly ? 'icon' : 'sm' }),
          'tap-target-comfortable',
          iconOnly ? undefined : 'gap-1.5',
        )}
      >
        <Settings aria-hidden="true" />
        {iconOnly ? null : 'Settings'}
      </PopoverTrigger>
      <PopoverContent
        align={iconOnly ? 'start' : 'end'}
        side={iconOnly ? 'right' : 'bottom'}
        aria-label="Plan graph settings"
        className="space-y-3"
      >
        <div>
          <h2 className="mb-1.5 text-xs font-medium text-muted-foreground">Node filter</h2>
          <PlanGraphFilterControl mode={filterMode} onChange={onFilterModeChange} hiddenCount={hiddenCount} emptyModes={emptyFilterModes} />
        </div>
        <div aria-hidden="true" className="h-px bg-border" />
        <div>
          <h2 className="mb-1.5 text-xs font-medium text-muted-foreground">Duration attribution</h2>
          <PlanGraphDurationModeControl mode={durationMode} onChange={onDurationModeChange} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
