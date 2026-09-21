import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';

export interface ExpandToggleButtonProps {
  expanded: boolean;
  onClick: () => void;
  /** Visible label naming what this toggle reveals, e.g. "Task detail",
   * "Recommendation". Rendered as the button's own text and folded
   * (lowercased) into its accessible name. */
  label: string;
  /** Per-row identifier (a stage id, a finding id, …) folded into the
   * aria-label's "for {location}" clause so multiple identical toggles on
   * the same widget stay distinguishable to assistive tech. Optional since
   * not every caller has one (a single, widget-scoped toggle). */
  location?: string;
  /** Id of the revealed content region this trigger expands, per the ARIA
   * Disclosure pattern (`aria-expanded` alone doesn't programmatically
   * associate the two). */
  controlsId?: string;
}

export function ExpandToggleButton({ expanded, onClick, label, location, controlsId }: ExpandToggleButtonProps) {
  const forClause = location ? ` for ${location}` : '';
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controlsId}
      aria-label={`${expanded ? 'Hide' : 'Show'} ${label.toLowerCase()}${forClause}`}
      onClick={onClick}
      className="tap-target-comfortable tap-target-comfortable--sm flex w-fit cursor-pointer items-center gap-1 text-xs font-medium text-primary underline underline-offset-2"
    >
      {label}
      {expanded ? (
        <ChevronUpIcon aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
      )}
    </button>
  );
}
