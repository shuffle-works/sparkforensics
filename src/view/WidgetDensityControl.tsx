import { Toggle } from '@/components/ui/toggle';
import { DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import { store, useWidgetDensity } from '@/store/store';

/** What turning this on reveals, surfaced as a tooltip since "Advanced view"
 * alone doesn't say what changes (shared by both entry points below). */
const DENSITY_HINT = 'Show confidence levels, evidence, documentation links, finding filters and triage shortcuts (j/k, f, 1/2)';

/** Desktop's always-visible inline control, in the `sm:flex` action cluster.
 * `variant="outline"` gives the OFF state a visible border (the shared
 * Toggle's default variant is borderless/`bg-transparent`, which reads as
 * inert text rather than a control). The ON state is a selected toggle
 * (accent border, light accent wash and an accent dot around foreground
 * text), not a solid accent fill: a filled button read as the page's primary
 * call to action, louder than the verdict's own "Show evidence". Accent-
 * colored text on the wash measured 4.2:1 in the light theme, under AA, so
 * the text stays foreground. */
export function WidgetDensityControl() {
  const advanced = useWidgetDensity() === 'advanced';
  return (
    <Toggle
      variant="outline"
      pressed={advanced}
      onPressedChange={(pressed) => store.getState().setWidgetDensity(pressed ? 'advanced' : 'basic')}
      className="tap-target-comfortable aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-foreground aria-pressed:hover:bg-primary/15"
      title={DENSITY_HINT}
    >
      {advanced ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
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
