# Detector contract

`packages/core/src/detectors.ts` is the single source of Spark-optimization logic: one
declarative `DETECTORS` entry per pattern, each carrying `type`, `scope`
(`stage` / `app` / `config` / `sql`), `order`, `fixEffort`, `version`, a
`thresholds` object, an `emits` list, an optional `docAnchor` (every entry but
`incompleteRun` sets one), optional `inScorecard`, `property` and
`suppressedBy`, and co-located `detect()` and `estimate()` functions. Each
finding's `impactBand` and recommendation copy are set inside `detect()`, and so is its
`remediation`: the structured `{kind: 'conf', key, direction, suggested}` form of the Spark
properties that copy names (`increaseConf`, `decreaseConf` and `setConf` in
`packages/core/src/remediation.ts`). A detector adds an entry only for a property its
recommendation already names, and leaves `suggested` null unless it computes the value itself.
Entries apply together unless the recommendation words them as alternatives ("either ... or"):
`idleCapacityFix` in `detectors.ts` gives an idle-capacity finding with dynamic allocation off the
alternatives `set spark.dynamicAllocation.enabled` and `decrease spark.executor.instances`, and with
it on `decrease spark.dynamicAllocation.maxExecutors` plus `decrease
spark.dynamicAllocation.minExecutors` when the logged floor is above 0.
`Remediation` is a union: `codeFix(hint)` builds the `{kind: 'code', hint}` entry for a fix no
property makes, which the skew family emits when its origin is `other` or skew-join handling is
already on. Code that reads `key` checks `kind` first.

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
  `auditConfig()` separately runs the `scope:'config'` entries. The three `configAudit` entries stay out of the
  bottleneck catalog because each sets `inScorecard:false`, not because of
  `scope:'config'`: a config-scope detector without that flag would run
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
[Bottleneck thresholds](./detector-contract/threshold-tables.md#bottleneck-thresholds). Only the CLI and
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
`efficiency-model.ts`'s zero-skew floor and the cluster size the `utilization` finding reports. The
idle capacity the `utilization` and `memoryUtilization` entries, `efficiency-model.ts` and
`wasted-core-hours.ts` measure against is the allocation (`allocatedCoreMs()` in `allocation.ts`,
cores × time each executor was alive), so the Scorecard's Unused core time and the verdict's idle
figure share one capacity that never exceeds what the run held.
`computeTotalCores(app, executorsAdded)`, used only by `scaling-sim.ts`, sums every
`ExecutorAdded` event with no regard for overlap, so under executor churn (spot preemption,
`dynamicAllocation` replacement) it double-counts a churned executor's capacity against its
replacement's; the peak-concurrent sweeps don't.

## Effective configuration

A detector that reads or suggests a Spark property resolves it through
`effectiveSparkConf()` (`packages/core/src/spark-conf.ts`), which layers three
sources: the SQL execution's `modifiedConfigs` (the session settings that differ
from the SparkContext's, as `spark.conf.set` leaves them), the app's Spark
Properties, then Spark's default for the run's version. It returns the value and
the layer it came from (`query`, `app` or `default`). `sparkConfDefault()` is the
version table alone; its entries are read from Spark's `SQLConf.scala` and
`config/package.scala` at the release tags, and a property whose default depends on
the cluster or on another property has no entry. Add a property to the table only
with the release that introduced each of its defaults, and a per-version test.

A detector scoped to one SQL execution (`skew`, `straggler`, `shuffle`,
`partitionSizing`, `underBroadcast`, `overBroadcast`) passes that execution's
`modifiedConfigs`: `detectors.ts`'s `stageApp()` and `queryApp()` return the app with
them applied, so the helpers that take an app (`effectiveConf`, `loggedAs`,
`switchFix`) need no second argument. Run-wide detectors use the app as logged.
The frozen detection thresholds do not follow a per-query setting; only the advice does.

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
[user guide](../../user-guide/getting-started/tuning-thresholds.md#tuning-detector-thresholds)
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
`straggler` has no `suppressedBy` but judges a tail with `skew`'s resolved
thresholds (`DetectorCtx.skewThresholds`), so its findings carry `skew`'s
tuned thresholds the same way (`THRESHOLD_DEPENDENCY` in
`threshold-overrides.ts`). Only that one link is followed. The
evidence report repeats the label on the finding row, the clean check, the
`detectors` catalog row (whose `thresholds` are then the effective ones)
and in `summary.tunedThresholds`; see
[Portable evidence report](./worker-protocol/evidence-report.md#portable-evidence-report).

A tuned `floorPctWarn`/`floorPctCrit` on `skew` or `straggler` also grades
that entry's own findings in `deriveImpactBand` (`impact-band.ts`); every
other finding keeps the run-wide default floors. `--max-skew` recomputes the
ratio with the run's effective `minTasksForP95`, so the budget measures the
same ratio the skew finding reports. Caveat text that names a threshold
(`gc`, `skew`, `straggler`, `memoryUtilization`, `coreLocality`) and the
`broadcastSizing` over-broadcast recommendation state the value the detector
ran with. The HTML export still renders the
default-threshold analysis.
