import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { ImpactBand } from '@sparkforensics/core/types.ts';
import { IMPACT_BORDER_CLASS } from '@/view/ImpactBadge';
import { DisclosureOpenContext } from '@/view/DisclosureContext';
import { useWidgetGridCard, WidgetGridCardBoundary } from '@/view/WidgetGrid';

export interface WidgetCardProps {
  title: string;
  impactBand?: ImpactBand;
  badges?: ReactNode;
  /** Like `badges`, but rendered next to the title only while the card is
   * expanded, kept separate so tag/impact badges stay visible in the
   * collapsed summary while a `RowStatusCluster`-style confidence/evidence
   * marker doesn't. */
  statusBadge?: ReactNode;
  /** Shown in place of `children` while collapsed: a lead metric plus
   * context, so a collapsed card is never blank behind a bare title (see
   * `WidgetLeadSummary`). */
  summary?: ReactNode;
  defaultCollapsed?: boolean;
  /** When false, render the widget body permanently open without a disclosure control. */
  collapsible?: boolean;
  /** Optional controlled disclosure state, paired with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  compact?: boolean;
  /** Temporary visible focus supplied by the route coordinator. */
  routeFocused?: boolean;
  /** Exposes the existing disclosure trigger without changing its behavior. */
  disclosureButtonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
  id?: string;
}

export function WidgetCard({
  title,
  impactBand,
  badges,
  statusBadge,
  summary,
  defaultCollapsed = false,
  collapsible = true,
  open: controlledOpen,
  onOpenChange,
  compact = false,
  routeFocused,
  disclosureButtonRef,
  children,
  id,
}: WidgetCardProps) {
  const gridCard = useWidgetGridCard();
  const cardRef = useRef<HTMLDivElement>(null);
  // Reference-region tiles start collapsed and share a uniform collapsed height,
  // overriding each widget's own `defaultCollapsed` so the grid stays even.
  const collapsedTile = gridCard?.collapsedTile ?? false;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(collapsedTile ? false : !defaultCollapsed);
  const open = controlledOpen ?? uncontrolledOpen;
  const coordinatorRouteFocused = routeFocused ?? gridCard?.routeFocused ?? false;
  const [hasRouteFocus, setHasRouteFocus] = useState(coordinatorRouteFocused);
  const handledOpenRequestRef = useRef(0);

  useLayoutEffect(() => {
    gridCard?.reportOpen(open);
  }, [gridCard, open]);

  useLayoutEffect(() => {
    const requestGeneration = gridCard?.openRequestGeneration ?? 0;
    if (requestGeneration === 0 || requestGeneration === handledOpenRequestRef.current) return;

    handledOpenRequestRef.current = requestGeneration;
    if (!open) {
      if (controlledOpen !== undefined) onOpenChange?.(true);
      else setUncontrolledOpen(true);
    }
  }, [controlledOpen, gridCard?.openRequestGeneration, onOpenChange, open]);

  useLayoutEffect(() => {
    setHasRouteFocus(coordinatorRouteFocused);
  }, [coordinatorRouteFocused]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (controlledOpen !== undefined) onOpenChange?.(nextOpen);
    else setUncontrolledOpen(nextOpen);
  };

  const setTriggerRef = (button: HTMLButtonElement | null) => {
    gridCard?.setDisclosureButton(button);
    if (typeof disclosureButtonRef === 'function') disclosureButtonRef(button);
    else if (disclosureButtonRef) disclosureButtonRef.current = button;
  };

  const handleDisclosureBlur = (e: React.FocusEvent<HTMLButtonElement>) => {
    if (e.relatedTarget && cardRef.current?.contains(e.relatedTarget as Node)) return;
    setHasRouteFocus(false);
    gridCard?.onDisclosureBlur();
  };

  const header = (
    // `flex-col` below `sm` puts the title and badge row on genuinely separate
    // lines: at row layout, `items-center` centers badges against the
    // tallest flex item, which overlaps a two-line-wrapped title (e.g. "Executor
    // Timeline" plus a HOST badge at 390px). Row layout returns at `sm` and up,
    // where titles fit on one line and the badges can sit beside it, wrapping
    // to a second row (not clipping) if there are too many to fit.
    <div className="flex flex-col gap-2 px-(--card-spacing) sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      {collapsible ? (
        <CollapsibleTrigger
          ref={setTriggerRef}
          aria-expanded={String(open) as 'true' | 'false'}
          data-route-focused={hasRouteFocus ? '' : undefined}
          className={cn(
            'tap-target-comfortable tap-target-comfortable--sm flex min-w-0 cursor-pointer items-center gap-2 bg-transparent text-left sm:flex-1',
            hasRouteFocus && 'border-ring ring-[3px] ring-ring/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          )}
          onBlur={handleDisclosureBlur}
        >
          {/* h3: one level below the board's h2 section headers, keeping the
              document outline nested. */}
          <h3 className="font-heading text-base leading-snug font-bold">{title}</h3>
          {open ? (
            <ChevronUpIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          )}
        </CollapsibleTrigger>
      ) : (
        <h3 className="min-w-0 font-heading text-base leading-snug font-bold sm:flex-1">{title}</h3>
      )}
      {badges || (open && statusBadge) ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {badges}
          {open ? statusBadge : null}
        </div>
      ) : null}
    </div>
  );

  const content = (
    <WidgetGridCardBoundary>
      <CardContent>{children}</CardContent>
    </WidgetGridCardBoundary>
  );

  return (
    <Card
      ref={cardRef}
      id={id}
      size={compact ? 'sm' : 'default'}
      className={cn(
        'border-l-4',
        impactBand ? IMPACT_BORDER_CLASS[impactBand] : 'border-transparent',
        // Uniform collapsed height for reference-grid tiles so header-only and
        // header+summary cards line up; drops once the tile is expanded.
        collapsedTile && !open && 'min-h-[6.5rem]',
      )}
    >
      {collapsible ? (
        <Collapsible open={open} onOpenChange={handleOpenChange}>
          {header}
          {summary && !open ? (
            <div className="px-(--card-spacing) pb-(--card-spacing)">{summary}</div>
          ) : null}
          <WidgetGridCardBoundary>
            <CollapsibleContent keepMounted>
              {/* `keepMounted` keeps the body in the DOM while collapsed so its
                  text stays queryable/find-able; the context lets charts skip
                  mounting a 0×0 ResponsiveContainer until the card is open. */}
              <DisclosureOpenContext.Provider value={open}>
                <CardContent>{children}</CardContent>
              </DisclosureOpenContext.Provider>
            </CollapsibleContent>
          </WidgetGridCardBoundary>
        </Collapsible>
      ) : (
        <>
          {header}
          {content}
        </>
      )}
    </Card>
  );
}

/**
 * `Suspense` fallback for a `React.lazy`-loaded widget: a bare `Card` shell
 * with a pulsing placeholder bar, sized to approximate a collapsed
 * `WidgetCard`'s header so the grid doesn't jump while the widget's chunk loads.
 */
export function WidgetCardSkeleton() {
  return (
    <Card className="border-l-4 border-transparent" aria-hidden="true">
      <CardContent>
        <div className="h-5 w-1/3 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </CardContent>
    </Card>
  );
}
