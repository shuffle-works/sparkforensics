# Visual system and templating

The styling system the board widgets share and the rules that keep their templating free of injected markup.

## Visual system

Tailwind CSS v4 + shadcn/ui (Base UI primitives). The design tokens (colors,
including the telemetry-console dark palette) are defined as CSS variables in
an `@theme inline` block and consumed via Tailwind utility classes; there is
no hand-authored BEM CSS. Theme polarity:
dark = bare `:root` (no attribute), light =
`:root[data-theme="light"]`, toggled by `src/theme/ThemeProvider.tsx` and
persisted to `localStorage`. `index.html`'s inline FOUC-prevention script
runs before React mounts. Mono is the typeface for numerics
(`--font-mono`), applied via a `.num`-equivalent Tailwind utility per call
site rather than one global class. Charts are Recharts
(`src/view/charts/ChartTheme.tsx`'s `CHART_COLORS`, read from the same CSS
tokens). React re-renders on theme toggle, so chart colors
update live with the theme. `ChartFrame` can also expose the underlying rows through a
toggleable accessible table and copy them to the clipboard as TSV.

## Templating (XSS-safe)

JSX auto-escapes every interpolated value by default. No `.innerHTML`
assignment exists anywhere in the view layer (the one `dangerouslySetInnerHTML`,
shadcn's `ChartStyle` in `src/components/ui/chart.tsx`, only writes CSS
variables from the static chart config).

One Base UI-specific gotcha:
`WidgetCard.tsx` passes `aria-expanded={String(open) as 'true' | 'false'}`
rather than the raw boolean, because Base UI's `Collapsible.Trigger` otherwise
overrides a boolean `aria-expanded` prop with its own internal state via prop
merging. The explicit `String()` cast keeps the rendered attribute in sync
with this app's own `open` state.
