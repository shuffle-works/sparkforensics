import { cn } from '@/lib/utils';
import { IMPACT_BG_CLASS } from '@/view/ImpactBadge';
import { CATEGORY_ICON } from '@/view/plan-graph/PlanGraphNode';

// The operator categories worth naming in the legend (the icon vocabulary a
// reader actually sees on nodes); `boilerplate`/`aqe` are intentionally left
// out to keep it short.
const LEGEND_CATEGORIES: { category: string; label: string }[] = [
  { category: 'scan', label: 'Scan' },
  { category: 'filter', label: 'Filter' },
  { category: 'join', label: 'Join' },
  { category: 'aggregate', label: 'Aggregate' },
  { category: 'sort', label: 'Sort' },
  { category: 'exchange', label: 'Exchange' },
  { category: 'transform', label: 'Transform' },
];

/** On-canvas key for the plan graph's visual vocabulary: what the operator
 * icons mean, how the heat bar and edge thickness encode magnitude, and what
 * the stage boxes are. The control rail owns the open/close toggle; this is
 * just the panel it reveals. */
export function PlanGraphLegend() {
  return (
    <div
      data-testid="plan-graph-legend"
      role="region"
      aria-label="Plan graph legend"
      className="flex max-w-md flex-col gap-2 rounded-md border border-border bg-card p-3 text-xs shadow-md"
    >
      <div>
        <p className="mb-1 font-medium text-muted-foreground">Operators</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {LEGEND_CATEGORIES.map(({ category, label }) => (
            <span key={category} className="flex items-center gap-1">
              <span aria-hidden="true">{CATEGORY_ICON[category]}</span>
              {label}
            </span>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1 font-medium text-muted-foreground">Duration share</p>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className={cn('h-1.5 w-6 rounded-full', IMPACT_BG_CLASS.info)} /> low
          </span>
          <span className="flex items-center gap-1">
            <span className={cn('h-1.5 w-6 rounded-full', IMPACT_BG_CLASS.warning)} /> medium
          </span>
          <span className="flex items-center gap-1">
            <span className={cn('h-1.5 w-6 rounded-full', IMPACT_BG_CLASS.critical)} /> high
          </span>
        </div>
      </div>

      <p className="text-muted-foreground">
        <span className="text-foreground">Edge thickness</span> = shuffle bytes moved across an exchange.
      </p>

      <p className="text-muted-foreground">
        A <span className="text-foreground">stage</span> box wraps the Exchange-bounded segment of the plan that the log pairs with one
        Spark stage. A dashed box is a segment with no stage of its own; it names the nearest stage.
      </p>
    </div>
  );
}
