# Per-widget list sort mode

How a Findings-tab widget opts into the shared list sort mode.

`src/view/impact-sort.ts` (`canToggleSort`,
`orderByImpact`, `stageIdOf`, `byStageAsc`), `src/view/useSortMode.ts` and
`src/view/SortModeToggle.tsx` are a shared, opt-in set a Findings-tab active widget can use
to let its own expanded, multi-row list default to the verdict's order instead of stage number:
`orderByImpact` places each row at its best-ranked finding in the run interpretation's `savingsRank`
(core's `rankBySavings`: stage task time or idle core time, then potential savings). The export bundle cannot import
that ranking, so views read the carried rank.
Each of the widgets below gets its `sortMode` (`SortMode`, `'impact' | 'stage'`, default
`'impact'`) from `useSortMode`, which forces impact order at Basic density, and renders a
`SortModeToggle` in the `WidgetCard` `badges` slot, so it sits on the title row itself
rather than floating in the body: a button alongside the widget's tag badges (a
`WidgetCard` header renders `badges` beside the title heading, never inside another
control). Every widget below carries the same `canToggleSort` check, which `useSortMode` binds
to the interpretation: `Skew.tsx`, `TinyTask.tsx`, `StageShape.tsx`,
`ShuffleIO.tsx` (narrowed to `shuffle`), `PartitionSizing.tsx`, `Spill.tsx`,
`GcPressure.tsx` (both its high-GC and low-GC sections, one shared toggle),
`RetryWaste.tsx`, `StageFailed.tsx`, `TaskFailures.tsx`,
`SlowHost.tsx`, `StageSlowness.tsx`, `Straggler.tsx`, `SpeculationWaste.tsx`,
`ColdStart.tsx` (one widget per type, each sorting only its own flat issue list), and `DuplicatePlanSubtree.tsx`/
`SmallFiles.tsx`/`NestedLoopJoin.tsx`/`MergeRewrite.tsx`/`UnprunedScan.tsx`/`PythonUdf.tsx`/`UnderBroadcast.tsx`/`OverBroadcast.tsx` (each reorders its own list by
`stageIdOf`, the lowest stage id its finding touches).
It is a two-segment `ToggleGroup` (Impact / Stage; optional `stageLabel`, default "Stage",
which no caller overrides), wrapped in `AdvancedOnly`: stage number is the one axis every one of these widgets' items
can be compared on. Neither mode sorts by impact band, which ranks findings by how bad they
are, not by how much fixing them would save. A per-stage
detector's own `finding.stageId` is the sort key directly; a sql-scope finding that spans
several stages (`duplicatePlanSubtree`, `smallFiles`, `nestedLoopJoin`, `mergeRewrite`, `unprunedScan`, `pythonUdf`, `underBroadcast`, `overBroadcast`,
via `stageIds`) sorts by the lowest stage id it touches (`stageIdOf`). The toggle renders
only when `canToggleSort` holds: the card is open, a finding in the rows has a place in
`savingsRank`, and the stage order lists a different sequence of stage ids than the impact
order. A widget passes the same rows, in the same order, that it passes to `orderBy`, with the
same finding and stage accessors. The gate compares the stage id of each position in both orders
over all rows, so pagination does not affect it, and rows tied on one stage never show it. The toggle is hidden when the stage order adds no stage
information: all rows share one stage, have none, or are already in stage order. With no ranked finding the
impact order is the input order, so the toggle would do nothing. Rows with no
rankable finding, and `byStageAsc` ties, keep their prior relative order
(`Array.prototype.sort`'s stability) rather than being shuffled.
`GcPressure.tsx` shows its one toggle when either of its two sections has differing orders.
`FixTheseFirst`'s own expanded group list (see "Findings tab" above) sorts by impact
on its own and does not use this pattern; it has no stage-order toggle.
