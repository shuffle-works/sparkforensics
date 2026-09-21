import { useId, useState } from 'react';

/** Hover-detail pattern: the full text stays reachable to everyone, not just
 * mouse users. The native
 * `title` attribute serves sighted hover, and the same text is also a
 * `sr-only` DOM descendant (never gated behind hover/focus) that
 * `aria-describedby` keeps programmatically associated with the host
 * element, so assistive tech reports it as that element's accessible
 * description without needing an independent focus stop.
 *
 * `title` only ever fires on mouse hover, never on keyboard focus, so a
 * sighted keyboard-only user would otherwise have no way to see the text (a
 * screen reader is unaffected, it already gets the `sr-only` copy above,
 * independent of hover/focus). `tooltipProps` therefore also wires up
 * `onFocus`/`onBlur`, and while focused, an extra visible (non-`sr-only`)
 * bubble renders with the same text, `aria-hidden` since the accessible
 * description is already covered by `aria-describedby`. The host element
 * still needs its own `tabIndex={0}` if it isn't natively focusable, this
 * hook only supplies the focus *handlers*, not a tab stop.
 *
 * `useId`/`useState` are called unconditionally, before any early return,
 * per rules of hooks.
 *
 * With no `text`, there's nothing to describe: `tooltipProps` omits
 * `title`/`aria-describedby`/the focus handlers entirely and `srOnlyTooltip`
 * renders nothing, rather than wiring `aria-describedby` up to an empty
 * `sr-only` span (which would give screen-reader users a description that
 * resolves to nothing). */
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
          // Decorative only: the accessible description is already covered,
          // unconditionally, by the `sr-only` span above via
          // `aria-describedby`, giving this one a `tooltip` role too would
          // double-announce the same text to assistive tech, so it stays
          // `aria-hidden`. `data-testid` gives tests a stable hook without
          // reaching for an ARIA role that would contradict `aria-hidden`.
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
