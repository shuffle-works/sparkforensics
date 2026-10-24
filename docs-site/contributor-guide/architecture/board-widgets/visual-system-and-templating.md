# Visual system and templating

The styling system the board widgets share and the rules that keep their templating free of injected markup.

## Visual system

Tailwind CSS v4 + shadcn/ui (Base UI primitives). The design tokens (colors,
including the Trace palette, see `docs/DESIGN.md`) are defined as CSS variables in
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

## Spacing roles

Spacing uses five named roles on the 4px scale, defined in the `@theme` block
of `src/index.css`. Each role is a Tailwind spacing key, so it works in any
spacing utility (`mt-label`, `space-y-para`, `gap-card`) and as
`var(--spacing-label)` in CSS.

| Role | Size | Use |
|------|------|-----|
| `tight` | 4px | A title and its caption, or a label and its figure |
| `label` | 8px | An eyebrow or heading and the content it names |
| `para` | 8px | One paragraph and the next in a single block |
| `card` | 16px | One block and the next inside a card |
| `section` | 24px | One section and the next |

`card` equals the default `Card`'s `--card-spacing`. Use `pt-(--card-spacing)`
inside a card so a `size="sm"` card keeps its 12px.

Rules for a spacing change:

- Do not set a margin on a class in `src/theme/*.css` that components also
  space with a utility. Those files are not in a cascade layer, so a margin
  there beats `mt-*`, `mb-*` and `space-y-*` on the same element.
- Do not put a `gap` on a `Collapsible`: a closed panel keeps the gap. The
  open body and the collapsed summary carry their own top padding.
- Do not use a negative margin for rhythm.

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

## Tag badge anatomy

`TagBadge` (`src/view/ImpactBadge.tsx`) renders the impact dot and the ALL-CAPS
tag as one pill built from two abutting halves:

- The dot+tag `Badge`, rounded on its left only when the guide link follows (at
  Advanced density).
- The guide `<a>`, rounded on the right, immediately after it.

The halves are siblings, never one `<a>` nested inside another: nested anchors
are invalid HTML, and a pill-wide anchor would need a second link inside it. The
guide link is hand-styled rather than built from `Badge`, because `Badge`'s
`overflow-hidden` would clip the link's `tap-target-comfortable` overlay. That
overlay deliberately paints outside the link's visual bounds to reach a
touch-friendly size without growing the pill.
