import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Downward drag, in px, past which releasing the sheet's grabber dismisses it.
const SHEET_DISMISS_DISTANCE = 64;

/** Frame of a plan-graph inspector: a right-docked panel, or (`sheet`, phone
 * width) a bottom sheet under the graph with a grabber that dismisses it on a
 * downward swipe. Owns the title row with its close button; the caller supplies
 * the body. The node detail and the stage panel share the one slot this frame
 * fills. */
export function PlanGraphInspector({
  title,
  closeLabel,
  sheet = false,
  dockWidth = 'w-80',
  onClose,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'title' | 'className' | 'style'> & {
  title: ReactNode;
  closeLabel: string;
  /** Lays the panel out as a bottom sheet with a swipe-down grabber. */
  sheet?: boolean;
  /** Tailwind width class of the docked (non-sheet) layout. */
  dockWidth?: string;
  onClose: () => void;
}) {
  const drag = useRef<{ startY: number } | null>(null);
  const [dragOffset, setDragOffset] = useState(0);

  const endDrag = (dismiss: boolean) => {
    drag.current = null;
    setDragOffset(0);
    if (dismiss) onClose();
  };

  return (
    <div
      role="dialog"
      data-variant={sheet ? 'sheet' : 'dock'}
      style={sheet && dragOffset > 0 ? { transform: `translateY(${dragOffset}px)` } : undefined}
      className={
        sheet
          ? 'flex h-2/5 shrink-0 flex-col outline-none gap-3 overflow-y-auto rounded-t-xl border-t border-border bg-card px-3 pb-3 text-xs shadow-[0_-4px_12px_rgb(0_0_0/0.08)]'
          : `flex h-full ${dockWidth} shrink-0 flex-col outline-none gap-3 overflow-y-auto border-l border-border bg-card p-3 text-xs`
      }
      {...props}
    >
      {sheet ? (
        // Drag handle: the whole strip is the touch target. Escape and the X
        // button remain the keyboard and assistive routes to close.
        <div
          data-testid="plan-graph-inspector-grabber"
          aria-hidden="true"
          className="sticky top-0 -mx-3 flex shrink-0 cursor-grab touch-none justify-center bg-card py-2.5"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            drag.current = { startY: e.clientY };
          }}
          onPointerMove={(e) => {
            if (drag.current) setDragOffset(Math.max(0, e.clientY - drag.current.startY));
          }}
          onPointerUp={(e) => endDrag(drag.current != null && e.clientY - drag.current.startY >= SHEET_DISMISS_DISTANCE)}
          onPointerCancel={() => endDrag(false)}
        >
          <span className="h-1 w-9 rounded-full bg-muted-foreground/40" />
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-2">
        {title}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={sheet ? 'size-9 shrink-0' : 'size-6 shrink-0'}
          aria-label={closeLabel}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      {children}
    </div>
  );
}
