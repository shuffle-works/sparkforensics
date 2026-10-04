---
name: SparkForensics
description: Trace, an instrument panel around the run clock for browser-local Spark event-log analysis.
colors:
  canvas: "#f3f4f6"
  panel: "#ffffff"
  surface-2: "#f7f8fa"
  ink: "#16181d"
  muted: "#5f6672"
  rule: "#e1e3e8"
  rule-soft: "#eceef1"
  accent: "#4f46e5"
  accent-hover: "#4338ca"
  accent-soft: "#eceafd"
  critical: "#c12a1c"
  warning: "#915a00"
  info: "#2463c7"
  clean: "#1a7541"
  plan-aggregate: "#8a4fd1"
  chart-stage: "#6b72e8"
  chart-startup: "#b8bfcc"
  chart-gap: "#e0b26a"
  chart-idle: "#e1e3e8"
  canvas-dark: "#14161b"
  panel-dark: "#1b1e25"
  surface-2-dark: "#21252d"
  ink-dark: "#e6e8ee"
  muted-dark: "#9097a3"
  rule-dark: "#2b2f38"
  rule-soft-dark: "#23262e"
  accent-dark: "#9d97ff"
  accent-hover-dark: "#b6b1ff"
  accent-soft-dark: "#25234a"
  critical-dark: "#ff7b6e"
  warning-dark: "#f0b450"
  info-dark: "#7aaaf5"
  clean-dark: "#5fcc8c"
  plan-aggregate-dark: "#bc8cff"
  chart-stage-dark: "#8b86f5"
  chart-startup-dark: "#4a5160"
  chart-gap-dark: "#a8814a"
  chart-idle-dark: "#2b2f38"
typography:
  body:
    fontFamily: "'Instrument Sans Variable', 'Instrument Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    axes: "wght,wdth@400..700,75..100"
  heading:
    fontFamily: "{typography.body.fontFamily}"
    fontStretch: "85%"
  label-mono:
    fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace"
    axes: "wght@100..800"
  eyebrow:
    fontFamily: "{typography.label-mono.fontFamily}"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.08em"
    textTransform: "uppercase"
  metric:
    fontFamily: "{typography.label-mono.fontFamily}"
    fontSize: "30px"
    fontWeight: 600
    letterSpacing: "-0.02em"
rounded:
  tag: "3px"
  button: "4px"
  panel: "6px"
  full: "9999px"
spacing:
  compact: "12px"
  standard: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.button}"
    padding: "0 10px"
    height: "32px"
  button-ghost:
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "0 10px"
    height: "32px"
  widget-card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.rule}"
    rounded: "{rounded.panel}"
    padding: "16px"
  tag-chip:
    fontFamily: "{typography.label-mono.fontFamily}"
    fontSize: "11px"
    rounded: "{rounded.tag}"
    padding: "0 6px"
    height: "20px"
  metric-gauge:
    height: "6px"
    backgroundColor: "{colors.chart-idle}"
---

# Design system: SparkForensics

## Overview

**North Star: "Trace"**

SparkForensics is an instrument panel built around one run clock. Every stage and every finding sits on the same seconds-from-start axis, so a reader can follow a problem from the verdict to the chart to the table without re-orienting. The look belongs next to Observable and Honeycomb: white panels on a quiet gray canvas, a single indigo accent, numbers and labels in mono, and status color held back for what the analysis actually found.

The reader we design for first is a newcomer to Spark tuning. The board is airy rather than dense: one verdict sentence, a few numbered steps, then evidence on demand. Power users get more through Advanced view, never through a busier default.

**Key characteristics:**

- Panels on a gray canvas, separated by a 1px rule and a 6px corner, not by shadow.
- One accent (indigo) for actions and focus; four status colors only for analysis status.
- Mono for every figure, tag, label and axis tick; Instrument Sans for prose and headings.
- One run clock shared by the verdict strip, the job timeline and step codes.
- Light and dark carry the same meaning; dark is slate, never pure black, no neon.

## Colors

Tokens live in `src/index.css`. Bare `:root` is the dark theme and `:root[data-theme="light"]` overrides it. The Trace names map onto the older token names: canvas is `--bg`, panel is `--surface`, ink is `--text`, muted is `--text-muted`, rule is `--border`; `--canvas`, `--panel`, `--ink` and `--rule` alias them. The docs site mirrors the same values as `--sf-*` in `docs-site/.vitepress/theme/custom.css`.

