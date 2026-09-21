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
  durationMode: PlanGraphDurationMode;
  onDurationModeChange: (mode: PlanGraphDurationMode) => void;
  /** Icon-only trigger (aria-label "Settings") for the vertical control rail;
   * default is the labeled "Settings" button used in the topbar. */
  iconOnly?: boolean;
}

/** The node-category filter and the duration-attribution scope used to sit
 * inline in PlanGraphRoute's Topbar row (two radiogroups plus a divider),
 * crowding it alongside the expand/close buttons. This folds both into one
 * popover. A Popover, not a Menu, is deliberate: a Menu closes on item click,
 * which would force reopening it to change the second control after the
 * first; a Popover stays open until the user clicks away. */
export function PlanGraphSettingsControl({
  filterMode,
  onFilterModeChange,
  hiddenCount,
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
          <PlanGraphFilterControl mode={filterMode} onChange={onFilterModeChange} hiddenCount={hiddenCount} />
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
