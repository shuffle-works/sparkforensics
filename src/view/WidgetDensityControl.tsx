import { Toggle } from '@/components/ui/toggle';
import { DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import { store, useWidgetDensity } from '@/store/store';

/** What turning this on reveals, surfaced as a tooltip since "Advanced view"
 * alone doesn't say what changes (shared by both entry points below). */
const DENSITY_HINT = 'Show confidence levels, evidence, documentation links, finding filters and triage shortcuts (j/k, f, 1/2)';

/** Desktop's always-visible inline control, in the `sm:flex` action cluster.
 * Trace's soft primary: accent text on the accent-soft wash, never a solid
 * fill (a filled button would out-shout the verdict's own "Show evidence").
 * The ON state adds an accent border and dot. Accent on accent-soft clears
 * 4.5:1 in both Trace themes. */
export function WidgetDensityControl() {
  const advanced = useWidgetDensity() === 'advanced';
  return (
    <Toggle
      variant="outline"
      pressed={advanced}
      onPressedChange={(pressed) => store.getState().setWidgetDensity(pressed ? 'advanced' : 'basic')}
      className="tap-target-comfortable border-transparent bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent aria-pressed:hover:bg-accent-soft"
      title={DENSITY_HINT}
    >
      {advanced ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
      Advanced view
    </Toggle>
  );
}

/** Mobile's copy of the same control, folded into the "More options" overflow
 * menu (whose trigger is `sm:hidden`), styled like the "Redact identifiers"
 * checkbox item elsewhere in that menu. */
export function WidgetDensityMenuItem() {
  const advanced = useWidgetDensity() === 'advanced';
  return (
    <DropdownMenuCheckboxItem
      checked={advanced}
      onCheckedChange={(checked) => store.getState().setWidgetDensity(checked ? 'advanced' : 'basic')}
      title={DENSITY_HINT}
    >
      Advanced view
    </DropdownMenuCheckboxItem>
  );
}