### Neutrals

| Token | Light | Dark | Role |
|---|---|---|---|
| canvas (`--bg`) | `#f3f4f6` | `#14161b` | Page field behind panels |
| panel (`--surface`) | `#ffffff` | `#1b1e25` | Cards, popovers, the reading surface |
| surface-2 | `#f7f8fa` | `#21252d` | Muted and secondary fills, code blocks |
| ink (`--text`) | `#16181d` | `#e6e8ee` | Titles, figures, body copy |
| muted (`--text-muted`) | `#5f6672` | `#9097a3` | Labels, captions, axis text |
| rule (`--border`) | `#e1e3e8` | `#2b2f38` | Panel borders, dividers, chart grid |
| rule-soft | `#eceef1` | `#23262e` | Quieter separators |

### Accent

| Token | Light | Dark | Role |
|---|---|---|---|
| accent | `#4f46e5` | `#9d97ff` | Primary action text, links, focus ring, selection |
| accent-hover | `#4338ca` | `#b6b1ff` | Hover on accent text |
| accent-soft | `#eceafd` | `#25234a` | Primary button fill, icon wells |

Text on solid accent uses `--accent-ink` (`#ffffff` light, `#14161b` dark).

### Status

| Token | Light | Dark | Chip tint (`*-dim`) |
|---|---|---|---|
| critical | `#c12a1c` | `#ff7b6e` | 12% of the status color |
| warning | `#915a00` | `#f0b450` | 12% |
| info | `#2463c7` | `#7aaaf5` | 12% |
| clean | `#1a7541` | `#5fcc8c` | 12% |

The light status colors are darkened from the mockup values (`#c42b1c`, `#b06d00`, `#1f8a4c`) so each status color, used as badge text over its own 10% tint, holds at least 4.5:1 against that tint on every light surface including surface-2. `tests/view/impact-badge-contrast.test.ts` guards this; a new light status value must pass it.

**Plan aggregate** (`#8a4fd1` light, `#bc8cff` dark) is reserved for SQL-plan-level data so it never reads as a status. The plan graph's per-node duration heat bar is the one exception: it reuses critical, warning and info, so a node's time share reads in the board's status language.

### Chart series

| Token | Light | Dark | Role |
|---|---|---|---|
| chart-stage | `#6b72e8` | `#8b86f5` | Neutral stage and volume bars |
| chart-startup | `#b8bfcc` | `#4a5160` | Startup before the first job |
| chart-gap | `#e0b26a` | `#a8814a` | Scheduler gaps, a muted amber |
| chart-idle | `#e1e3e8` | `#2b2f38` | Idle capacity, gauge tracks |

Charts read colors through `CHART_COLORS` in `src/view/charts/ChartTheme.tsx`, which points at the CSS variables so the theme swap applies live.

**The status-only rule.** Critical, warning, info and clean appear only where the analysis supplies that status: impact dots, tag chips, a flagged card's edge, a flagged stage's bar or row, comparison deltas and load errors. Never use them for decoration, category coding or emphasis. Neutral series use the chart tokens; a flagged mark switches to the status color, never to another series color.

**The magnitude rule.** A status color may encode magnitude only on a dimension a detector already treats as a problem axis, such as duration share or spill. Neutral magnitudes, such as bytes or rows, use chart-stage or a neutral tone, because volume is not a defect. Whether something reads as a finding is still decided by a finding, not by size.

## Typography

**UI and headings:** Instrument Sans Variable (weight 400 to 700, width axis 75% to 100%).
**Figures and labels:** JetBrains Mono Variable (weight 100 to 800).

Both are self-hosted. `src/theme/fonts.css` declares upright latin and latin-ext subsets from `@fontsource-variable`; Vite bundles the woff2 files and the single-file HTML export inlines them. The docs site imports the same packages in `docs-site/.vitepress/theme/index.ts`. The app, an HTML export and the docs make no runtime font request. Do not add a webfont CDN, italics or extra subsets: every subset is inlined into every export.

Headings (`h1`, `h2`, `h3`) run Instrument Sans at `font-stretch: 85%` (`--font-stretch-heading`), which gives titles a compact instrument feel without a second family.

### Hierarchy

