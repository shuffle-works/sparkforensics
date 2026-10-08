# Findings tab

How the Findings tab renders recommendation rows and active widget cards in one impact-ranked board.

Rendered by `FilteredBoard`'s `TabsContent value="findings"`
(`src/view/widgets/ImpactBoard.tsx`): recommendation rows and active
widget cards in one impact-ranked board. The recommendation-rollup logic lives in
`src/view/widgets/FixTheseFirst.tsx` (its own file with directly-testable
exports, not rendered as a standalone page section by `Dashboard.tsx`) and
the active-widget logic lives in `src/view/widgets/Alerts.tsx` (same: not
rendered standalone).
`ImpactBoard` calls `FixTheseFirst.tsx`'s exported `useFixTheseFirstData`
(eligible findings, rollup groups, the top triage target) and
`Alerts.tsx`'s exported `computeActiveWidgets` (the ranked active-`REGISTRY`
list). The rollup and its ranking are computed in core by `interpretRun`
(`rankedRollup`/`rankFindings`, `packages/core/src/recommendation-rollup.ts`);
`useFixTheseFirstData` reads it through `boardRollup`
(`src/view/interpretation.ts`: the interpretation's carried groups when
unfiltered, core `rankedRollup` recomputed over the kept findings under a
filter). `ImpactBoard` then buckets rows by each group's `band` (its
representative member's impact band, after core `rankFindings`, the same
finding whose impact band its own badge already shows) and cards by each
active widget's own `worstImpactBand`.

Eligible findings for the rollup are `catalog` ∪ `configFindings` that pass
core `isEligible` (`packages/core/src/recommendation-rollup.ts`) and have a
display type (`FINDING_DISPLAY_ORDER`): `incompleteRun` (a
pipeline-completeness caveat, not an addressable fix) and every `dataUnavailable` evidence caveat (e.g.
`memoryUtilization`'s `memoryBand` variant, already covered by Evidence
availability's own `executorMetrics` entry,
`packages/core/src/evidence-availability.ts`) are excluded. Findings are grouped strictly by `finding.type` via
`buildRecommendationRollup` (`packages/core/src/recommendation-rollup.ts`, further split
within a type by impact kind and, for `resource`, unit: never merged across
types); each resulting group becomes one row: a type with exactly one
finding renders that finding directly, a type with more than one collapses
into a summary row. Within an impact band, group order comes from
`buildRecommendationRollup`'s own sort: `time` groups (a real `wallClock`
claim) first, ranked among themselves by their union-capped
`recoverableMsHigh` descending; then `resource` groups (`rawWaste` but no
`wallClock`); then `count` groups (neither), both of the latter two ranked
by worst impact band, never by their incomparable raw magnitudes.
A summary row's tag badge and action label come from the group's own
highest-impact member (via the same three-tier comparator, core
`rankFindings`); its sentence is the type-level
`coreFindingGenericRecommendation`, not one member's own numbers. The
trailing stat depends on the group's
kind (`×N · <time> recoverable`, `×N · <total>` with the summed resource
waste the CLI report also prints, or `×N` alone, adding a per-impact-band
tally only when the group mixes bands). Clicking it expands straight to the group's
full, impact-ranked list, with no intermediate "worst-K" step, paginated at
10 rows per page (`data-testid="fix-these-first-group-row"`; no pager renders
for a group of 10 or fewer findings; it appears once a group exceeds 10).
A band's rollup rows render as a headerless three-column `Table`
(`src/components/ui/table.tsx`): a single-finding row (`FindingRow`,
`data-testid="fix-these-first-row"`, `data-finding-type`) has three
`TableCell`s: the impact dot + ALL-CAPS tag as a real `TagBadge` (not
`plainBadge`: nothing wraps it, so its own docs links stay real `<a>`s,
same as everywhere else on the board); a text block inside its own nested
`<button>` (a short imperative action label, e.g. "Reduce shuffle size",
from `findingActionLabel` (`packages/core/src/finding-action-label.ts`), over the
finding's own full `recommendation` sentence in smaller muted text, both
wrapping rather than truncating); and a right-aligned monospace stage
reference + impact figure (e.g. `St.49 · 20.1s`, via the shared
`formatWallClockRange`/`formatRawWaste` in `packages/core/src/format-utils.ts`). That inner button, not the
row, is the click target: it routes via `selectTriageTargetForFinding`
(`src/view/triage-target.ts`), the same per-finding resolver Stage Summary
Table's own control uses (see "First investigation routing" below); a
`TypeGroupRow`'s own inner button toggles its expand state instead
(`aria-expanded`). An expanded group's members (`FindingInstanceRow`) omit
the badge and span its cell (`colSpan={2}`): the location line, then the
recommendation clamped to one line, then the figure in the third column.
`ImpactBoard` owns which single group is expanded (`expandedGroupKey`); a
`TypeGroupRow` owns only its page.

