# List sort mode

How a finding widget's list sorts, and when the sort toggle shows.

`src/view/impact-sort.ts` (`canToggleSort`,
`orderByImpact`, `byStageAsc`), `src/view/useSortMode.ts` and
`src/view/SortModeToggle.tsx` hold the sort. `stageIdOf`, the stage key of a
finding, lives in core (`packages/core/src/findings-of-type.ts`). The finding widget shell
(`defineFindingWidget`, see [Finding widget shell](./finding-widget-shell.md))
is the only caller, so every finding widget lists its rows the same way and a
widget file writes no sort code. A widget's model gives the shell one thing:
`stageOf`, the stage number of a row (null when it has none).
`orderByImpact` places each row at its best-ranked finding in the run interpretation's `savingsRank`
(core's `rankBySavings`: stage task time or idle core time, then potential savings). The export bundle cannot import
that ranking, so views read the carried rank.
The shell gets its `sortMode` (`SortMode`, `'impact' | 'stage'`, default
`'impact'`) from `useSortMode`, which forces impact order at Basic density, and renders a
`SortModeToggle` in the `WidgetCard` `badges` slot, so it sits on the title row itself
rather than floating in the body: a button alongside the widget's tag badges (a
`WidgetCard` header renders `badges` beside the title heading, never inside another
control). The `canToggleSort` check, which `useSortMode` binds
to the interpretation, covers every group of rows. A widget with sections (Gc
Pressure's high-GC and low-GC sections) shows one shared toggle, and each
section sorts its own rows.
It is a two-segment `ToggleGroup` (Impact / Stage; optional `stageLabel`, default "Stage",
which no caller overrides), wrapped in `AdvancedOnly`: stage number is the one axis every one of these widgets' items
can be compared on. Neither mode sorts by impact band, which ranks findings by how bad they
are, not by how much fixing them would save. A per-stage
detector's own `finding.stageId` is the sort key directly; a sql-scope finding that spans
several stages (`duplicatePlanSubtree`, `smallFiles`, `nestedLoopJoin`, `joinKeyCast`, `mergeRewrite`, `unprunedScan`, `pythonUdf`, `underBroadcast`, `overBroadcast`,
via `stageIds`) sorts by the lowest stage id it touches (`stageIdOf`). The toggle renders
only when `canToggleSort` holds: the card is open, a finding in the rows has a place in
`savingsRank`, and the stage order lists a different sequence of stage ids than the impact
order. The shell passes the same rows, in the same order, to `orderBy` and to the gate, with the
same finding and stage accessors. The gate compares the stage id of each position in both orders
over all rows, so pagination does not affect it, and rows tied on one stage never show it. The toggle is hidden when the stage order adds no stage
information: all rows share one stage, have none, or are already in stage order. With no ranked finding the
impact order is the input order, so the toggle would do nothing. Rows with no
rankable finding, and `byStageAsc` ties, keep their prior relative order
(`Array.prototype.sort`'s stability) rather than being shuffled.
A sectioned widget shows its one toggle when either section has differing orders.
`FixTheseFirst`'s own expanded group list (see "Findings tab" above) sorts by impact
on its own and does not use this pattern; it has no stage-order toggle.