- **Verdict title:** semibold, 22px, 26px from `sm`.
- **Landing hero:** semibold, fluid 32px to 52px, `-0.02em` tracking.
- **Card title (`h3`):** semibold, 14px, owned by `WidgetCard`.
- **Body and controls:** 14px; supporting text 12px in muted.
- **Metric figure:** JetBrains Mono 30px semibold, `-0.02em`, tabular figures. A unit beside the figure renders smaller (16px, medium) and muted.
- **Label:** JetBrains Mono 11px, weight 500, uppercase, `0.06em` to `0.08em` tracking, muted (`.trace-eyebrow`).
- **Tag chip text:** JetBrains Mono 11px semibold, `0.06em` tracking, all caps.
- **Step code (F1, F2, F3):** JetBrains Mono 12px semibold, tabular.

**The mono-for-data rule.** If it is a number, a unit, a tag, a step code, a stage id, an axis tick or a label that names a data group, it is mono. Everything else is Instrument Sans.

The mono label names something the reader is looking at: a metric tile, a findings band, a comparison side, a list. It is not a decorative line placed above a headline that already says what the section is.

## Layout

The board keeps its reading order: verdict, then numbers, then evidence. `RunVerdict` answers "how did this run go and where do I start" in one sentence and lists at most three numbered next steps. The Scorecard follows, then the Findings and Full app report tabs with every finding and widget.

The shell is a single column with a compact bordered top bar and a 16px page inset. Regions sit on a 24px vertical rhythm; card interiors use 16px, or 12px for compact cards. Widget boards are one column on small screens, two from the medium breakpoint and three from extra-large; an expanded card spans the board so charts and tables get room. Tables scroll horizontally rather than squeezing columns.

### Reading order and disclosure

- **One place, one step.** Findings on the same stage fold into one step, because they usually share a cause and their savings overlap.
- **Plain language leads, Spark terms follow.** A step's first line is the plain explanation; metric names and configuration keys come after.
- **Action first, evidence on demand.** Each Findings band leads with its rows; in Basic view the detail widgets wait behind one "Show the evidence" disclosure, and any route to a finding opens it.
- **Basic by default, Advanced on request.** Advanced view adds the finding filter bar, confidence markers, threshold captions, extra columns and doc icons (`AdvancedOnly`). A control that explains current state stays visible in Basic.

### The run clock

Every time-based view uses seconds from application start, with the same domain and ticks (`src/view/charts/run-clock`). The verdict strip, the job timeline and anything new that plots time must share it, so a stage sits in the same place everywhere.

## Elevation and depth

Trace is flat. Hierarchy comes from panel against canvas and the 1px rule, not from shadow. `--shadow-widget` is a hairline (`0 1px 2px` at 4% ink in light, 24% black in dark) and the hover shadow is only slightly deeper. A stronger visual signal must mean state, impact or interaction; do not lift ordinary content.

## Shapes

Three radii, each with one job:

- **6px** (`--radius-panel`): panels, cards, the verdict, findings tables, dialogs, chart tooltips.
- **4px** (`--radius-button`): buttons, inputs, icon wells.
- **3px** (`--radius-tag`): tag chips and proof chips.

In Tailwind, `rounded-sm` is 3px, `rounded-md` and `rounded-lg` are 4px, and `rounded-xl` is 6px. Gauges and strip bars use 1px to 2px corners. Impact dots are circles; nothing else is round.

## Components

### Panels and widget cards

Every widget self-wraps in `WidgetCard` (`src/view/WidgetCard.tsx`), which renders the shadcn `Card`: panel background, 1px rule ring, 6px corners. `WidgetCard` owns the card's `<h3>`; widgets never render their own title heading. A flagged card adds a 3px left edge in its impact color. Collapsible cards put a chevron beside the title and keep the body mounted while closed so its text stays findable.

Landing and comparison surfaces use the same panel through `.trace-panel` and `.drop-zone-panel`. The drop zone is a panel, not a dashed box; only drag-over turns its border dashed and accent.

### Buttons

- **Primary:** accent text on the accent-soft fill, 4px corners, 32px tall; hover deepens the fill by mixing in 12% accent. Quieter than a solid fill and at least 4.5:1 in both themes. The `default` and `soft` variants of `src/components/ui/button.tsx` both render this.
- **Outline, secondary, ghost:** neutral; ghost is transparent until hover.
- **Destructive:** critical text on a 10% critical tint (20% in dark).
- **Focus:** the shared accent ring (3px at 50%); active presses move down 1px.

