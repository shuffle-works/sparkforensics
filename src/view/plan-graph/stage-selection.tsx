import { createContext, useContext, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export interface StageSelection {
  /** Stage whose findings panel is open, or null when none is. */
  selectedStageId: number | null;
  /** Opens the panel for a stage. `entry` is the control to focus again when the panel closes. */
  select: (stageId: number, entry: HTMLElement) => void;
}

// Provided by the route, which owns the selection so its Escape handler can
// close the panel. Absent when a canvas renders on its own: entry points then
// render as plain text.
const StageSelectionContext = createContext<StageSelection | null>(null);

export const StageSelectionProvider = StageSelectionContext.Provider;

export function useStageSelection(): StageSelection | null {
  return useContext(StageSelectionContext);
}

/** A stage title or finding chip that opens that stage's findings panel. */
export function StageEntryButton({
  stageId,
  className,
  children,
  ...props
}: { stageId: number } & Omit<ComponentProps<'button'>, 'type' | 'onClick'>) {
  const selection = useStageSelection();
  if (!selection) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      // The overlay behind `tap-target-comfortable` lifts the hit area to 24px
      // (44px on touch) while the control keeps its size.
      className={cn('tap-target-comfortable cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', className)}
      onClick={(e) => selection.select(stageId, e.currentTarget)}
      {...props}
    >
      {children}
    </button>
  );
}
