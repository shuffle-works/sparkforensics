# Finding widget shell

How a finding widget is built, and the steps to add one.

Every finding widget is made by one function, `defineFindingWidget`
(`src/view/finding-widget.tsx`). It takes a per-widget row model and a `Row`
component. The model decides what the widget shows. The `Row` draws it. The
shell owns everything else.

## What each part owns

- The row model, `<Widget>.rows.ts`, owns the facts. A row decides, as data,
  whether its finding is stated by the line above an evidence panel and what the
  density shows (for example a `showStatus` flag). The `rows` function is pure.
- The `Row` component, `<Widget>.tsx`, renders only what its row says. It makes
  no decision of its own and reads no store, context or density.
- The shell owns the `WidgetCard`, the title (the finding's core name from
  `findingName`, unless the model gives a plural `title`), the ALL-CAPS tag, the
  sort toggle, the paging, the route index and the row anchors. See
  [List sort mode](./list-sort-mode.md), [Row/expand contract](./row-expand-contract.md)
  and [Investigation routing](./investigation-routing.md).
- Mounting follows the rows. The widget renders when `rows(...).length > 0` and
  renders nothing otherwise. The same `rows` function feeds the evidence panel,
  `computeActiveWidgets` and the Clean checks list, so the card, its evidence
  control and its panel exist together or not at all. A model sets
  `alwaysMounted` only for a run-wide reference tile.

## Row model

`FindingWidgetModel` (`src/view/finding-widget.tsx`) has these fields. Only
`type`, `rows` and `stageOf` are required.

- `type`: the finding type.
- `rows`: a `RowsOf` function. It takes `PanelInput` and returns the rows in
  base order. `PanelInput` has the findings, the stated ids, the density, the
  `appModel` and the run's catalog. Every row lists the findings it stands for in `findings`.
- `stageOf`: the stage number of a row, for the stage sort. It returns null for a
  row with no stage.
- `summary`: the collapsed card's lead value and context.
- `title`, `tagClassName`, `tagDocAnchor`: a plural card title, tag colour
  classes, and a doc anchor taken from the rows.
- `findings`: the findings the widget is for, when it is not the type's findings
  in the catalog (Config Audit reads `configFindings`).
- `sections`, `jumpLabel`, `rowElement`, `rowClassName`, `separated`,
  `listClassName`: sections with their own paging, the jump control, and the row
  layout.

The view passed beside the model has a required `Row` and the optional `Lead`,
`Summary`, `Frame` and `Status` slots.

## Adding a finding widget

1. Add the detector side first: the `DETECTORS` entry, the `finding-types.ts`
   member and the other items in
   [Detector contract](../detector-contract.md). The compiler reports a missing
   piece.
2. Add the presentation row in core, `FINDING_PRESENTATION` in
   `packages/core/src/finding-presentation.ts`. It holds the finding's name, tag,
   family, one-sentence pitch and summary. The card title comes from the name.
3. Add `src/view/widgets/<Widget>.rows.ts`. It exports the row type (extending
   `WidgetRow<'type'>`), the `rows` function and the model. Put every decision in
   the row: whether it is stated (`isStated(finding, stated)`), what the density
   shows, which extension text it has. Return no row for a finding the widget has
   nothing to show for. `RetryWaste.rows.ts` is the smallest example.
4. Add `src/view/widgets/<Widget>.tsx`. It has a `Row` component and
   `export const <Widget> = defineFindingWidget(<widget>Model, { Row })`.
   `RetryWaste.tsx` is the smallest example.
5. In `src/view/detector-registry.tsx`, add the lazy import for the widget and
   the `REGISTRY` entry with its `component`, `widgetId`, `routeable` and
   `model:`. The entry has no `content` and no hand-written `region`; the region
   comes from the presentation row.
6. Test the `rows` function in the widget's own test file: the rows for a
   finding that is stated and one that is not, at Basic and at Advanced. Do not test title, tag,
   sort, paging, route index or anchors there. `tests/view/finding-widget.test.tsx`
   tests them once for every widget.
7. Add the tag to `AGENTS.md`'s tag list when it is new, and add the
   `.changeset/*.md`.

## Rules

- A row decides the stated and density facts as data. The `Row` renders only
  that.
- The shell owns the card, the title, the tag, the sort, the paging, the route
  index and the anchors. A widget file does not use `WidgetCard`, `TagBadge`,
  `RowPagination`, `SortModeToggle` or `AdvancedOnly`, and does not call the sort,
  paging, anchor, route, density or inline-evidence hooks
  (`finding-widget-uses-the-shell`).
- `.rows.ts` files are pure. They may not import React, the store, a context or
  a hook module, call a hook, or read a global, the clock or randomness
  (`rows-are-pure`, `rows-are-pure-inline`). A value a row needs goes into
  `PanelInput`.
- A table cell never compares numbers, and a chip comes from a finding
  (`no-numeric-severity-in-cell`). StageTable shows a chip on a Retried or Spill
  cell only when the `retryWaste` or `spill` detector flagged the stage, in that
  finding's impact band. Fetch Wait and I/O Ratio show raw numbers.
- Hiding after render is banned, including `empty:hidden`. An element with
  nothing to show is not a row.

See [Structure rules](../../testing.md#structure-rules) for the rules and
[Evidence placement](../widget-rendering.md#evidence-placement) for where a
finding's evidence shows.
