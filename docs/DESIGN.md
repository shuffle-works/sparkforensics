---
name: SparkForensics
description: A dark-first diagnostic dashboard for browser-local Spark event-log analysis.
colors:
  midnight-canvas: "#080b0d"
  surface: "#11171a"
  raised-surface: "#17202c"
  border: "#233035"
  primary-text: "#f4f4f5"
  muted-text: "#a9b5b4"
  signal-orange: "#ff6b2c"
  alert-red: "#ff5d57"
  warning-amber: "#f0b429"
  info-blue: "#5aa2ff"
  healthy-green: "#48d17f"
  plan-violet: "#bc8cff"
typography:
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  label-mono:
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace"
  docs-ui:
    fontFamily: "'Recursive', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    axes: "wght,CASL@400..700,0..1"
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  full: "9999px"
spacing:
  compact: "12px"
  standard: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.signal-orange}"
    textColor: "#06211e"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  button-ghost:
    textColor: "{colors.primary-text}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  widget-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.lg}"
    padding: "16px"
  impact-chip:
    rounded: "9999px"
    padding: "2px 8px"
---

# Design System: SparkForensics

## Overview

**Creative North Star: "The Diagnostic Instrument"**

This is an operating dashboard for Spark performance investigation: compact and direct, built for signal rather than decoration. The dark-first canvas keeps charts and tables legible during long analysis sessions, findings included. A matching light theme gives the same hierarchy in brighter environments.

The UI treats visual emphasis as diagnostic evidence. Orange marks the active control or healthy action path; red, amber, blue, and green stay semantic status signals. Repeated panels form an inspection surface where impact-band borders, compact labels, and collapsible detail make anomalies easy to find without turning every metric into an alert.

**Key Characteristics:**

- Dense enough for operational analysis, never visually noisy.
- Dark surfaces separated by tone and fine rules rather than heavy containers.
- Semantic color is reserved for status, findings, charts, focus, and actions.
- Card-first composition, so evidence can be scanned and expanded, then compared.

## Colors

The palette is a dark instrumentation palette with an equivalent light mode. Neutral layers carry structure; status colors carry meaning.

### Primary

- **Signal Orange:** the application accent for primary actions, selected states, focus treatment, and healthy emphasis. `#ff6b2c` in dark mode, `#bf4413` in light mode.

### Secondary

- **Plan Violet:** used only for aggregate SQL-plan visualizations, so plan-level data stays distinct from impact-band states. Exception: the plan graph's per-node duration heat bar (`PlanGraphNode.tsx`, banded by `plan-graph-heat.ts`'s `heatBand`) deliberately reuses the impact-band `bg-critical`/`bg-warning`/`bg-info` tokens instead, so a node's duration share reads with the same critical/warning/info visual language as the rest of the dashboard.

### Neutral

- **Midnight Canvas:** the default app background and dark-mode field behind the dashboard.
- **Surface:** the standard layer for cards and popovers.
- **Raised Surface:** the layer for hover states and secondary or muted controls.
- **Fine Divider:** low-contrast structural borders between panels and controls.
- **Primary Text:** text for metrics and titles, plus body copy.
- **Muted Text:** supporting context, secondary labels, and chart annotations.

### Status

- **Alert Red:** critical finding state and destructive action treatment.
- **Warning Amber:** warning state and incomplete or degraded outcomes.
- **Info Blue:** informational finding state and neutral analysis signal.
- **Healthy Green:** clean status, successful outcomes, and no-finding confirmation.

**The Signal-Only Color Rule.** Use Signal Orange for a control or intentionally positive emphasis. Use status colors only when the underlying analysis supplies that status; never use them as arbitrary decoration.

**The Magnitude-Encoding Clause.** Encoding a magnitude with color is allowed, under two constraints. Status colors (Alert Red, Warning Amber, Healthy Green) may encode a magnitude only on a dimension a detector already treats as a problem axis, such as duration share or spill; on those dimensions a hot color is an honest claim that more is worse. Neutral magnitudes, such as bytes moved across an exchange or rows produced by an operator, use a single-hue ramp (Signal Orange or a neutral tone), never the status palette, because raw volume is not a defect. Whether an element reads as a finding is still driven by an actual finding, not by size alone.

## Typography

**Display Font:** System UI stack (with platform-native fallbacks)

**Body Font:** System UI stack

**Label/Mono Font:** UI monospace stack (with SF Mono, JetBrains Mono, Cascadia Code, Menlo & Consolas fallbacks)

**Character:** Native system typography makes dense performance data quick to read and keeps the dashboard familiar across developer workstations. Monospace labels are a diagnostic cue for compact impact chips and technical values.

### Hierarchy

- **Section title** (semibold, 18px): dashboard-level regions such as Reference.
- **Card title** (bold, 16px): every widget's scan anchor.
- **Control and body text** (medium/regular, 14px): default interaction and explanatory copy.
- **Supporting text** (regular, 12px): application metadata, chart annotations, and secondary context.
- **Diagnostic label** (medium, 12px, monospace when it is a compact technical tag): impact chips and terse classifications.

**The Scan-First Type Rule.** Titles and key metrics should be readable before supporting explanation. Keep detail text subordinate and never use display-style typography for analytical content.

**Docs Site Addendum.** The published docs site (`docs-site/`) is a separate Read-mode surface: a visitor there is reading to understand, not operating a dashboard. It uses 'Recursive' (variable font, weight+casual axis `wght,CASL@400..700,0..1`) for body text and 'JetBrains Mono' for code, both loaded from Google Fonts, distinct from the dashboard's system-UI/monospace stack. The dashboard's Operate-mode typography stays about density and native familiarity; Read-mode documentation benefits from a more editorial, distinctive typeface instead.

