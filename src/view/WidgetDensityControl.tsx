import { Toggle } from '@/components/ui/toggle';
import { DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import { store, useWidgetDensity } from '@/store/store';

/** What turning this on reveals, surfaced as a tooltip since "Advanced view"
 * alone doesn't say what changes (shared by both entry points below). */
const DENSITY_HINT = 'Show confidence levels, evidence, and documentation links for each finding';

/** Desktop's always-visible inline control, in the `sm:flex` action cluster.
 * `variant="outline"` gives the OFF state a visible border (the shared
 * Toggle's default variant is borderless/`bg-transparent`, which reads as
 * inert text rather than a control). The hover-while-pressed background uses
 * a `color-mix` darken toward `--foreground` (matching the Button
 * `secondary` variant's hover token, `src/components/ui/button.tsx`) instead
 * of the stock shadcn `bg-primary/80` alpha blend: blending 80%-opacity
 * accent over the app's near-white light-theme surfaces dropped contrast for
 * the white `primary-foreground` text to ~3.7:1, below WCAG AA's 4.5:1. */
export function WidgetDensityControl() {
  const advanced = useWidgetDensity() === 'advanced';
  return (
    <Toggle
      variant="outline"
      pressed={advanced}
      onPressedChange={(pressed) => store.getState().setWidgetDensity(pressed ? 'advanced' : 'basic')}
      className="tap-target-comfortable aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_5%)]"
      title={DENSITY_HINT}
    >
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