On touch, `tap-target-comfortable` grows the hit area to 44px without changing the 32px visual size.

### Tag chips and impact dots

A finding is flagged with an impact dot plus an ALL-CAPS tag chip (`TagBadge` in `src/view/ImpactBadge.tsx`). The chip has 3px corners, status text on a 10% tint of the same status, 20px height and mono 11px semibold text. The dot is an 8px circle in the status color. Tag text always comes from `typeTag(type)`; never hand-type it. The dot is decorative to assistive tech; the tag text is what is read.

### Verdict and stage strip

The verdict is a panel with the verdict sentence as its `h2`, a one-line summary, the stage strip, then the numbered next steps. A failed run tints the panel border critical at 40%; a clean run tints it clean.

`VerdictStrip` draws up to eight of the longest stages as bars on the run clock, plus any stage a step points at. Neutral stages use chart-stage at 85% opacity; a step's stage takes its impact color and carries its step code, inside the bar when the bar is at least 8% of the run, beside it otherwise. Rows are 22px with mono 11px stage labels and a mono 10px tick axis; vertical gridlines use the rule color.

### Step codes

Next steps are coded F1, F2, F3 (`StepCode`, `src/view/StepCode.tsx`). The same code marks the verdict step, its bar on the strip, its Findings row and its Stage Summary row, so one finding can be followed across the board. The code is mono, colored by its impact band on the verdict, muted elsewhere. A step row is a grid of code, title and savings, with the savings stacked on the right and reflowing under the title below 640px.

### Metric tiles

Scorecard tiles have a mono label, a mono 30px figure with a smaller muted unit, a one-line muted caption and a 6px gauge. The gauge track is chart-idle; its fill is the tile's status color when flagged, clean when not. Wall-clock's gauge is neutral (muted ink for active, 35% muted for the rest), because wall-clock is a measurement, not a grade. Only a flagged tile carries a status dot beside its label. Tiles are separated by the grid's dividers, never by a border on the tile itself.

### Findings and stage tables

Findings rows sit in a panel per severity band, with 10px by 12px cells and 16px outer padding. A flagged Stage Summary row carries a 3px inset rule in its impact color on its first cell. Every affected stage is flagged, never only the worst.

### Charts

Charts render through `ChartFrame`, which pins height and turns off series animation under reduced motion. Axis ticks and legends are mono. Tooltips draw on the popover surface with a 1px rule, 6px corners and 12px text, so they read in both themes. Each chart can expose its data as a table and copy it as TSV.

### Navigation

A single compact top bar with a bottom rule: the current-file switcher at left with app metadata beneath, a global status chip, then icon actions for docs, theme and loading a new run. Metadata truncates; actions never wrap.

### Docs site

`docs-site/.vitepress/theme/custom.css` maps Trace onto VitePress: panel is the reading surface (`--vp-c-bg`), canvas backs the sidebar and home (`--vp-c-bg-alt`), surface-2 backs code blocks and callouts. Brand buttons are accent text on accent-soft. Callouts share one quiet shape (rule border, 3px status edge, 12% tint) and status colors appear only in status callouts and tuning-reference severity marks.

## Do's and don'ts

### Do

- Put panels on the gray canvas with a 1px rule and 6px corners.
- Flag every affected stage with an impact dot, an ALL-CAPS tag and, where the widget has one, a 3px status edge.
- Set every figure, unit, tag, step code and axis tick in mono.
- Plot time on the shared run clock.
- Keep light and dark equivalent in meaning; a theme switch never changes what is flagged.
- Keep rendered copy domain-agnostic: no company, industry or dataset references.

### Don't

- Don't use critical, warning, info or clean for anything the analysis did not flag.
- Don't fill primary buttons with solid accent; primary is accent-soft with accent text.
- Don't render a widget title outside `WidgetCard`, or a second heading for the same card.
- Don't load fonts from a CDN or add a runtime font request to the app, export or docs.
- Don't use pure black, neon or glow in dark mode.
- Don't replace tags with emoji, glyph icons or nonstandard status symbols.
- Don't place a mono label above a heading as a decorative kicker.
