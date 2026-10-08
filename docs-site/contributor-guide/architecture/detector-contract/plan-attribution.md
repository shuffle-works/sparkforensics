# Plan attribution

How plan-derived findings are attributed to operators and to stages.

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

The Plan Advisor detectors (`duplicatePlanSubtree`, `smallFiles`, `broadcastSizing`, `pythonUdf`
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
text rendering of the plan) is emptied before `JSON.parse` and never retained,
except the one `Arguments:` line of a Delta write command, which
`delta-targets.ts` reads to name the write target (`stripPlanDescription`,
`event-handlers.ts`). `buildChunkDecoder`
decodes each decompressed chunk in slices of at most 512 KiB, and drops the bytes of a
value that crosses a slice boundary without decoding them.

A plan node's metric values come from two sources. Driver-side values (file counts, broadcast
`data size`) arrive in `SparkListenerDriverAccumUpdates` and are summed per execution in
`accumState`. Executor-side values (Exchange `data size`, `peak memory`, `spill size`, operator
row counts, `data sent to Python workers`, timings) come from the `Accumulables` of each
`SparkListenerStageCompleted` event, kept per execution by `recordStageSqlAccumulables` in
`executorAccumState`. Only entries whose `Metadata` is `sql` are kept, and `Value` is a decimal
string. A stage's value is the accumulator's running total across every stage
(`DAGScheduler.updateAccumulators` merges each task's update into the driver-side accumulator and
records its value), so a later stage replaces an earlier one's entry instead of adding to it.
`resolvePlanTree` uses the driver-side value when there is one and the executor-side one
otherwise, and marks the latter `executorSide: true`. `average` metrics get no executor-side value:
their accumulator holds a sum of per-task averages, not the average the SQL tab shows. Plan-shape
fingerprints (`computePlanShapes`, `findCompositeCandidates`) skip `executorSide` metrics, so
`duplicatePlanSubtree` and `cachingOpportunity` ids do not depend on which tasks reported a value.

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
