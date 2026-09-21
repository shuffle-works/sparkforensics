import type { ReactNode } from 'react';

export interface WidgetLeadSummaryProps {
  value: ReactNode;
  context: string;
}

/** Collapsed-card summary: a lead metric and short context, shown via
 * `WidgetCard`'s `summary` prop so a collapsed board widget still
 * communicates what it found. The value is capped at 2 lines and reserves
 * that height even when short, so every collapsed card lines up in the grid
 * regardless of how long its metric text is. */
export function WidgetLeadSummary({ value, context }: WidgetLeadSummaryProps) {
  return (
    <div className="space-y-2">
      <p className="flex items-baseline gap-2">
        <span
          className="line-clamp-2 min-h-[4rem] text-2xl font-semibold tracking-tight"
          title={typeof value === 'string' ? value : undefined}
        >
          {value}
        </span>
        <span className="text-xs text-muted-foreground">{context}</span>
      </p>
    </div>
  );
}
