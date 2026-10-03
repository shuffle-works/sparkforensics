# First investigation routing

How the dashboard routes a reader from a finding to the place to investigate it.

The dashboard has a view-only per-finding route, not a single
first-investigation pick: every Findings-tab recommendation row
(rendered by `FixTheseFirst.tsx`'s row components inside `ImpactBoard`)
and the visible-finding control in Stage Summary (`StageTable.tsx`) each
independently resolve and request their own target.
`detector-registry.tsx` owns each routeable finding type's stable
`widgetId`; its label comes from core `FINDING_PRESENTATION` (`findingName`)
and its title from the widget itself, not from runtime position or raw
detector type. Eligible targets
have a mapped, routeable registry entry and a non-empty trimmed
recommendation (`triageTargetFor`, `src/view/triage-target.ts`). The
target's widget still renders every affected stage in its local order.

`src/view/triage-target.ts` also exports `rankTriageTargets`, which orders
`catalog` by the run interpretation's `savingsRank`. That rank comes from
core's `rankBySavings` (`packages/core/src/run-verdict.ts`, shared with the
CLI/MCP verdict), which orders every routeable finding by potential savings
(`impactEstimate.wallClock.high`), a quantified estimate ahead of an
unquantified one, then impact band, then widget display order
(`FINDING_DISPLAY_ORDER`, core's copy of `orderedWidgets()`, which a
`tests/view/detector-registry.test.tsx` case keeps equal), then catalog order;
`selectTriageTarget` is its first entry. The occupancy-weighted impact
estimator gives every finding a comparable `impactEstimate.wallClock`
figure, and ranking by it keeps a "start here" pick off a `skew`/`straggler`
finding ranked `critical` on a ratio basis whose occupancy-clipped
recoverable time is near zero, when a lower-severity finding beside it has
an order-of-magnitude larger recoverable-time estimate. Impact band only breaks ties. `RunVerdict`'s next steps are built from
this ranking (see "Full render sequence" below).

The route is re-derived from the current catalog before each asynchronous
step. Its identity is object-reference equality against the current
catalog (`catalog.includes(finding)` in `selectTriageTargetForFinding`,
`src/view/triage-target.ts`) rather than a derived key: a new parse yields
new finding object references, so reference presence alone detects
staleness. It is not persisted and does not extend the core `Finding`
contract; cross-session consumers (exports, URL-restored state) use
the core `Finding.id` instead (see [Finding identity](../worker-protocol/evidence-report.md#finding-identity)).

`Dashboard` owns disclosure and navigation. Every routeable `REGISTRY`
widget lives in the Findings tab except the always-mounted Core Usage by
Locality, which lives in Full app report (see "Render order" above), so
`requestRoute` (`DashboardContent`, `src/view/Dashboard.tsx`) starts by
switching to the tab holding the target's widget
(`isAlwaysMountedType(target.finding.type)` picks Full app report), whether
the request came from a control already on that tab or from the other. Both
panels stay mounted, but a route can still mount its target card fresh in
the same commit as the route landing: a Basic-view band's "Show the
evidence" fold mounts its cards only when opened, and opens itself when a
route targets one of them (see "Findings tab" above). Two routing paths
have to account for that: `reportWidgetOpen` does not clear a
route just because the target `WidgetGridItem` hasn't registered yet in this
commit (a child `WidgetCard` reports its own open state before its parent
`WidgetGridItem`'s registration effect runs on a fresh mount, so treating
"not registered yet" as "stale" would drop the route before the parent even
gets a chance to register it); and a paginated widget that must reveal a
routed row passes its `routeIndex` into `usePagedRows`
(`src/view/usePagedRows.ts`), which computes the page
jump during render, not only in a post-commit effect, so the row exists in
the DOM in time for this same commit's anchor lookup instead of one commit
later.

After the target card commits open, an anchored row (`useFindingAnchor`) is
scrolled to center and focused, then flashed for 2 s; without one, the card
wrapper scrolls with a top margin below the fixed header and its disclosure
button receives visible, temporary route focus (using instant scrolling for
reduced motion). Requests use a latest-request-wins token (`tokenRef`,
`DashboardContent`) that guards every step and revalidates; a stale,
missing, unmounted, changed-catalog, or changed-active-file target cancels
without redirecting, scrolling, or moving focus. `registerWidget`'s cleanup
deletes a registration only if the map still holds that same object, so
StrictMode double-mounts don't drop a live one.

This route deliberately does not cover detector/parser or threshold
changes, Stage Detail routing, or generic
badges, tags, chips, or StagePills as controls. Config Audit findings route
like any other: they resolve against `catalog` ∪ `configFindings`.
