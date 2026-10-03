# Drill-down

`StageDetailProvider` (`src/view/StageDetailContext.tsx`) exposes stage
drill-down through React context. Any component calls
`useStageDetail().openStage(stageId)` to open `StageDetailDialog.tsx`, a
shadcn `Dialog` (base-ui), for that stage. The direct callers are StagePill,
Timeline, StageTable and RunVerdict (a step's stage button). Every widget that
embeds a `StagePill`, `StagePillGroup` or `StageHeader` reaches it indirectly.

The dialog is titled "Stage N", with Spark's stage name (the code line that
created the stage) as a labelled "Code location" description. Its body opens
with one sentence placing the stage in the run (duration, share of the run's
wall-clock, task count, how many finding types it carries), then lists each
finding type at the stage (`locationKey`'s rule, the one the verdict groups
steps by: a `stageId` match, or a `stageIds` list naming only this stage)
the way `RunVerdict` lists a step: tag and action label, the measurement ("What's happening", split off by `recommendationParts`), "What to try", the impact estimate, and a
**Show evidence** button. Types follow the verdict's own order
(`buildNextSteps`: potential savings first, failure findings first on a run
whose jobs failed), with types outside the stage's own verdict step after them,
worst band first. The grouping and order are computed once by `interpretRun`
(`interpretStages` in `packages/core/src/run-interpretation.ts`, shipped as
`stages[id].{findingIndexes,typeOrder}`); the dialog only renders them. Show evidence closes the dialog and calls the optional `onRoute` prop
(`routeToVisible` from `Dashboard.tsx`, which clears any board filter that
hides the target, as the verdict's own route does);
`finalFocus` skips returning focus to the opener in that case, so the route's
own focus on the evidence stands. Without `onRoute` the button is not shown.

## Plan DOT serialization

`packages/core/src/plan-dot.ts` (entry `planTreeToDot(planTree, { title })`) serializes a
resolved `planTree` to a
Graphviz DOT string. It is dependency-free string building. One pre-order walk
(`walkPlanTree`, deduping shared subtrees) assigns each node a stable id and
`label` (name, plus `detail` on a second line when it differs) and records its
parent→child edge, since the parent's id always exists first. Edges are
written after all node lines. The graph is laid out `rankdir=BT`, leaves at the bottom, matching
Spark's own plan orientation.

It carries no metric annotation: pure structure. A null plan returns an empty string. There is no
download/export UI for this output; `PlanView.tsx` calls it
only to decide whether a stage's plan tree can render as a graph at all, and a
non-empty result gates the "View plan graph" button.

## Disclosure hierarchy

The Summary/Context/Details 3-tier framing (collapsed lead metric → expanded
widget body → per-stage `StageDetailDialog`) does not apply uniformly across the
28 registry widgets (`src/view/detector-registry.tsx`). 18 have a stage-anchored
Details tier reachable via `StagePill`/`StagePillGroup`: Skew, StageShape,
TinyTask, ShuffleIO, PartitionSizing, Spill, GcPressure, StageFailed,
TaskFailures, RetryWaste, SlowHost, StageSlowness, Straggler,
SpeculationWaste, and DuplicatePlanSubtree, SmallFiles, UnderBroadcast and
OverBroadcast (sql-scope, so
they list every stage in `stageIds` as a `StagePillGroup` rather than one
`StagePill`). The other 10 are app- or config-scope with no stage to
drill into, by design, so they stop at Summary/Context: MemoryUtilization,
ExecutorUtilization (`utilization` is an app-wide average, no stage), JobFailures, ConfigAudit,
CacheUtilization, CoreUsageArea, AutoscalingChurn, CachingOpportunity (`scope:
'app'`, `stageId: null` on both its finding constructions, so it has no stage
to anchor to despite reading like a per-stage widget), IncompleteRun, and
ColdStart (unlike SlowHost, StageSlowness, Straggler and SpeculationWaste,
app-scoped with no `stageId`).

## Reference panel

`DocsLink` (`src/view/DocsContext.tsx`), finding tag pills (`TagBadge`) and a
few guide links call `useDocs().open(anchor)` or `openSite(path)` to open a
docked, resizable docs panel (`src/view/DocsSheet.tsx`, mounted once in
`src/App.tsx` inside `DocsProvider`). The topbar's Docs button is a plain link
that opens the docs site in a new tab. The panel iframes a docs-site
(VitePress) page, built from the tuning reference under
`packages/core/src/docs-content/{chapters,tuning,diagrams}` (generated at build
and test time by `scripts/fetch-tuning-docs.mjs`, gitignored, from the
`shuffle-works/spark-tuning-reference` commit pinned in the committed
`docs-content/upstream.json`;
`npm run docs:bump` moves the pin) and published as static HTML at `docs/tuning-reference/<page>.html`
(`docs-config.ts`'s `docsUrl()` resolves an anchor to that path plus a
`#<anchor>` fragment). `open`/`openSite` set React state (`isOpen`,
`target`). The panel is a non-modal base-ui `Dialog` (`modal={false}`,
`disablePointerDismissal`) laid out with `react-resizable-panels`. The
dashboard stays interactive and reflows beside it through the `--docs-inset`
CSS variable. Only the close button or Escape dismisses it, and base-ui owns
focus-in, focus-restore and Escape. Key events inside the iframe never reach
the app's document, so `DocsSheet`'s `listenForEscapeInFrame` also listens in
a same-origin frame's own document and closes on Escape unless the docs'
search popup is open (a cross-origin frame keeps only the close button).
Exported dashboards have no docs, so they never open this panel. There is a single `DocsTarget` shape
(`{ kind: 'site', source: 'reference' | 'guide', path }`, set by `open(anchor)`
or `openSite(path)`; `source` only picks the panel title), so
`DocsSheet` always drives the iframe the same way, reassigning `src` on any
path or theme change.

Most anchors the app links to are the page of the same name; a handful are
in-page fragments on another page instead (config-audit sub-findings and the
metric glossary live on the `config`/`metrics` pages; bottleneck sub-anchors
such as `bottleneck-stage-shape` live on the page of the bottleneck that owns
them, and two, `bottleneck-autoscaling-churn` and
`bottleneck-cache-utilization`, on the `cluster-config`/`memory-model`
chapters):
`docs-config.ts`'s `pageForAnchor()` is the one place that resolves an anchor
to its owning page. `npm run docs:build` (run automatically by `npm run
build`) generates `packages/core/src/docs-content/` from the pin if needed
(`scripts/fetch-tuning-docs.mjs`), reshapes it into
`docs-site/tuning-reference/*.md` (`scripts/build-tuning-reference.mjs`), then
VitePress renders it into `docs-site/.vitepress/dist`, and the `copyDocsSite`
plugin (`vite-plugins/copy-docs-site.ts`, registered in `vite.config.ts`)
copies that output to `dist/docs`; Vite's relative asset base keeps the app
and docs usable when `dist/` is deployed under a URL subpath.
`tests/doc-anchor-coverage.test.js` intersects `packages/core/src/docs-content/chapters/nav-index.json`
against every detector's `docAnchor` and warns (never fails) on dead links
(detector points at an anchor the nav index doesn't have) or orphaned
Detector Catalog anchors (no detector points at them); see
`scripts/doc-anchor-coverage.js`. The landing page
(`docs-site/tuning-reference/index.md`, the symptom-picker entry page) is
hand-authored, committed markdown, unlike the generated pages next to it.

A docs-site page has no channel back to this app: it's a plain static page
with no `postMessage` listener. `DocsSheet.tsx` reassigns the iframe's `src`
outright on any change to the resolved path or the theme, forcing a full
reload. Since re-assigning the exact same `src` string wouldn't make the
browser reload it, a `t=<theme>` marker is threaded into the query string
ahead of the `#anchor` hash purely to change the string and force a real
reload; the page never reads that param itself: it reads its light/dark
preference once, from the `vitepress-theme-appearance` localStorage key
`ThemeProvider` keeps current, the moment it boots.
