# Cross-finding rollup: `computeStageUnionMs`

How the recommendation rollup caps a group of findings with the union of their stages.

The Findings tab's recommendation rollup (`FixTheseFirst.tsx`, which renders `interpretRun`'s
`rankedRollup` over `buildRecommendationRollup`, `packages/core/src/recommendation-rollup.ts`) groups the
filtered catalog by detector `type`, then needs its own cap for a group of
several findings of that type, not just one finding's own `stageIds`. Summing
each finding's already-clipped `wallClock.high` naively double-counts any
stage two of those findings both touch. `computeStageUnionMs(stageIds,
stages)` covers this: collect every stage touched by any finding in the
group, merge their `[submittedAt, completedAt)` intervals, and sum the
merged intervals' durations, so the group's wall-clock union holds
regardless of how many findings' `stageIds` overlap. Stages missing either
bound are skipped rather than defaulted to `0` (the same filter
`computeWallClock` applies), so a truncated log (the case `incompleteRun`
flags) can't contribute a negative interval and a negative recoverable-time
figure.

It reuses the same `mergeIntervals` primitive (`packages/core/src/intervals.ts`) that
backs `packages/core/src/occupancy.ts`'s per-finding `estimateMultiStage`/its internal
`unionMs` sum, but is not an extension of that function: `estimateMultiStage`
caps one finding's own multi-stage claim during the impact-estimation pass,
before a `Finding` object even exists; `computeStageUnionMs` runs later,
over the finished findings (in `interpretRun` and the evidence report), capping a naive sum *across* several already-estimated
findings that happen to share a detector `type`. `buildTimeGroup` (same
module) takes the smaller of the naive per-finding sum and this union figure
as the group's `recoverableMsHigh`, falling back to the naive sum untouched
when the group's findings carry no stage IDs at all (nothing to union
against).

Within one `type`, `buildRecommendationRollup` splits findings into up to three
kinds of group; across the whole rollup every `time` group sorts before every
`resource` group, which sorts before every `count` group. `time` covers findings
with a real `impactEstimate.wallClock` (`buildTimeGroup`, the union-capped
figure above). `resource` covers findings with no `wallClock` but a
`rawWaste` figure (`buildResourceGroup`), grouped again by `rawWaste.unit` so
a `bytes` total never gets summed against a `coreHours` total under one
type. `count` covers findings with neither (`buildCountGroup`), a plain
per-impact-band tally with no magnitude claim at all. Each `RollupGroup` also
carries its own `findings: Finding[]` (the exact members that fed the
aggregate), which `FixTheseFirst.tsx` reads directly to pick a group's
highest-impact member and to render its expanded, paginated list.

A type only contributes a tier when it has at least one finding of that
kind; most types produce exactly one tier, but a type whose formula varies
by `variant`/`rule` (e.g. `memoryUtilization`, see the coverage table below)
can produce more than one.

`cachingOpportunity` and `cacheUtilization` are both `cost-only`: `basis:
'resourceOnly'`, `wallClock: null`, but `rawWaste.unit` is `'ms'`, the same
unit a real `wallClock` figure would use, because their formula's natural
output happens to be time (a re-read cost), not because either finding
makes a wall-clock claim. Left unlabeled, a `resource`-tier "ms" total sitting
next to a `time`-tier "recoverable time" total would read as directly
comparable when it isn't: the resource figure was never gate-clipped against
any stage's occupancy, so it can exceed what the stage actually spent.
`rollupGroupStat` (same module) calls this out in the trailing-stat copy
`FixTheseFirst.tsx` renders: a `resource`-kind group (any unit, including `ms`)
shows the finding count plus the summed raw waste (omitted when it reads as
zero), and its tooltip calls the total "a resource cost, not run time". It never
says "recoverable", so the two ms-shaped numbers are never mistaken for the same
kind of claim.
