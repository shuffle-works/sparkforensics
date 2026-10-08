# Per-widget list sort mode

How a Findings-tab widget opts into the shared list sort mode.

`src/view/impact-sort.ts` (`sumWallClockLow`, `hasSortableImpact`, `canToggleSort`,
`byImpactDesc`, `stageIdOf`, `byStageAsc`), `src/view/useSortMode.ts` and
`src/view/SortModeToggle.tsx` are a shared, opt-in set a Findings-tab active widget can use
to let its own expanded, multi-row list default to potential-savings order (`wallClock.low`
descending, the guaranteed-floor bound, not the optimistic `high`) instead of stage number.
Each of the widgets below gets its `sortMode` (`SortMode`, `'impact' | 'stage'`, default
`'impact'`) from `useSortMode`, which forces impact order at Basic density, and renders a
`SortModeToggle` in the `WidgetCard` `badges` slot, so it sits on the title row itself
rather than floating in the body: a button alongside the widget's tag badges (a
`WidgetCard` header renders `badges` beside the title heading, never inside another
control). Every widget below carries the same `canToggleSort` check, so the toggle only
actually renders for a type
whose finding can carry a wall-clock estimate: `Skew.tsx`, `TinyTask.tsx` (`stageShape`'s
own rules never produce one, so `StageShape.tsx` carries the same check but it never
fires), `ShuffleIO.tsx` (narrowed to `shuffle`), `PartitionSizing.tsx`, `Spill.tsx`,
`GcPressure.tsx` (both its high-GC and low-GC sections, one shared toggle),
`RetryWaste.tsx` (its siblings `StageFailed.tsx`/`TaskFailures.tsx` carry the same check,
but `stageFailed`/`failures` are `estimateMethod: 'none'`, so it never fires there either),
`SlowHost.tsx`, `StageSlowness.tsx`, `Straggler.tsx`, `SpeculationWaste.tsx`,
`ColdStart.tsx` (one widget per type, each sorting only its own flat issue list), and `DuplicatePlanSubtree.tsx`/
`SmallFiles.tsx`/`NestedLoopJoin.tsx`/`UnderBroadcast.tsx`/`OverBroadcast.tsx` (each reorders its own list by
`stageIdOf`, the lowest stage id its finding touches).
It is a two-segment `ToggleGroup` (Impact / Stage; optional `stageLabel`, default "Stage",
which no caller overrides), wrapped in `AdvancedOnly`: stage number is the one axis every one of these widgets' items
can be compared on. Neither mode sorts by impact band, which ranks findings by how bad they
are, not by how much fixing them would save. A per-stage
detector's own `finding.stageId` is the sort key directly; a sql-scope finding that spans
several stages (`duplicatePlanSubtree`, `smallFiles`, `nestedLoopJoin`, `pythonUdf`, `underBroadcast`, `overBroadcast`,
via `stageIds`) sorts by the lowest stage id it touches (`stageIdOf`). The toggle renders
only when `canToggleSort` holds: `hasSortableImpact` finds a wall-clock claim in the list,
there is more than one row, and the card is open; re-sorting a list with no wall-clock
claim would be a silent no-op. Both comparators return `0` when
neither side has a comparable value, so those items keep their prior relative order
(`Array.prototype.sort`'s stability) rather than being shuffled.
`FixTheseFirst`'s own expanded group list (see "Findings tab" above) sorts by impact
on its own and does not use this pattern; it has no stage-order toggle.