## Layout

The dashboard is a single-column application shell with a compact, bordered top bar and a 16px page inset. Major regions use a 24px vertical rhythm. Widget boards are one column on small screens, two columns from the medium breakpoint, and three columns from the extra-large breakpoint; expanded widget cards span the available board width so charts and tables get useful inspection space.

Card interiors use a 16px default rhythm and a 12px compact rhythm. Tables may overflow horizontally rather than sacrificing column legibility. The top bar keeps a flexible current-file area, a small global health chip, and icon actions; long names truncate instead of changing the chrome's height.

### Reading order and disclosure

The run board reads top to bottom as verdict, then numbers, then evidence. `RunVerdict` answers "how did this run go and where do I start" in one sentence, then lists at most three numbered next steps, each in the same order: what is happening in plain language, what to try, and a route to the evidence. The Scorecard follows, then the Findings and Full app report tabs holding every finding and widget.

- **One place, one step.** Findings on the same stage fold into one step, because they usually share a cause and their savings overlap. Never show one root cause as several equal problems.
- **Plain language leads, Spark terms follow.** A step's first line is the plain explanation; metric names, ratios and configuration keys come after it.
- **Action first, evidence on demand.** On the Findings tab each band leads with its rows, which say what to do; in Basic view the band's detail widgets wait behind one "Show the evidence" disclosure, and any route to a finding opens it. Evidence is never hidden from a Basic reader, only deferred until asked.
- **Basic by default, Advanced on request.** Basic view keeps what a newcomer needs to act. Advanced view adds power controls and meta detail: the finding filter bar, confidence markers, threshold captions, extra columns and doc icons (`AdvancedOnly`). A control that explains current state, such as an active filter, stays visible in Basic view.

## Elevation & Depth

The system is **flat and layered**. Background tone, hairline borders, and a small left impact-band rule create hierarchy. Shadows are subtle, used only to separate widgets from the canvas or to acknowledge hover, so no card competes for attention.

### Shadow vocabulary

- **Widget resting shadow:** a thin top definition plus a soft, low-spread shadow under cards.
- **Widget hover shadow:** a slightly deeper version of the resting shadow; it signals interactivity without changing the panel's semantic importance.

**The Evidence-Over-Elevation Rule.** A stronger visual signal must communicate state, impact, or interaction. Do not add decorative lift to ordinary content.

## Shapes

Panels have rounded corners: controls use medium rounding, and cards and dialogs use large rounding. Thin neutral borders define fields and menus. Impact bands use a straight colored left card edge and circular status dots, not ornamental shapes.

## Components

### Buttons

**Character:** compact, practical controls that stay out of the way until used.

- **Shape:** rounded control geometry.
- **Primary:** Signal Orange fill with dark ink; used for the clearest affirmative action.
- **Ghost:** transparent at rest and lightly surfaced on hover; standard for top-bar icon actions and file selection.
- **Hover / Focus:** hover uses a small tonal shift. Keyboard focus uses the orange ring; active buttons move down by one pixel as tactile confirmation.

### Impact chips

**Character:** terse diagnostic labels, not decorative badges.

- **Style:** low-opacity status-color background with matching text, optional colored dot, and a fully rounded outline.
- **Typography:** monospace for compact technical labels; finding tags stay short and all caps.
- **State:** every impact-band style always follows its matching status token.

### Cards / Containers

**Character:** inspection panels with one clear title and expandable evidence.

- **Corner Style:** large rounded corners.
- **Background:** standard surface layer, with fine outline and widget shadow.
- **Impact band:** affected cards gain a 4px left border in the relevant status color.
- **Internal Padding:** standard 16px, compact 12px for smaller widgets.
- **Disclosure:** card headers are clickable when content can collapse; a small chevron reports the state without consuming title space.

### Navigation

**Character:** a utilitarian application header, not a marketing navigation bar.

- **Style:** a single compact row with a bottom divider.
- **Contents:** current-file switcher at left, app metadata beneath its name when available, a global status chip, then icon-only actions for documentation and theme, plus loading a new run.
- **Responsive behavior:** file metadata truncates; fixed-size actions remain visible and do not wrap.

### Inputs / Fields

**Character:** quiet, bordered controls that show interaction through focus rather than permanent accent fills.

- **Style:** transparent or surface-backed field with a neutral border and medium rounding.
- **Focus:** the border and ring use Signal Orange.
- **Error:** destructive state switches the border and focus ring to Alert Red.

## Do's and Don'ts

### Do:

- **Do** use neutral layers and fine borders to organize dashboard structure.
- **Do** make a finding's impact band visible through its colored dot, all-caps tag, and affected widget border.
- **Do** keep compact metadata and technical labels in the system and monospace stacks.
- **Do** allow dense tables and charts to use the full grid width when expanded.
- **Do** keep dark and light themes semantically equivalent; theme changes should not change meaning.

### Don't:

- **Don't** use red, amber, blue, or green as generic decoration or unrelated category colors.
- **Don't** turn status chips into primary calls to action.
- **Don't** add heavy shadows, gradients, or oversized type that weakens scanability.
- **Don't** replace concise diagnostic tags with emoji or nonstandard status symbols.
- **Don't** make a widget title compete with its evidence; title, summary, then detail is the intended reading order.
