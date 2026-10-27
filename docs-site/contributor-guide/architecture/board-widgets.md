# Board widgets

## App- and plan-level widgets {#board-widgets-app-and-plan-widgets}

(Components below live in `src/view/widgets/`, one file per widget name,
e.g. `JobFailures.tsx`, `MemoryUtilization.tsx`.)

Beyond the stage-level cards, eleven app- and plan-level cards render in the
Findings tab, all `region: 'action'` in `detector-registry.tsx`: Incomplete
Run, Job Failures, Caching Opportunities, Autoscaling Churn, Config Audit, and
the seven Plan Advisor cards (Redundant Plan Subtree, Excessive Small Files,
Nested Loop Join, MERGE rewrites, Row-at-a-time Python UDFs, Missed Broadcast Join, Oversized Broadcast Join).
`REGISTRY` maps every finding type to its own component: 28 `action` and 4
`reference` entries.

The Plan Advisor cards are described in [Plan Advisor](./board-widgets/plan-advisor.md); Caching Opportunities, Memory Utilization and Cache Storage in [Caching and memory](./board-widgets/caching-and-memory.md); the visual system and templating rules in [Visual system and templating](./board-widgets/visual-system-and-templating.md).

- **Incomplete Run** (tag `INCMP`, `IncompleteRun.tsx`): app-level "the
  capture never finished" caveat (DETECTORS entry `incompleteRun`). Fires
  whenever `app.startTime` was observed but `app.endTime` was not, i.e. no
  `SparkListenerApplicationEnd` in the log: an in-flight job, a rotated-away
  log, or a capture cut short. Order 5, the lowest of any detector, so within
  the Warning band (its fixed impact band) its card comes first. The Findings tab's recommendation rollup (rendered by `FixTheseFirst.tsx`)
  excludes `incompleteRun` from that list outright (see
  [Widget rendering order](./widget-rendering.md#widget-rendering-order)):
  it's a pipeline-completeness caveat, not an addressable fix, so it never
  competes with other findings for a ranked slot there. Self-gates to `null`
  (no card in the DOM) once the run completed normally. Unrelated to
  `evidence-availability.ts`'s own
  `trustworthy` gate (see
  [Evidence-availability contract](./worker-protocol/evidence-availability.md#evidence-availability-contract)):
  that ledger only downgrades *absence* conclusions for individual evidence
  categories, never becomes a `DETECTORS` finding itself, and this card does
  not read it. No `docAnchor` is set: this is a tool-specific signal with no
  upstream `spark-tuning-reference` section.
- **Job Failures** (tag `JOBS`): app-level job-failure-rate rollup
  (DETECTORS entry `jobFailureRate` in `packages/core/src/detectors.ts`), computed from
  the run's `jobs` map (`ctx.jobs`, `SparkListenerJobEnd` results):
  ≥10% info, ≥30% warning, ≥50% critical. Complements the per-stage,
  task-level Failed Tasks card (tag `FAIL`).
- **Autoscaling Churn** (tag `CHRN`, `AutoscalingChurn.tsx`): app-level
  short-lived-executor detector (DETECTORS entry `autoscalingChurn` in
  `packages/core/src/detectors.ts`; reuses the same `executorsAdded`/`executorsRemoved`
  matching logic as `utilization`). For each added executor, finds its matching
  removal event and flags it short-lived if its lifetime is under 2 minutes
  (`thresholds.shortLivedMs`). An executor with no removal event is still alive
  when the log ends, so it counts in neither the short-lived count nor the
  share's denominator. Warns above 30% short-lived, escalates to
  critical above 60% (`confidence` scales `low`/`medium`/`high` via
  `autoscalingChurnConfidence`, off how far the short-lived share sits past
  `warningPct`/`criticalPct`: these thresholds are unvalidated
  estimates, not checked against real autoscaling-heavy
  logs). Returns no finding below 5 removed executors (noise
  floor) or when `app.endTime` is missing (truncated/still-running log). The
  widget shows a finding-driven verdict banner (impact dot + `CHRN` tag +
  recommendation) above its add/remove chart, whose scale-down bars are
  muted. Its
  `docAnchor` is `#bottleneck-autoscaling-churn`, a section of the
  cluster-config chapter (`docs-content/chapters/11-cluster-config.md`), not
  a bottleneck page of its own: `pageForAnchor` maps it there, so the `CHRN`
  pill opens `cluster-config.html#bottleneck-autoscaling-churn`.
- **Config Audit** (tag `CFG`): static Spark-config sanity findings derived from
  `app.config`/`app.resources` (parsed from `SparkListenerEnvironmentUpdate`):
  a missing autoscaling upper bound, a non-Kryo serializer on a run with RDD
  stages, a low executor `memoryOverhead`. Computed outside the runtime
  bottleneck catalog: its findings live in the separate `configFindings`
  stream, not `catalog`. But `FixTheseFirst`/`Alerts` both merge `catalog`
  and `configFindings` (neither reads `region`), so a Config Audit
  finding is eligible for a row in the Findings tab's recommendation
  rollup and gets its own card in the active grid, alongside genuine
  bottleneck-catalog findings.
- **Core Usage by Locality** (tag `LOCAL`, `CoreUsageArea.tsx`): app-level
  non-local-task-ratio threshold (DETECTORS entry `coreLocality`; the other
  half of a wasted-cores-ratio check, the idle-core half already
  covered by Memory Utilization's `idleCores` variant above). Sums
  `RACK_LOCAL` + `ANY` task counts against total task count across every
  stage's `stage.localityStats` (pure reducer `computeCoreLocalityRatio`,
  `packages/core/src/core-locality-ratio.ts`). `NO_PREF` stays in the denominator only,
  since it's what shuffle-read stages legitimately report with no locality
  problem. Below 50 total tasks or below a 15% non-local ratio: no finding;
  15%-35%: warning; >= 35%: critical; these thresholds are unvalidated estimates
  (`confidence` scales `low`/`medium`/`high` via
  `coreLocalityConfidence`, off whichever is weaker of the non-local ratio
  and the sampled task count, the same evidence-strength convention as the
  memory-waste model above).
  The widget's always-rendered stacked-area chart (`packages/core/src/core-usage-locality.ts`)
  does not depend on the finding. The finding adds a threshold/impact-band section above it, a
  per-stage non-local breakdown below it (shown whenever any non-local tasks
  exist at all, independent of whether the aggregate crossed threshold), and
  a one-line cross-reference to Memory Utilization when its `idleCores`
  finding also fired (idle-core ratio itself is not duplicated here).

Documented ALL-CAPS tag vocabulary: `SKEW`, `SHFL`, `SPILL`, `GC`, `COLD`,
`UTIL`, `MEM` (Memory Utilization), `CSTOR` (Cache Storage), `LOCAL`
(Core Usage by Locality), plus `FAIL` (Failed Tasks), `JOBS` (Job Failures),
`CFG` (Config Audit), `PLAN` (Plan Advisor), `SFAIL` (stage failed outright),
`PART` (partition sizing), `SLOW` (stage overall slowness), `SHAPE` (stage
shape smells), `CACHE` (caching opportunity), `CHRN` (autoscaling churn),
`TINY` (tiny tasks), `RETRY` (retry waste), `HOST` (slow executor host),
`STRAG` (straggling task), `SPEC` (speculation waste) and `INCMP` (incomplete
run); `packages/core/test/tag-vocabulary.test.js` checks the list.

ETL Phase Attribution (`packages/core/src/etl-phases.ts` + `EtlPhases.tsx`),
What-If Executor Scaling (`packages/core/src/scaling-sim.ts` + `ScalingSim.tsx`,
makespan predictions are unvalidated and carry a Model Error
indicator), and Compute Efficiency (`packages/core/src/efficiency-model.ts` +
`EfficiencyModel.tsx`, available vs. used core-hours with
`wasted-core-hours.ts`'s top stages by task core-time, the driver-vs-executor
waste split, two theoretical floors, and the right-sizing copy) are main-thread
report modules, not `DETECTORS` entries: descriptive lenses with no
impact-band threshold, rendered unconditionally into the Full app report tab
rather than participating in the bottleneck catalog. `packages/core/src/job-groups.ts`
(`checkConcurrentJobGroups`) is likewise a report helper: it flags when
concurrent SQL-execution job groups make wall-clock-based estimates
unreliable. It feeds the run interpretation's `wallClockReliable`; the
scaling simulator and the efficiency model read that flag and show a caveat
banner rather than suppressing the estimate. The same Full app report grid
also holds Evidence Availability and the Core Usage Histogram.

The scaling model also backs one `DETECTORS` entry, `rightSizing` (tag `UTIL`,
`RightSizing.tsx`, action region). `scaling-sim.ts`'s `smallestCoresWithinTolerance`
finds the fewest cores, up to the run's peak concurrent cores, whose modeled
stage time is within `tolerancePct` of the observed time the stages ran. The
finding fires when that count is at most `maxCoreShare` of the peak, on a
cluster of at least `minBaselineCores`, and only while the model's error at the
peak is at most `maxModelErrorPct`. The model is calibrated at the peak
concurrent cores. The scaling card uses `computeTotalCores`, the sum of every
executor added, so the two errors differ under dynamic allocation or executor
replacement. The finding is always `low` confidence with an informational
estimate, so it adds no idle core time beside `utilization`'s. `utilization`
measures allocated core time that ran no task; `rightSizing` names the size the
stages' own parallelism needs.

## Confidence metadata

Best-effort (non-deterministic) findings carry a `confidence` +
`validationRequired` marker, rendered by the shared `RowStatusCluster`
(`src/view/RowStatusCluster.tsx`) when `confidence` is present and not
`'high'`: a muted "`<level>` confidence" pill whose accessible tooltip
(`useAccessibleTooltip`: `title` + `aria-describedby`, keyboard-focusable)
carries `validationRequired`. Consumers include `Spill.tsx`,
`DuplicatePlanSubtree.tsx`, `SmallFiles.tsx`, `UnderBroadcast.tsx`,
`OverBroadcast.tsx`, `CachingOpportunity.tsx`, `PlanView.tsx` and
`EfficiencyModel.tsx`. Spill classification is `medium` when
classified (skew/volume) and `low` when unclassified; plan-summary warnings
are `low`. Deterministic detectors stay unmarked, treated as high confidence.

### Accessible tooltip pattern

`useAccessibleTooltip` (`src/view/AccessibleTooltip.tsx`) keeps a tooltip's text
reachable to every input mode:

- The `title` attribute serves mouse hover only. It never fires on keyboard
  focus, so a sighted keyboard user would see nothing.
- The same text is an `sr-only` DOM descendant, never gated behind hover or
  focus, that `aria-describedby` ties to the host element. Assistive tech reads
  it as the element's accessible description without an extra focus stop.
- `tooltipProps` also wires `onFocus`/`onBlur`; while focused, a visible
  bubble renders the same text. It is `aria-hidden` (the description is already
  covered by `aria-describedby`; a `tooltip` role would double-announce it) and
  carries `data-testid="visible-tooltip"` for tests.
- The hook supplies focus handlers, not a tab stop: a host that is not natively
  focusable needs its own `tabIndex={0}`.
- With no `text`, `tooltipProps` is empty and `srOnlyTooltip` renders nothing,
  so `aria-describedby` never points at an empty span.
