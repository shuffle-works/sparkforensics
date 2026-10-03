# Widget rendering

## Render order {#widget-rendering-order}

`src/view/Dashboard.tsx`'s `FilteredBoard` renders inside a `<main>` that
opens with `SampleRunNotice` (only while the bundled sample run is open),
then `RunVerdict` (built from the unfiltered catalog), then a single
`Scorecard` strip, then `FindingFilterBar` (Advanced view, or any active
filter) and (only when an active filter empties both finding streams)
`NoMatchBanner`, then (when
the active filter doesn't empty the board) a two-tab `Tabs`
(`src/components/ui/tabs.tsx`, a base-ui primitive): **Findings** and
**Full app report**, the first grouped by impact band and the second
always reachable. Both `TabsContent` panels pass
`keepMounted`, so the inactive one is hidden (native `hidden` attribute)
rather than unmounted: switching tabs keeps each widget's local state (e.g.
ImpactBoard's expanded group) and scroll position.

`region` on `RegistryEntry` (`src/view/detector-registry.tsx`) is read
only to decide whether a widget always mounts: `isAlwaysMountedType()`
flags the one `reference`-region type carved out as an always-mounted
exception, `coreLocality` → `CoreUsageArea`. The other `reference`-region
types stay ordinary finding-gated instead: `cacheUtilization`,
`memoryUtilization`, and `utilization` are a product decision: a clean run
on any of them isn't evidence worth surfacing unconditionally, so each
collapses to a plain clean-check line like any other detector. The Findings
tab (`src/view/widgets/ImpactBoard.tsx`) groups its content into two
tiers: impact-banded rows and cards for every `REGISTRY` component and
every recommendation row with at least one finding; and a collapsed "Clean
checks" disclosure covering every remaining type with zero findings, built
per detector *type* (`Object.keys(REGISTRY)`). The one always-mounted
exception lives in Full app report (see "ReferenceSection" below), which
stays structural-only.

Tags carry their own docs links; there is no separate legend widget.
`TagBadge` (`src/view/ImpactBadge.tsx`) resolves its own tooltip. Its
documentation anchor is the caller's `docAnchor` prop when that is a known
anchor (call sites holding the finding pass `finding.docAnchor`; a widget
header or grouped row passes `sharedDocAnchor(findings)`), else the type's
single known anchor (the run interpretation's `detectors[type].docAnchor`, from
`docAnchorForType` in `packages/core/src/detector-docs.ts`). The
prop matters for `configAudit`, whose four entries carry different anchors,
so the type lookup finds none. With an anchor, the pill itself links into
the docs panel, and (density `advanced` only) a second icon link opens that
tag's entry in `docs-site/user-guide/understanding-findings.md`
(`findingGuideUrl`, `packages/core/src/docs-site-config.ts`) in the same
in-app docs panel; its `target="_blank"` only applies to a modifier-click or
when no `DocsProvider` is mounted. When
a type has no vendor-doc anchor (e.g. `incompleteRun`), the pill links
straight to that same guide entry instead of rendering as inert text, and
the second icon link is skipped as redundant. Either way, a linked pill gets
a visible dotted underline, not just a hover tooltip. `TagBadge`'s
`plainBadge` prop suppresses both links together; Stage Summary's per-stage
tag chips are the one caller that sets it, on a chip that sits inside its
own investigate button. Findings-tab rows leave it unset, so their badge
links stay real `<a>`s. The HTML export renders no badge links at all
(`exportMode`).

### Widget placement

The Plan Explorer (`src/view/widgets/PlanExplorer.tsx`) is embedded inside a
flagged stage's own row, not as a standalone widget. It has four call
sites (`ShuffleIO.tsx`, `PartitionSizing.tsx`, `Spill.tsx`, and the shared
`StageFindingGroup.tsx` row behind `Skew.tsx`/`StageShape.tsx`/`TinyTask.tsx`),
each Advanced-density only and only when the stage's plan tree resolves.
The first three have no row-expansion toggle, so the trigger renders as a
direct sibling in the row body; `StageFindingGroup.tsx` renders it inside
the expanded Task detail. The same stage's plan is also reachable from `StageDetailDialog`.

Plan detection logic belongs in a `packages/core/src/detectors.ts` entry (`scope:'sql'`)
consuming `planTree`. `packages/core/src/plan-summary.ts` is display-only summarization; do
not add detection heuristics there. It is best-effort: `summarizePlanTree` reads each resolved
`planTree` node's `detail` with lenient regexes and silently omits a fragment it can't parse,
never surfacing an error.

`StageHeader.tsx` (`StagePill` plus a `<span>` naming the stage) vs. bare
`StagePill`/`StagePillGroup` is a deliberate row-density choice, not an
inconsistency: `StageHeader` is for single-stage-per-row detail widgets where
naming the stage adds context (`SlowHost.tsx`, `StageSlowness.tsx`,
`Straggler.tsx`, `SpeculationWaste.tsx`, `GcPressure.tsx`, `Skew.tsx`,
`StageShape.tsx`, `TinyTask.tsx`, `PartitionSizing.tsx`), while bare
`StagePill`/`StagePillGroup` is for compact, multi-row lists where many
stages appear per widget (`StageFailed.tsx`, `TaskFailures.tsx`,
`RetryWaste.tsx`, the four Plan Advisor widgets, `Spill.tsx`, and
`StageTable.tsx`). `ShuffleIO.tsx` uses both in different parts of its own
row, which is fine: it isn't a violation of the convention above.

Stage Summary Table (`src/view/widgets/StageTable.tsx`) defaults to the
**top 10 stages by duration**, with a header toggle to **problems only**
(stages carrying a finding). It
renders inside the Full app report tab, not as a standalone board section.

### Full render sequence

Top to bottom, in `Dashboard.tsx`'s `FilteredBoard`:

1. `SampleRunNotice` (`src/view/SampleRunNotice.tsx`), only while the
   bundled sample run is open (the landing's **Try a sample run** loads it
   under `SAMPLE_RUN_ID`, `src/view/sample-run.ts`) and never in the export
   bundle: says the board shows the sample, with **Load my event log** and a
   docs-panel link to the log-retrieval guide.
2. `RunVerdict` (`src/view/widgets/RunVerdict.tsx`): the run's verdict
   title, a summary sentence, and up to three numbered next steps built by
   `buildRunVerdict` (`packages/core/src/run-verdict.ts`, the same code the
   CLI/MCP evidence report's `verdict` runs) via `buildNextSteps`. Steps group routeable
   eligible findings by location (one stage, one multi-stage finding type,
   or one app-level finding type and variant), ordered by
   `rankBySavings` (potential savings, then impact band, then widget
   order), the same ranking every other component uses; on a run with a
   failed job, failure steps (`stageFailed`, `jobFailureRate`) move ahead
   (see below), and no other type jumps the order. Each step shows its tag,
   action label, stage and savings, then "What's happening:" (the
   measurement) and "What to try:" (the fix), split from the recommendation
   by core `recommendationParts`; a step that merged other types at its
   location adds "Also flagged here, likely the same cause: ...", and the
   summary says once that same-stage findings are grouped. Each step has
   **Show evidence**, **Stage N details** (when it has one stage) and
   **Copy**; "N more places under Findings" counts the places past the step limit.
   Basic view adds a collapsed "New to Spark tuning?" primer. An idle-capacity step (`utilization`, or
   `memoryUtilization`'s `idleCores` variant only, never its heap variants)
   titles the verdict only when it ranks first; otherwise an idle share of
   at least `IDLE_NOTABLE_PCT` (40%) adds one summary sentence. The
   idle share (`verdictIdlePct`) is the figure that idle-capacity step itself
   reports, falling back to the Scorecard's Unused core time figure only when no step
   carries one, so the title and the step never disagree. Each step's
   savings figure is followed by what it counts (`savingsMeaning` in
   `packages/core/src/impact-format.ts`: run time for a wall-clock figure, otherwise the
   resource its `rawWaste` unit measures), and **Copy next steps** copies the
   whole verdict as a plain-text checklist (`planCopyText` in core `run-verdict.ts`). Always the
   unfiltered catalog: a board filter never changes the verdict. A step's
   **Show evidence** on a finding the active filter hides clears only the
   filter dimensions that hide it (`excludingDimensions` in
   `src/view/finding-filter.ts`, synced to the URL as usual) and shows a
   one-line notice naming what it cleared; the Topbar count chip's jump to
   its impact band (`jumpToFindings` in `Dashboard.tsx`) uses the same path.
   The clean-run message ("No findings to fix right now.")
   lives here and shows only when no finding at all was emitted and the log
   lacked nothing a check needs (below); an
   `incompleteRun` finding always adds a sentence saying the figures cover
   only the captured part of the run, and titles the verdict ("This log
   looks incomplete ...") when no other finding is eligible. Job results
   (`summarizeRunOutcome` in `packages/core/src/run-outcome.ts`) set the run outcome:
   with a failed job the title says the run failed, the verdict quotes the
   first line of Spark's recorded reason (a failed job's `stageFailed`
   value first, then any `stageFailed`, then the job exception), the run is
   never called clean, and `buildNextSteps` ranks `stageFailed` and
   `jobFailureRate` steps first (a failed job's stage leading). Evidence
   caveats (a finding with `dataUnavailable`, or one `isRealFinding`
   drops), a log with no finished stage, and an `incompleteRun` log (whose
   `RUN_SPAN_CHECK_TYPES` had no run length to measure) are gaps
   (`verdictGaps`, `packages/core/src/check-coverage.ts`): any gap keeps the run from being called clean, and a
   log with no finished stage and no finding gets its own title. The
   verdict card does not list the gaps; the Clean checks disclosure's
   "Not checked on this log" group does, each caveat by its own
   recommendation text, which names the setting to enable. In Advanced view each step adds an
   "Estimate:" line from `estimateProvenance`
   (`packages/core/src/impact-format.ts`, carried as the interpretation's
   per-finding `savings.provenance`: method, basis as a point figure or a floor-to-high range, ms raw waste
   only when the floor clipped it, a non-time raw waste as the resource
   measured; nothing for `estimateMethod: 'none'` or a zero figure), the
   finding's `confidence` when not `high`, and the list ends with the
   ordering rule when it has more than one step.
3. `Scorecard`: a three-tile run-info row (Wall-clock, Efficiency, Unused
   core time; Basic view captions say what each measures, and for
   Efficiency and Unused core time which direction is better; Advanced view
   shows the raw run/idle breakdown),
   rendered once regardless of which tab is active.
4. `FindingFilterBar`, only in Advanced view or while a filter is active
   (plus `NoMatchBanner` when the active filter empties both finding
   streams).
5. A two-tab `Tabs` (skipped entirely when the active filter empties both
   finding streams; `NoMatchBanner` above already covers that case), tab
   labels **Findings** and **Full app report**:
   - **Findings** (`ImpactBoard`): one `<section>`
     per impact band in `Critical` → `Warning` → `Info` order, each rendering
     nothing when it has neither a recommendation row nor an active widget:
     a recommendation-rollup `Table` (one row per eligible-finding type,
     a display type, `incompleteRun` and evidence caveats excluded: a direct
     row for a type with one finding, an expandable, paginated summary row
     for a type with more than one) followed by a `WidgetGrid` of that
     band's active `REGISTRY` widgets (ranked by widget order: the
     interpretation's `DetectorInfo` by region, action-region components
     ahead of reference-region ones, then ascending detector order); then,
     below every impact band, a collapsed "Clean
     checks" disclosure of `CleanCheckRow` lines built per detector type
     (every remaining `REGISTRY` key with zero findings).
   - **Full app report** (`ReferenceSection`): WallClock → Timeline →
     Executor Count Over Time → StageTable → a grid of Core Usage by
     Locality → Evidence availability → fixed
     report-lens tail (ETL Phase Attribution → What-If Executor Scaling →
     Compute Efficiency → Core-Usage Distribution).
     Structural-only, as above. Hidden (not unmounted) while Findings is
     active (see "Render order" above).

Report lenses carry no impact-band chip and self-hide when their input data is
absent. Every widget self-wraps in `WidgetCard` (`src/view/WidgetCard.tsx`: an
`<h3>` title, one level below the board's `<h2>` section headers) for the
document outline, except Scorecard, which renders its own header band, and
RunVerdict, a plain `<section>` with its own `<h2>` title.

Every card is collapsible: the title sits in a `CollapsibleTrigger` button
with a chevron (`WidgetCard.tsx`), and each widget sets its own
`defaultCollapsed` (most default to `true`; `ImpactBoard`'s action-region grid
forces `defaultCollapsed` on every `REGISTRY` widget instance it mounts, so a
marginal finding doesn't default open). Route navigation ("jump to this
finding") goes through the grid coordinator instead of a fixed `tabIndex`:
`WidgetGrid.tsx` tracks each card's disclosure button and bumps
`openRequestGeneration` to force a collapsed card open and focus its trigger
when the target finding has no anchored row of its own. How much a card shows
beyond that is a board-wide choice, set by the Basic/Advanced density tier in
the topbar.
