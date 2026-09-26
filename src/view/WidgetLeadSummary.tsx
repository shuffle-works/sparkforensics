import type { ReactNode } from 'react';

export interface WidgetLeadSummaryProps {
  value: ReactNode;
  context: string;
}

/** Collapsed-card summary: a lead metric and short context, shown via
 * `WidgetCard`'s `summary` prop so a collapsed board widget still
 * communicates what it found. The value is capped at 2 lines and reserves
 * that height (on the whole row, so a context that wraps under the value
 * stays next to it) even when short, so every collapsed card lines up in
 * the grid regardless of how long its metric text is. */
export function WidgetLeadSummary({ value, context }: WidgetLeadSummaryProps) {
  return (
    <div className="space-y-2">
      {/* flex-wrap: when value and context do not fit on one line the context
          moves under the value, instead of squeezing it until line-clamp cuts
          it off ("0.01 core-l"). */}
      <p className="flex min-h-[4rem] flex-wrap content-start items-baseline gap-x-2">
        <span
          className="line-clamp-2 text-2xl font-semibold tracking-tight"
          title={typeof value === 'string' ? value : undefined}
        >
          {value}
        </span>
        <span className="text-xs text-muted-foreground">{context}</span>
      </p>
    </div>
  );
}
