# Detector contract

`packages/core/src/detectors.ts` is the single source of Spark-optimization logic: one
declarative `DETECTORS` entry per pattern, each carrying `type`, `scope`
(`stage` / `app` / `config` / `sql`), `order`, `fixEffort`, `version`, a
`thresholds` object, an `emits` list, an optional `docAnchor` (every entry but
`incompleteRun` sets one), optional `inScorecard`, `property` and
`suppressedBy`, and co-located `detect()` and `estimate()` functions. Each
finding's `impactBand` and recommendation copy are set inside `detect()`.

Each entry is built by the helper for its scope: `defineStageDetector`,
`defineSqlDetector`, `defineAppDetector` or `defineConfigDetector`. The
helper sets `scope`, infers the thresholds type from the entry's own
`thresholds` literal, and types `detect` as a function property, so its
parameters are checked strictly rather than bivariantly:

| Scope | `detect` signature |
| --- | --- |
| `stage` | `detect(stage, ctx, thresholds)` |
| `sql` | `detect(sqlExec, ctx, thresholds)` |
| `app` | `detect(ctx, thresholds)` |
| `config` | `detect(target, thresholds)`, where `target` is `{ app }` |

`ctx` (`DetectorCtx`) is required, and its `app` is nullable as on
`AppModel.app`, so a detector that reads the app without a guard, reads a
threshold its entry doesn't declare, or expects another scope's target fails
to compile. `detect` never reads `this`. The helper freezes the entry's
`thresholds` and adds `withThresholds(overrides?)`, which returns `detect`
with the thresholds bound: the entry's own, or the caller's overrides merged
over them (see [Tuning thresholds](#tuning-thresholds)). Runners such as
`analyze()` call only that.

`estimate(finding, ctx)` prices one of the entry's own findings: `finding` is
typed as the `Finding` member of a type the entry `emits`, and `ctx`
(`EstimateCtx`: `stages`, `occupancy`, `totalCores`) is the one occupancy
sweep `analyze()` builds per run. It returns an `ImpactEstimate` or null
(see [Impact estimation](./impact-estimation.md)). Every entry must declare
one; an entry with no waste model passes `noWasteModel`. `estimateImpact()`
runs it after suppression, keyed by emitted type. The same `EstimateCtx`
reaches `detect()` as `ctx.impact`, so a runtime floor can gate on the
estimate the finding will display: `skew` and `straggler` build their tail
claim once (`skewTailClaim`/`stragglerTailClaim`) and both their floor and
their `estimate()` read it through `tailClaimImpact`. Shared model constants
and helpers live in `packages/core/src/impact-model.ts`.

`DETECTORS` is declared `as const satisfies readonly Detector[]`, so each
entry keeps its literal `type` and `emits`. Two unions derive from it:
`DetectorType` (every entry's own `type`) and `FindingType` (every type an
entry's `emits` lists, the finding types that actually appear on findings).
`emits` is `[type]` for every entry except `broadcastSizing`, whose one plan
walk emits `overBroadcast` and `underBroadcast` and never its own name. Every
per-type lookup keys on the emitted `FindingType`, never on `DetectorType`:
code that needs the emitted types of an entry reads its `emits` list.
Code that iterates entries generically, such as `analyze()`, reads them
through the `Detector` type, a union over scopes with the thresholds type
erased, `detect` left off and `estimate` taking any `Finding`, so switching
on `scope` narrows the bound function `withThresholds()` returns.

How a finding type is presented is registered once, in
`FINDING_PRESENTATION` (`packages/core/src/finding-presentation.ts`), typed
`{ [T in FindingType]: FindingPresentation<T> }` so the compiler requires
exactly one row per emitted type. A row holds the type's `name`, board
`tag`, `actionLabel(finding)`, `genericRecommendation(finding)` and
`thresholdSummary(thresholds)`, each finding argument typed as that type's
`Finding` member and `thresholds` as the emitting entry's own `thresholds`.
`FINDING_NAMES`, `TYPE_TAG_MAP`, `getThresholdSummary`, `findingActionLabel`
and `coreFindingGenericRecommendation` all read it. The table sits beside
`DETECTORS` rather than on its entries because the HTML export renders
names, tags and labels but may not reach `detectors.ts` (see
[Run interpretation](./state-and-history.md#run-interpretation)); its
import from `detectors.ts` is type-only. A detector's `scope` and `order`
reach renderers through `detectorInfoByType()` (`detector-docs.ts`), keyed
by emitted type, which the run interpretation ships; the Alerts clean-check
grouping reads `detectors[type].scope`.

Each finding type has its own shape in `packages/core/src/finding-types.ts`:
`Finding` is a union discriminated on `type`, and a compile-time check in
`detectors.ts` fails when its members and `FindingType` differ. Each member
splits into a `<Type>Evidence` interface, the fields the evidence report
publishes (listed again in `EVIDENCE_KEYS` in `evidence-report.ts`, checked
both ways), and fields declared only on `<Type>Finding`, which other core
modules read but the report never publishes. `value` is always a magnitude;
a text-valued finding (`stageFailed`, `configAudit`, `incompleteRun`) sets
`valueText` instead. So a new detector type needs an `emits` entry, an
`estimate()` on that entry that covers it, a `finding-types.ts` member, an `EVIDENCE_KEYS` entry, an `ID_DISCRIMINATORS`
entry in `analyzer.ts`, a `FINDING_PRESENTATION` row and a view `REGISTRY`
entry. The compiler
reports each one that is missing. Tests and process, not the compiler, cover
the rest: a new board tag goes in AGENTS.md's tag list
(`packages/core/test/tag-vocabulary.test.js` fails otherwise), an intended
finding change is checked with `node dev/bench-analyze.mjs --check
dev/corpus-snapshot.json` and then `--update`d, and the PR needs a
`.changeset/*.md`. A `docAnchor` must have a section in the detection docs
(`packages/core/test/docs-config.test.js`). The view narrows with
`findingsOfType(catalog, type)` (`packages/core/src/findings-of-type.ts`)
rather than re-declaring a finding's fields.

Both consumers are thin loops over that array:

- `packages/core/src/analyzer.ts`: `analyze()` runs every entry regardless of scope, skipping
  only `inScorecard:false` ones, then applies `suppressedBy` (below);
  `auditConfig()` separately runs the `scope:'config'` entries. The four `configAudit` entries stay out of the
  bottleneck catalog because each sets `inScorecard:false`, not because of
  `scope:'config'`: a future config-scope detector without that flag would run
  through `analyze()` too. Each finding is stamped with its entry's `docAnchor`.
- `src/view/detector-registry.tsx`: `REGISTRY` maps each emitted finding type
  to `{component, region, widgetId, routeable}` (view-only concerns), checked
  with `satisfies Record<FindingType, RegistryEntry>`. Each type has its own
  component, and no two entries share one. The executor-count chart
  (`ExecutorCountChart`) is a `ReferenceSection` tile, not a `REGISTRY` entry.
  `orderedWidgets(detectors)` takes the run interpretation's
  `detectorInfoByType()` record (`DetectorInfo` per type), keeps the types that
  have a `REGISTRY` entry, and sorts `action`-region components before
  `reference`-region ones, then by ascending `order`, using the record's
  declaration order to break ties.

  Each widget component receives the full catalog and self-gates when it has
  nothing to show, rendering `null` or a muted "no issue" card for the
  always-visible ones. `orderedWidgets()` itself has no empty/non-empty
  branching, since it iterates the static per-type detector info, not the
  runtime `catalog`.

Default thresholds live only in each entry's `thresholds`; see
[Bottleneck thresholds](#bottleneck-thresholds). Only the CLI and
the MCP server can override them, per run: see
[Tuning thresholds](#tuning-thresholds).

## Confidence disclosure

A `Finding` may carry `confidence: 'low' | 'medium' |
'high'` plus a `validationRequired` string. `RowStatusCluster` (`src/view/RowStatusCluster.tsx`)
renders it on widget rows (the verdict's steps print their own "verify before acting" line), gated to Advanced density: a plain "&lt;confidence&gt;
confidence" badge whose tooltip carries the full `validationRequired` text. A finding with no
`confidence` field renders identically to a fully-validated one, so every detector whose
thresholds are our own unvalidated noise floor (marked `NOT SOURCED` in a code comment) should
set both fields, not just the ones that happen to already have `RowStatusCluster` wired into
their widget. `skew`, `straggler`, and `gc` set `confidence` for exactly this reason: their
runtime-floor thresholds carry the same kind of unvalidated-noise-floor caveat `coreLocality`,
`autoscalingChurn`, and `memoryUtilization`'s `wasteModel` variant already disclose. None of these
hardcode a single confidence value: each scales `'low' | 'medium' | 'high'` off how far the
finding sits past its own detector's threshold, via a small named helper placed just above the
`DETECTORS` array (e.g. `skewConfidence`, `coreLocalityConfidence`, `cachingReuseConfidence`)
rather than an inline literal.

## The `fixEffort` field

Each `Detector` entry also carries `fixEffort: 'config' | 'code' |
'rearchitect'`, alongside `order` and `thresholds`: a rough estimate of how
much work resolving the finding takes.

No view reads it:
the ranking `FixTheseFirst` (`src/view/widgets/FixTheseFirst.tsx`) renders is
computed in core by `interpretRun` (`rankedRollup`/`rankFindings` in
`packages/core/src/recommendation-rollup.ts`), by estimate tier and impact,
never by `fixEffort`. See
[Widget rendering order](./widget-rendering.md#widget-rendering-order)
for how it ranks findings.

Two shared helpers back multiple detectors and reports. `packages/core/src/plan-tree-walk.ts`'s
`walkPlanTree(root, visit, {dedupe})` is the iterative pre-order plan-tree
traversal used by `detectors.ts`, `plan-summary.ts`,
`plan-duration-attribution.ts`, `plan-dot.ts` and `plan-graph-model.ts`. `packages/core/src/core-count.ts` holds the shared core-count logic. Its
`computePeakConcurrentCores`/`computePeakConcurrentExecutorCount` sweeps back `detectors.ts`'s
`utilization` and `memoryUtilization` entries, `efficiency-model.ts` and `wasted-core-hours.ts`,
so the Scorecard's Unused core time and the verdict's idle figure share one capacity.
`computeTotalCores(app, executorsAdded)`, used only by `scaling-sim.ts`, sums every
`ExecutorAdded` event with no regard for overlap, so under executor churn (spot preemption,
`dynamicAllocation` replacement) it double-counts a churned executor's capacity against its
replacement's; the peak-concurrent sweeps don't.

## Cross-detector suppression

An entry may name another entry's `type` in `suppressedBy`. Once every
detector has run, `analyze()`'s `applySuppression()` drops each of that
entry's findings on a stage where the named detector emitted a finding. It
reads the unsuppressed findings, so neither the two entries' declaration
order nor the order suppressions apply in changes the result, and `order`
stays a display field only. A compile-time check in `detectors.ts`
(`SuppressorsAreDetectors`) fails when `suppressedBy` names no entry.

`stageSlowness` sets `suppressedBy: 'slowHost'`: a stage `slowHost` already
explains needs no generic "this stage is slow" finding. Suppression follows
what `slowHost` actually emitted, so a run whose `slowHost` thresholds are
tuned so it can't fire gets its `stageSlowness` findings back. The
mechanism is deliberately minimal (same-stage, one named suppressor per
entry), not a general dependency graph. `auditConfig()` doesn't apply it,
since no `scope:'config'` entry sets `suppressedBy`.

## Tuning thresholds

`analyze()`'s eighth argument is `{ thresholds?: ThresholdOverrides }`:
per-entry overrides keyed by entry `type`, each a partial of that entry's
own `thresholds`. Omitted, every entry runs its defaults; the dashboard
never passes it. The CLI's and the MCP server's `--thresholds <file>` read a
JSON file of that shape (`packages/core/src/cli/threshold-config.ts`) and
validate it with `parseThresholdOverrides()`
(`packages/core/src/threshold-overrides.ts`), which refuses an unknown
detector or threshold, a negative or non-numeric value, a tier table of a
different length or out of ascending order, an entry with no thresholds
(`stageFailed`, `incompleteRun`), and any `configAudit` (config-scope) override:
those checks compare against Spark's own defaults, so there is nothing to
tune. A file that can't be read or parsed refuses the run the same way. The
[user guide](../../user-guide/getting-started.md#tuning-detector-thresholds)
documents the file.

A finding from an entry whose overrides move a threshold off its default
carries `tunedThresholds` (`{ <name>: { value, default } }`), and once its
estimate is attached the analyzer appends a caveat to its
`validationRequired` naming the tuned values. When the finding has an
estimate figure (wall-clock or raw waste), the caveat adds that impact
estimates are calibrated against the default thresholds (see
[Impact estimation](./impact-estimation.md)), so its estimate is
unvalidated; an informational finding gets the label alone. An override
equal to the default labels nothing. Tuning a
`suppressedBy` target changes which of the suppressed entry's findings
survive, so those findings carry the suppressor's tuned thresholds too,
named `<suppressor>.<name>` (e.g. `slowHost.minHosts` on `stageSlowness`).
Only that one link is followed. The
evidence report repeats the label on the finding row, the clean check, the
`detectors` catalog row (whose `thresholds` are then the effective ones)
and in `summary.tunedThresholds`; see
[Portable evidence report](./worker-protocol.md#portable-evidence-report).

A tuned `floorPctWarn`/`floorPctCrit` on `skew` or `straggler` also grades
that entry's own findings in `deriveImpactBand` (`impact-band.ts`); every
other finding keeps the run-wide default floors. `--max-skew` recomputes the
ratio with the run's effective `minTasksForP95`, so the budget measures the
same ratio the skew finding reports. Caveat text that names a threshold
(`gc`, `skew`, `straggler`, `memoryUtilization`, `coreLocality`) and the
`broadcastSizing` over-broadcast recommendation state the value the detector
ran with. The HTML export still renders the
default-threshold analysis.

## Per-operator duration attribution

`packages/core/src/plan-duration-attribution.ts` (entry
`attributeStageDurationToPlan(planTree, stagesById, sqlExec)`) approximates how a SQL execution's
stage wall-time splits across plan operators, returning a
`Map<planNode, milliseconds>`. It cuts the plan tree at Exchange boundaries
into connected components: because `resolvePlanTree`
in `event-handlers.ts` always synthesizes a `read` node wrapping a `write` node
for every raw `Exchange`/`BroadcastExchange`, the cut is keyed off
`PlanNode.exchangeRole === 'read'` on the parent, not a name regex: the write
half starts the new component, the read half stays in its parent's. A node
with no `exchangeRole` at all (for example `ReusedExchange`, which is never
split) never starts a new component on its own. Each
component receives a stable pre-order identity
and separate parent/depth/traversal metadata; the identity itself does not
encode its count of Exchange ancestors. It zips components deepest-first by
that explicit depth against submission-ordered stage IDs, then apportions each
matched stage's wall-time across that component's nodes by timing-metric weight,
falling back to an even split when no node carries a timing metric.

This is best-effort inference, not measurement. Spark's event model exposes
no ground truth for per-operator time within a stage; the Exchange-boundary
segmentation and deepest-component-to-earliest-stage zip are heuristics. Treat the
per-operator numbers as directional hints, never as authoritative timings, and
do not build hard thresholds or findings on top of them.

## Stage-ID attribution for Plan Advisor findings

The Plan Advisor detectors (`duplicatePlanSubtree`, `smallFiles`, `broadcastSizing`
in `packages/core/src/detectors.ts`) each attribute their finding to a narrowed `stageIds` set
rather than the whole SQL execution: `PlanNode.stageIds` is resolved once per plan
tree at parse time by unioning, per node, every metric's accumulator ID against a
`taskAccumStages: Map<accumulatorId, Set<stageId>>` built while parsing `TaskEnd`
events, then clipping the result to the execution's own stage set. An accumulator
ID occasionally points to a *different* execution's stages, e.g. a `ReusedSubquery`
computed once and reused verbatim, and the clip prevents misattributing that other
execution's work. Each detector unions its implicated node(s)' `stageIds` and falls
back to the execution-wide set only when no implicated node has any coverage;
a finding never partially blends a narrowed set with the execution-wide one.
When an execution has no stage universe at all (no jobs ever recorded against it,
which is true for 42% of real-log SQL executions with a plan tree, typically
job-less/driver-only executions), the clip drops every candidate stage ID instead
of passing them through: every node in that execution's tree ends up with no
`stageIds` anywhere, same "coverage is partial" framing as below. (The clip
is unconditional on `executionStageIds` being present: treating "no stage
universe" as "no clip" would let a foreign accumulator ID collision, e.g. the
`ReusedSubquery` case above, leak another execution's stages into a job-less
execution's nodes.)

Coverage is partial by Spark's own design: whole-stage-codegen wrapper nodes (`InputAdapter`, and other purely
structural passthrough markers) carry no accumulators at all, and
`BroadcastExchangeExec`'s own metrics are computed entirely on the driver and
never appear on any `TaskEnd` (real Spark behavior). Those driver-computed
metrics live specifically on the
synthesized *write* half (`exchangeRole: 'write'`); the *read* half always
carries `metrics: []`. The write half's immediate child, which does carry
executor-side metrics, is unioned in instead, see `overBroadcast`'s wiring. A
`TaskEnd` arriving after its stage has already been finalized is also
silently excluded from `taskAccumStages`, consistent with the parser's existing
out-of-order tolerance elsewhere.

`planTree` itself is kept current against Spark's adaptive query execution (AQE)
re-plans: `SparkListenerSQLAdaptiveExecutionUpdate` events overwrite the
execution's `sparkPlanInfo` last-write-wins, so
accumulator-ID evidence is matched against the plan that actually ran rather than
a stale pre-AQE snapshot. Since a superseded plan is never read, `dispatchLine`
holds an open execution's latest update as unparsed text and parses only that one,
when `SQLExecutionEnd` arrives or at parse completion (`deferAdaptiveUpdate`,
`event-handlers.ts`). It recognizes an update from the flat first and last pieces
`buildChunkDecoder` reports for a line joined across slices (`JoinedLine`), so a
superseded update is never copied into one flat string either. The raw `sparkPlanInfo` stays worker-side and is released
once `SQLExecutionEnd` resolves it into `planTree`; `physicalPlanDescription` (Spark's
text rendering of the plan, which nothing reads) is emptied before `JSON.parse` and
never retained (`stripPlanDescription`, `event-handlers.ts`). `buildChunkDecoder`
decodes each decompressed chunk in slices of at most 512 KiB, and drops the bytes of a
value that crosses a slice boundary without decoding them.

No eviction/pruning is added to `taskAccumStages`, a deliberate choice, not an
oversight: measured on real logs, it holds roughly 1,050 keys per compressed MB
(9,850 keys on an 11.6 MB fixture, about 29,000 keys on a 28.1 MB fixture).
Extrapolated to a 240MB+ log, the scale this tool targets, that
is roughly 250,000 keys, around 45 MB of heap for an equivalent synthetic
`Map<number, Set<number>>`. This heap estimate is small relative to this
tool's other in-memory state.

Per-execution pruning (e.g. dropping a `taskAccumStages` entry once its stage
finalizes or its owning SQL execution resolves, mirroring how `accumState` is
cleared in `endSqlExecution`) is deliberately not done either: unlike
`accumState`, `taskAccumStages` is one global, un-scoped map read by every
execution's `resolvePlanTree` call, and the `ReusedSubquery` case above depends
on a stage recorded under one execution still being visible when a later
execution resolves. Pruning on any single execution's lifecycle would break that
cross-execution lookup. What is bounded is the growth from a single pathological
event: `TaskEndEventSchema`'s `Accumulables` array is capped at
`MAX_ACCUMULABLES_PER_TASK` (10,000, `event-schemas.ts`), well above any real
plan's per-task metric count, so a single crafted `TaskEnd` can't grow the map
past that per-event bound; a `TaskEnd` exceeding it fails schema validation and
the line is skipped (counted in `skippedLines`) like any other malformed event.
Each accumulable is checked for its numeric `ID` only: `Update`/`Value` are
unread, and Spark writes some as JSON arrays (`internal.metrics.updatedBlockStatuses`),
which a stricter check would reject along with the whole task. When every entry has
Spark's flat `{"ID":n,...}` form, `parseTaskEnd` (`event-handlers.ts`) reads the IDs with a
string scan and cuts the array out before `JSON.parse`; any other shape is parsed whole.

## Bottleneck thresholds

Every change to `packages/core/src/detectors.ts` should reference this table.

Every finding's `impactBand` comes from one of two places. For any finding
whose `impactEstimate` carries a `wallClock` estimate (the common case for
most rules below), `analyzer.ts` calls `deriveImpactBand()`
(`packages/core/src/impact-band.ts`) immediately after `estimateImpact()`, which sets
`.impactBand` purely from `wallClock.high` as a fraction of the app's total
duration (`>= 2%` critical, `>= 0.5%` warning, else info: `IMPACT_FLOOR_PCT_CRIT`/
`IMPACT_FLOOR_PCT_WARN`, which `skew`'s `floorPctWarn` and `straggler`'s
`floorPctWarn`/`floorPctCrit` default to, so a tail those gates admit grades
at least warning; a tuned `skew` or `straggler` floor also grades that
entry's own findings, see [Tuning thresholds](#tuning-thresholds)). For those rules, the table below documents their firing
gate plus their fixed fallback constant, which surfaces only when this run's
finding of that type didn't get a wallClock estimate (a stage excluded from
the occupancy sweep). For rules whose finding type never gets
a wallClock estimate (`resourceOnly`/`informational` basis, e.g.
`configAudit`, or a rule that keeps its own ratio-tiered classification,
e.g. `failures`), the full threshold table below is
the real, displayed classification: `detectors.ts` sets `impactBand`
directly and nothing overwrites it. `partitionSizing`'s `maxPartitionTooBig`
rule is a third case: it does carry a `wallClock` estimate but is explicitly
exempted in `deriveImpactBand()` because it's a hardcoded-critical OOM/crash-risk
safety signal, not a time-recovery one, so `detectors.ts`'s own classification
stands regardless of how small that estimate is relative to the run.

### Fixed fallback only (usually wallClock-derived instead)

These rules have no *band* tiers in `packages/core/src/detectors.ts`
(`deriveImpactBand` sets the band whenever a wallClock estimate is
available); the constant in the last column is only a floor-case fallback.
Their *firing* gate lives in each entry's
`thresholds` object: it decides whether the rule reports anything, so it
stays documented here in full.

| Rule | Fires when | Fallback |
|---|---|---|
| Task skew | `taskDurationP95 / taskDurationP50 > 3×` (`taskDurationMax / P50` for stages under `minTasksForP95` = 20 tasks), **and** the occupancy-clipped tail recovery (`tailRecoveryMs`: `finalizeStage`'s task-level replay of the stage with every task over 4× P50 capped at P50) is ≥ `floorPctWarn` = 0.5% of app runtime. The clip floors the claim at the longest task the fix leaves, not the current one, and at the core work the fix leaves over every core (see impact-estimation.md's occupancy section); `straggler`'s floors use the same clip | `warning` |
| Shuffle read | `shuffleReadBytes > minBytes` = 50 MiB, on a stage that isn't shorter than `stageFloorPct` = 0.5% of the run (a zero-length stage or an unknown run duration passes; the claim is clipped to the stage, so a shorter one would grade `info`: 182 of 284 on the 14 real logs, the shuffle itself still there) | `info` |
| Partition sizing: skew | `shuffleReadMax > 5×` `shuffleReadP50` **and** `shuffleReadMax > 256 MiB` | `warning` |
| Partition sizing: low parallelism | `shuffleReadBytes ≥ 1 GiB` **and** `taskCount ≤ 7` | `warning` |
| Partition sizing: oversized partition | `shuffleReadMax ≥ 5 GiB` | `critical` |
| GC | `executorRunTime ≥ minRunTimeMs` = 10 s **and** `gcPct > 10%` | `warning` |
| GC (low / cost) | `executorRunTime ≥ 10 s` **and** `gcPct < lowInfoPct100` = 5% (checked only when the GC row above did not fire) **and** the stage lasts ≥ `lowInfoFloorPct` = 0.5% of the run (passes when the run's duration is unknown or the stage has zero length, such as one with no completion time). Gets no wall-clock estimate (an over-provisioning signal), so this band always stands. The floor drops 464 of 685 low-GC notes on the 14 real logs (none on the corpus): low GC is still true on those stages, but a memory-sizing note from a stage that barely ran adds nothing | `info` |
| Spill | any non-zero `memoryBytesSpilled`, on a stage that isn't shorter than `stageFloorPct` = 0.5% of the run (as for shuffle read: 12 of 38 on the 14 real logs, all `info`). The magnitude sub-table below classifies *how much*, but does not gate firing | `warning` |
| Cold start | `firstExecutorAddedAt − firstStageSubmittedAt > gapSeconds` = 30 s (no finding without executor-added events): the time a runnable stage waited for its first executor. An executor added before the first stage and still alive at submission means no wait and no finding; one removed at or before submission is ignored, so the gap runs to the next executor added after it. | `warning` |
| Slow host: mean-duration ratio | stage has ≥ `minHosts` = 3 hosts (or executors) and ≥ `minTasks` = 15 tasks, and lasts ≥ `stageFloorPct` = 0.5% of the run (passes when the run's duration is unknown or the stage has zero length, which gets no estimate and keeps its fallback band; every slow-host finding on a shorter stage would grade `info`, 324 of 452 on the 14 real logs, the imbalance itself still true; this gate covers every slowHost row); then per host: mean task duration / overall median ≥ `ratioWarn` = 2.0× **and** host task-share ≥ `minShare` = 20% **and** host mean ≥ `floorMs` = 1000 ms (absolute-magnitude floor, rules out sub-second noise) | `warning` |
| Slow host: duration-share | same stage gate as the row above; then per host: ≥ `shareWarn` = 75% of the stage's total task-duration **and** ≥ `taskShareWarn` = 50% of its task count | `warning` |
| Stage slowness: absolute fallback, suppressed when `slowHost` already fired | stage wall-clock duration ≥ `infoMin` = 15 min. The band then comes from the partitioning-headroom estimate (see impact-estimation.md), not the duration | `info` |
| Straggler / speculative-execution | `taskCount ≥ minTasks` = 10, **and** the stage lasts ≥ `floorPctWarn` = 0.5% of the run (passes when the run's duration is unknown or the stage has zero length, such as one with no completion time; a shorter stage's tail can't cost more than its own duration, so every finding there would grade `info`: 671 of 753 on the 14 real logs, 3 on the corpus, the slow tail itself still true), **and** either any speculative task ran, **or** straggler share > `shareWarn` = 5%, **or** straggler share > `shareWarnAtFloor` = 2.5% with the occupancy-clipped tail recovery (`tailRecoveryMs`, as for skew) already ≥ `floorPctWarn` (0.5% of app runtime). The lower gate is scored against a task-level replay of every stage on 14 real logs (recoverable = list-scheduling replay with each task over 4× P50 capped at P50; positive = ≥ 0.5% of app runtime): it found 3 stages whose stragglers gated them for 10-48s at 2.7-4% of their tasks, for 1 borderline miss, lifting skew-or-straggler recall from 0.86 to 0.92 at precision 0.91 → 0.89. Admitting every 2.5% share instead would add 86 findings below the floor. The same sweep kept skew's `ratioWarn` = 3 (2.5 added false positives, 4 lost true ones) and the 0.5% floor (1% halved skew recall). `warnPct`/`critPct` (10%/20% speculative share) and `floorPctWarn`/`floorPctCrit` (0.5%/2% of app runtime) do not set the band; they rank the straggler-vs-speculative tiers that pick which *metric* the finding reports | `info` |
| Speculation waste | `speculationWastedAttempts ≥ minWasted` = 5 **and** `speculationWasteMs ≥ minWasteMs` = 60 s | `warning` |
| Retry waste | `wastedAttempts ≥ minWasted` = 3 **and** `retryWasteMs ≥ minWasteMs` = 30 s (attempts superseded by a later retry of the same task) | `warning` |
| Tiny tasks | `taskCount ≥ minTasks` = 100 **and** `taskDurationP50 ≤ maxP50` = 500 ms **and** `taskDurationP95 ≤ maxP95` = 1000 ms **and** the stage lasts ≥ `stageFloorPct` = 0.5% of the run (passes when the run's duration is unknown or the stage has zero length; coalescing can't save more than the stage's own duration, so every finding on a shorter stage would grade `info`: 132 of 151 on the 14 real logs, the tasks still tiny). Checked against each stage's measured per-task overhead (task wall time minus executor run time, the estimate's own input) on 14 real logs and the corpus: of 228 stages with 100+ tasks outside the P50/P95 gate, none would save 0.5% of its run by coalescing (median overhead 0.2-3% of task time); of 170 inside it, 25 would, and all 25 grade above `info` | `info` |
| Duplicate plan subtree | a subtree of ≥ `minSubtreeSize` = 3 nodes whose shape fingerprint repeats ≥ `minOccurrences` = 2× in the plan, unless its linked stages together lasted less than `stageFloorPct` = 0.5% of the run (a repeat with no linked stage time, or an unknown run duration, is kept; the claim counts at most each stage's own task-active time, so such a repeat would grade `info`: 340 of 545 on the 14 real logs, the repeat still in the plan). `occurrencesIdentical` records whether the repeats also agree node-for-node on normalized detail, ignoring AQE query-stage numbers; when they don't (same shape over another table, filter or projection: 270 of 546 groups on the 14 real logs) the finding is `info` with confidence `low` and no time claim. `stageShares` gives, per stage, the repeated operators' share of the stage's operators (WholeStageCodegen wrappers and Exchange write halves not counted); with no attributed stage the finding is `info` | `warning` |
| Small files read/write | per read/write side: file count > `minFiles` = 100 **and** average file size < `maxAvgFileSizeMB` = 3 MiB | `warning` |
| Broadcast sizing: missed | a 2-child `SortMergeJoin` whose smaller side is < 10 MiB (unconditional), or < 100 MiB with the larger side > 10 GiB, or < 1 GiB with larger > 300 GiB, or < 5 GiB with larger > 1 TiB (`broadcastTiers` × `comparisonTiers`) | `info` |
| Broadcast sizing: oversized | a `BroadcastExchange` node whose `data size` metric > `overBroadcastBytes` = 1 GiB | `warning` |

#### Spill magnitude tiers

The spill row's band is a fixed `warning` fallback, but `computeSpillMagnitude`
(`packages/core/src/detectors.ts`) runs on every spill finding and sets its
`spillMagnitude` field, which the Spill widget displays. Its tiers, in
evaluation order (first match wins, `null` when nothing matches):

| Condition | Magnitude |
|---|---|
| Single-task stage: `spillDiskMax ≥ singleTaskDiskGiB` = 1 GiB **or** `spillMemMax ≥ singleTaskMemGiB` = 4 GiB | `severe` |
| Multi-task stage: `spillDiskMax ≥ highDiskGiB` = 1 GiB, **or** `spillDiskMax / taskCount ≥ highTaskDiskMB` = 512 MiB (per-task proxy), **or** `spillMemMax ≥ highMemGiB` = 4 GiB | `high` |
| Multi-task stage: `spillDiskMax ≥ medDiskMB` = 256 MiB **or** `spillMemMax ≥ medMemGiB` = 1 GiB | `medium` |
| Skew (`taskCount ≥ skewMinTasks` = 10): `spillDiskMax / spillDiskP50 > skewRatio` = 5× **and** `spillDiskMax ≥ skewDiskFloorMB` = 128 MiB | `high` |
| Skew (`taskCount ≥ 10`): `spillMemMax / spillMemP50 > 5×` **and** `spillMemMax ≥ skewMemFloorMB` = 256 MiB | `medium` |

Disk spill is weighted worse than memory spill by design: the memory
thresholds sit well above their disk counterparts at every tier.

### Full threshold table (never wallClock-derived)

| Rule | Warning | Critical |
|---|---|---|
| Stage shape: PRatio | `taskCount / totalCores < 0.5` (info, under-parallelized), on a stage lasting ≥ `lowParallelismFloorPct` = 0.5% of the run (passes when the run's duration is unknown or the stage has zero length): parallelizing can't save more than the stage's duration, and on the 14 real logs 2839 of 3005 firings were below it | none |
| Stage shape: OIRatio | `outputBytes / inputBytes > 10×` (info, data explosion) | none |
| Stage shape: TaskStageSkew | `taskDurationMax / stageDuration > stageShareMin` = 0.5 **and** `taskDurationMax / taskDurationP50 > skewWarn` = 3× (info), on a multi-task stage lasting ≥ `taskStageSkewFloorPct` = 0.5% of the run. A task runs inside its stage, so the share is at most 1; the median gate is needed because on a single wave of even tasks the longest one spans the whole stage too | none |
| Failed tasks | failure rate > 5% (min 10 tasks) | > 20% |
| Stage failed outright | none | any `stageFailureReason` present |
| Slow host: multi-dimensional | max/median ratio across taskTime/inputBytes/shuffleBytes/storageMemory ≥ 1.33× (info); each dimension's sample must also clear an absolute floor (1000 ms for taskTime, 64 MiB for the byte dimensions). A stage lasting under `stageFloorPct` = 0.5% of the run is skipped (see the mean-duration row): a byte dimension there has no time estimate and would otherwise keep its ratio tier (66 of 90 warning/critical on the 14 real logs). The taskTime dimension falls back to `info` and takes its band from its wall-clock estimate; the byte dimensions get no time estimate and keep the ratio tier | ≥ `ratioTiers[1]` = 1.78× warning, ≥ `ratioTiers[3]` = 10× critical (`ratioTiers[2]` = 3.16 is not read) |
| Utilization | avg active executors / peak < 60% (info) | none |
| Autoscaling churn: short-lived executors | > 30% of executors alive under 2 min (min 5 executors) | > 60% |
| Job failure rate | ≥ 30% (≥ 10% info) | ≥ 50% |
| Idle cores | busy-core-time / (peak cores × wall-clock) idle > 50% (warning) | none |
| Memory band | peak heap / allocated > 95% too-small (warning); < 70% over-provisioned (info) | none |
| Caching opportunity | same input relation (or join/union subtree) scanned by ≥ `minExecutions` = 2 SQL executions in one run | none (single tier, info) |
| Cache utilization: partial caching (this repo) | `numCachedPartitions / numPartitions < 0.90` (info) | `< 0.50` (warning) |
| Cache utilization: disk spillover (this repo) | `diskSize / (memorySize + diskSize) > 0.15` (info), `MEMORY_AND_DISK*` only | `> 0.40` (warning) |
| Cache utilization: storage unobserved | persisted RDDs, but no `SparkListenerBlockUpdated` for any `rdd_*` block and every RDD Info figure 0 (`spark.eventLog.logBlockUpdates.enabled` off on Spark 2.3+): a missing-evidence caveat, not a threshold | none (single tier, info) |
| Core locality | non-local task ratio ≥ `warnRatio` = 15% (min `minTasks` = 50 tasks) | ≥ `critRatio` = 35% |
| Config: memory overhead | `spark.executor.memoryOverhead` below max(`floorMB` = 384 MiB, `floorPct` = 10% of executor memory) (info) | none |

The RDD Info cache figures on stage events (`Number of Cached Partitions`,
`Memory Size`, `Disk Size`) are always 0 since Spark 2.3; Spark 1.x fills them
only on `StageCompleted`. Real cache evidence is `SparkListenerBlockUpdated`,
written only with `spark.eventLog.logBlockUpdates.enabled=true`
(`recordBlockUpdate` in `event-handlers.ts`); the corpus
`cache-memory-only`/`cache-memory-and-disk` logs carry it. Count a block's
sizes only where its storage level says it lives: a drop to disk still reports
the dropped bytes as `Memory Size`.

Spill classification: ≥80% tasks with zero spill → `skew`; <20% zero →
`volume`; else `unclassified`. The classification badge is always shown in
both compact and expanded spill widget states. This is independent of the
magnitude tiers above: classification says *what kind* of spill, magnitude
says *how much*.

#### Evidence fields (`stageFailed` / `retryWaste`)

Beyond a scalar `metric`/`value`, both entries' `detect()` attach to the
finding:

- `numTasks`: `stage.taskCount` at detection time.
- `memoryBytesSpilled`: `stage.memoryBytesSpilled` at detection time.
- `stageFailed` only: `failedTaskDetails`: up to 20 `FailedTaskSample`
  records (`taskId`, `attemptNumber`, `host`, `executorId`, `reason`,
  `peakExecMem`, `memSpilled`, `shuffleWrite`) for tasks still marked
  failed when the stage was finalized (`finalizeStage`, `stage-quantiles.ts`).
- `retryWaste` only: `retriedTaskDetails`: up to 20 `FailedTaskSample`
  records for attempts discarded by the retry-dedup logic in
  `accumulateTask` (`event-handlers.ts`): captured at the moment they'd
  otherwise be thrown away, since by finalize time only the winning attempt
  survives.

Both sample arrays are capped at 20 entries, filled in first-encountered
order (finalize order for `failedTaskDetails`, discard order for
`retriedTaskDetails`), not spread across distinct hosts/executors: a stage
with failures clustered on one bad host could fill the cap before a more
informative failure elsewhere in the stage is ever sampled.

#### Evidence fields (`failures`)

- `dominantReason`: the most frequent end-reason tag (`ExceptionFailure`,
  `ExecutorLostFailure`, ...) among tasks still failed at finalize.
- `dominantError`: the error behind that tag, from its largest failure group:
  the exception class, or `<tag>: <loss reason>`; falls back to the tag. The
  recommendation names it and never embeds a message.
- `failureGroups`: up to 5 `TaskFailureGroup`s (`reason`, `className`,
  `message`, `lossReason`, `stackExcerpt`, `count`), most frequent first: one
  group per distinct tag, class, message and loss reason, one excerpt each.
- `otherFailedTasks`: failed tasks that no shown group covers.

`packages/core/src/task-failure.ts` reads the details from `Task End Reason`
(`Class Name`, `Description`, `Full Stack Trace`, `Loss Reason`, FetchFailed
`Message`, `Kill Reason`) and bounds them at ingest: a message or loss reason
to its first line (for a Python traceback, its final error line), 300
characters; an excerpt to the header, 8 frames, a Python traceback's error line
and the last `Caused by:` line, 2000 characters in all. While parsing, a stage keeps at
most 50 distinct failures (`StageRecord.failureDetails`, freed at finalize);
later ones count only toward the tag. Redaction (`redact.ts`) replaces every
`failureGroups[].message` and strips message text from `stackExcerpt`.
