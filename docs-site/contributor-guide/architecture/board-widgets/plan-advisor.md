# Plan Advisor

The Plan Advisor board widgets, which report SQL-plan-level findings.

- **Plan Advisor** (tag `PLAN`): SQL-plan-level findings computed from
  `appModel.sql`'s resolved `planTree` (DETECTORS entries
  `duplicatePlanSubtree`, `smallFiles`, `broadcastSizing`, `pythonUdf` in
  `packages/core/src/detectors.ts`): repeated plan subtrees (≥3 nodes, ≥2 occurrences; dropped when their
  linked stages take under 0.5% of the run; banded from the recovered
  wall-clock like other findings, with a `warning`/`info` fallback; an
  `Exchange` root only changes the recommendation to a possible missed
  exchange reuse), small-files read/write (>100 files
  averaging <3 MiB), and broadcast-join sizing in both directions (missed-
  broadcast info finding, over-broadcast warning at >1 GB), and
  row-at-a-time Python UDFs (`BatchEvalPython` stages that sent >64 MiB to
  Python workers over >30 s; an info finding). Each of the five
  emitted types renders as its own card (`DuplicatePlanSubtree.tsx`,
  `SmallFiles.tsx`, `UnderBroadcast.tsx`, `OverBroadcast.tsx`, `PythonUdf.tsx`): all five
  share the `PLAN` tag and
  the same `--plan-aggregate` badge tint (`src/view/plan-finding-shared.ts`).
  Their `docAnchor`s (`#bottleneck-duplicate-plan-subtree`,
  `#bottleneck-small-files`, `#bottleneck-broadcast-sizing`, `#pyspark`) each
  resolve to their own page in the vendored tuning reference.

`detector-registry.tsx`'s `REGISTRY` carries `region: 'reference'` on
four entries, each its own component: `memoryUtilization`
(`MemoryUtilization`), `utilization` (`ExecutorUtilization`),
`cacheUtilization` (`CacheUtilization`), and `coreLocality`
(`CoreUsageArea`). `broadcastSizing` has no `REGISTRY` entry: it never
backs a real `Finding` (the `broadcastSizing` `DETECTORS` entry only
emits `underBroadcast`/`overBroadcast`, both `region: 'action'`, each
its own Plan Advisor card), so there is no key for it to occupy or
clean-check line for it to render.
Autoscaling Churn, the other executor-provisioning-lifecycle detector
alongside `utilization`/`memoryUtilization`, is `action`, not `reference`
(see "App- and plan-level widgets" above).

`region` decides one thing (see
[Widget rendering order](../widget-rendering.md#widget-rendering-order)):
whether a widget always mounts. `isAlwaysMountedType()` flags exactly one
of the four `reference`-region types: Core Usage by Locality. That one
mounts unconditionally from `appModel` at the head of the Full app report
tab's reference grid, regardless of finding state. Memory Utilization, Executor
Utilization, and Cache Storage are `reference` too, but all three are
excluded by product decision, not a component-sharing constraint
(`ALWAYS_MOUNTED_EXCEPTIONS` in `src/view/detector-registry.tsx` carries
`cacheUtilization`, `memoryUtilization`, and `utilization`): a clean run on
any of them isn't evidence worth surfacing unconditionally, so each
collapses to an ordinary `CleanCheckRow` like any other action-region type
on a clean run. Every other `REGISTRY` widget renders unconditionally
as either an active card or a clean-check line, and `region`, then detector
order, breaks ties between cards of the same impact band
(`computeActiveWidgets` ranks by worst impact band first; `ImpactBoard`
groups cards Critical, Warning, Info). The Full app report tab reads no other
`REGISTRY` entry. So Core Usage by Locality, the one widget tagged
`region: 'reference'` and exempt from `ALWAYS_MOUNTED_EXCEPTIONS`, renders
in the Full app report beside the other run-wide reference views, and a
route to a `coreLocality` finding switches to that tab (Memory Utilization, Executor Utilization, and
Cache Storage all render through the ordinary active/clean paths instead):