Each impact band (`ImpactBoard.tsx`'s own `ImpactGroup`, one call per
entry of `IMPACT_BAND_ORDER_LIST = ['critical', 'warning', 'info']`) is a
`<section aria-labelledby>` pointing at its
`<h2 id="impact-band-<band>-heading" tabIndex={-1}>` (Critical, Warning,
Info; the top bar's count chip focuses it), a sibling of the panel's
sr-only `<h2>Findings</h2>`, and renders nothing (not even the heading) when it has neither a
rollup row nor an active widget: a run with no critical findings has no
"Critical" heading or section at all. Inside a band, rollup rows render
first as the headerless `Table` described above, followed by that band's
active `REGISTRY` widget cards (`computeActiveWidgets`'s ranked list,
filtered to this impact band) in their own `WidgetGrid`: every one of
`orderedWidgets()`'s `REGISTRY` components *except* the one
always-mounted one below, with at least one finding in `catalog` ∪
`configFindings`. Within a band, active widgets keep `orderedWidgets()`'s
own order: the interpretation's `DetectorInfo` sorted by region
(`action` first), then ascending detector `order`. In Basic
view a band with both rows and cards folds its `WidgetGrid` behind one
"Show the evidence (N cards)" disclosure, unmounted while closed; it opens
itself (and stays open) when the active route target
(`useActiveRouteTarget`) is one of its cards, and the card, mounting with
the route still pending, opens and scrolls itself through
`registerWidget`. A band with cards but no rows, and every band in
Advanced view, shows its grid directly.
`cacheUtilization`, `memoryUtilization`, and `utilization` are
`reference`-region types but aren't always-mounted exceptions, so a Cache
Storage, Memory Utilization, or Executor Utilization card with an active
finding surfaces in its own impact band like any other active widget.

Below the impact bands, `Alerts.tsx`'s exported `CleanChecks` renders a
collapsed "Clean checks" disclosure
of `CleanCheckRow` lines (`src/view/widgets/CleanCheckRow.tsx`: the type's
tag chip and label, plus in Advanced view the threshold it was held to, the
interpretation's `detectors[type].thresholdSummary` from
`getThresholdSummary`, which states the detector's own numbers) built per
detector *type* (every `REGISTRY` key
except that one always-mounted key), under one "Every check below passed."
line (or "No check could run on this log." when none did) and grouped by detector scope (Per-stage, App-level,
SQL plan, Config checks). Types the log could not check (an `isEvidenceCaveat`
finding of that type, every per-stage type when no stage finished, or the
run-span types `RUN_SPAN_CHECK_TYPES` on an `incompleteRun` log, the same
rule that keeps the verdict from calling the run clean) render first under
**Not checked on this log** as `CleanCheckRow status="notRun"`, drawn
neutral rather than clean green, after the interpretation's `coverage.gaps`
(`verdictGaps`) lines saying why
and naming the setting to turn on. A clean run lands `cacheUtilization`,
`memoryUtilization`, and `utilization` here too, same as any ordinary
action-region type. Caching Opportunities, Config Audit, and the five
Plan Advisor widgets (Redundant Plan Subtree, Excessive Small Files,
Row-at-a-time Python UDFs, Missed Broadcast Join, Oversized Broadcast Join) render through the ordinary
active/clean paths above (see
[App- and plan-level widgets](../board-widgets.md#board-widgets-app-and-plan-widgets)).
Core Usage by Locality (`coreLocality`, resolving to `CoreUsageArea`) is
not in the Findings tab at all: it mounts unconditionally from `appModel`
at the head of the Full app report's reference grid
(`alwaysMountedWidgets()`/`isAlwaysMountedType()`), carrying its own
impact-band indicator when a finding is active instead of collapsing to a
clean-check line on a clean run. A `coreLocality` finding still lists in
its impact band's recommendation rows, and its **Show evidence** switches
to the Full app report tab.
