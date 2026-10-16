import { useId, useState } from 'react';

/** Hover-detail pattern: `title` for mouse hover, an `sr-only` span linked by
 * `aria-describedby` for screen readers, and a visible bubble on keyboard
 * focus (`title` never fires on focus). The host still needs its own
 * `tabIndex={0}` if not natively focusable. With no `text`, nothing renders. */
export function useAccessibleTooltip(text?: string) {
  const descriptionId = useId();
  const [isFocused, setIsFocused] = useState(false);
  if (!text) {
    return { tooltipProps: {} as const, srOnlyTooltip: null };
  }
  return {
    tooltipProps: {
      title: text,
      'aria-describedby': descriptionId,
      onFocus: () => setIsFocused(true),
      onBlur: () => setIsFocused(false),
    } as const,
    srOnlyTooltip: (
      <>
        <span id={descriptionId} className="sr-only">
          {text}
        </span>
        {isFocused ? (
          // Decorative only: `aria-describedby` on the `sr-only` span already covers
          // assistive tech, so this stays `aria-hidden`. `data-testid` gives tests a
          // hook without an ARIA role that would contradict `aria-hidden`.
          <span
            aria-hidden="true"
            data-testid="visible-tooltip"
            className="pointer-events-none absolute top-full left-0 z-50 mt-1 max-w-xs rounded-md border border-border bg-foreground px-2 py-1 text-xs font-normal whitespace-normal text-background shadow-md"
          >
            {text}
          </span>
        ) : null}
      </>
    ),
  };
}
