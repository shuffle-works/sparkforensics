# First investigation routing

How the dashboard routes a reader from a finding to the place to investigate it.

Routing is decided as data. The board's layout says which cards exist, in which
tab and order, and which rows each card lists. A route is a pure function of a
target and that layout. No component looks for another component, waits for a
card to mount, or reads the DOM to find where to land.

## Targets

The dashboard has a view-only per-finding route, not a single
first-investigation pick: every verdict step, every Findings-tab recommendation
row (`FixTheseFirst.tsx`'s row components inside `ImpactBoard`), the visible-finding
control in Stage Summary (`StageTable.tsx`) and the stage detail dialog each
request their own target. `detector-registry.tsx` owns each routeable finding
type's stable `widgetId`; its label comes from core `FINDING_PRESENTATION`
(`findingName`) and its title from the widget itself. Eligible targets have a
mapped, routeable registry entry and a non-empty trimmed recommendation
(`triageTargetFor`, `src/view/triage-target.ts`). The target's widget still
renders every affected stage in its local order.

`src/view/triage-target.ts` also exports `rankTriageTargets`, which orders
`catalog` by the run interpretation's `savingsRank`. That rank comes from
core's `rankBySavings` (`packages/core/src/run-verdict.ts`, shared with the
CLI/MCP verdict), which orders every routeable finding by its stage's task time
(`impactEstimate.stageTaskMs`), then by potential savings
(`impactEstimate.wallClock.high`), a quantified estimate ahead of an
unquantified one, then impact band, then widget display order
(`FINDING_DISPLAY_ORDER`, core's copy of `orderedWidgets()`, which a
`tests/view/detector-registry.test.tsx` case keeps equal), then catalog order;
`selectTriageTarget` is its first entry. The occupancy-weighted impact
estimator gives every finding a comparable `impactEstimate.wallClock`
figure, and ranking by it keeps a "start here" pick off a `skew`/`straggler`
finding ranked `critical` on a ratio basis whose occupancy-clipped
recoverable time is near zero, when a lower-severity finding beside it has
an order-of-magnitude larger recoverable-time estimate. Impact band only breaks
ties. `RunVerdict`'s next steps are built from this ranking.

A target is not persisted and does not extend the core `Finding` contract.
Rows are keyed by the core `findingKey` (`src/view/finding-keys.ts`,
`runFindingKeys`), made unique within the run, so a finding of another run
lands on the row that shows the same finding. Cross-session consumers (exports,
URL-restored state) use the core `Finding.id` instead (see
[Finding identity](../worker-protocol/evidence-report.md#finding-identity)).

Beyond a finding, a route can ask for an evidence ledger row
(`{ kind: 'evidence', key }`) or a landmark (`{ kind: 'landmark', id }`): the
verdict, the Findings board, an impact band's heading or the filter bar.

## The layout

`buildBoardLayout` (`src/view/board-layout.ts`) is a pure function of the run's
interpretation, the finding filter and the widget density. It returns:

- `steps`: the verdict's steps, each with the evidence it shows in place. A
  `panel` step has an evidence panel and offers the control for it; a `bare` step
  has nothing beyond its line and is itself the landing; a step with no evidence
  routes to its widget's card.
- `bands`: per impact band, the board's rows (single findings and type groups,
  each with its evidence panel or none) and the evidence cards no step or row
  shows in place. A card a step or row already shows is in the layout too, marked
  `route-only`: it appears in its band only once a route has revealed it, which
  is how a route to a finding no step or row holds (a log note, an evidence
  caveat) still lands.
- `reference`: the Full app report's tiles the data has content for.
- `cards`: every card by key, with its tab, whether it is a `panel`, a `grid`
  card or `route-only`, and the keys of the rows it lists.
- `lines`: the controls the triage shortcuts step through, in reading order.
- `holders`: for each finding key, the step or row line that holds it and the
  widget card that lists it.

The same layout is what the views render: `RunVerdict` renders `steps`,
`ImpactBoard` renders `bands`, `ReferenceSection` renders `reference`. A tile
with nothing to show is absent from the layout, so it leaves no blank grid cell,
and a widget's evidence panel exists exactly when the widget's `rows` function
keeps a row (see
[row-expand-contract](./row-expand-contract.md#in-place-evidence-panel)).
`FilteredBoard` (`Dashboard.tsx`) builds the layout once per interpretation,
filter and density and provides it through `BoardLayoutContext`.

## Resolving a route

`resolveRoute(target, layout)` returns `{ tab, openCards, cardKey, rowKey }` or
null when the layout has no place for the target (a finding the filter or the run
does not list). For a finding:

1. A step or row with an evidence panel opens that panel and lands on the
   finding's own row inside it.
2. A step or row whose widget has nothing beyond it is the landing: the route
   lands on its label or title.
3. Otherwise the widget's card opens and the route lands on the finding's row in
   it, or on the card's own title when the card lists no row for the finding (a
   finding the filter hides from an always-mounted card).

`tab` is the tab that holds the landing, or null for the verdict, which sits
above the tabs. The Core Locality card lives in Full app report, so a route to it
shows that tab; every other card is in Findings.

`routeTo(layout, target)` (`src/view/route-landing.ts`) resolves a target and
starts the route in the store. A jump from an unfiltered surface (the verdict, the
stage dialog, the top bar's count chip) first clears only the filter dimensions
that hide the target, builds the layout for that selection, and resolves against
it, so the route and the filter change happen together.

## Route state

The Findings board's state for the loaded run is the store's `board` slice
(`src/store/board.ts`): the active tab, the open cards, the cards a route has
revealed, the expanded group, the active route, the line holding focus, and the
widget state described below. It is replaced when a run loads. A route in the
store carries its token, whether it flashes its row and where it scrolls to.

A card's disclosure is controlled by the board: `WidgetCard` is open when its key
is in `openCards`, and a route opens the cards its result lists. A card that is
not in a layout (a widget rendered on its own, as in the docs examples) keeps its
own state.

## Landing

An element that can be a landing takes `useLanding(keys)` (`route-landing.ts`) as
its ref callback. When the active route's `rowKey` is one of its keys, the element
scrolls itself into view and focuses itself in the commit that mounts it, so a
route to a row in a card the route opens, or in a tab the route shows, needs no
wait for the card or the tab. Each route lands once: an element that mounts again
under the same route does not take focus again, and a newer route to the same
place lands again. `useAnchoredRow` (`finding-anchor.ts`) gives every row a
finding widget renders its landing, its `tabIndex={-1}` and its flash.

A flash is the `route-flash` CSS animation, which ends by itself; the next route
or a tab change ends the mark. A paginated list shows the page that holds the
routed row: `RowList` (`finding-widget.tsx`) finds the row's index in its ordered
rows during render and passes it to `usePagedRows`.

## Triage shortcuts

In Advanced view `useTriageShortcuts` binds j/k to step through `lines` from the
line that holds focus, `f` to land on the filter bar and 1/2 to switch tabs. A
group's member lines are walked only while the group is expanded
(`walkableLines`). A line reports focus to the store (`useLine`), and the
shortcut starts a route to the next line without a flash.

## Widget state and what is mounted

The board mounts only what is showing. A hidden tab renders none of its widgets,
and a board card that is collapsed renders no body (`WidgetCard.tsx`). A card on
its own keeps its collapsed body mounted, hidden, because nothing outside it
holds its state. What a widget remembers while its body is unmounted (a page, a
sort, the Stage Summary's filter, the Clean checks disclosure) lives in the
`board` slice through `useWidgetState` (`src/view/useWidgetState.ts`), under a
key from the card (`useCardStateKey`) or a fixed one, and goes when the run does.

## Guards

`rules/no-dom-routing.yml` fails `npm run lint:structure` for
`document.getElementById`, `querySelector`, `querySelectorAll`,
`getClientRects`, `offsetParent`, `requestAnimationFrame` and `queueMicrotask`
under `src/view/` and `src/docs-widget/`. Measured layout (charts, the plan graph,
the Stage Summary scroll hint) and the docs host are allowlisted in the rule; a
document this app does not render takes a suppression with its reason.

## Tests

- `tests/view/board-layout.test.ts` builds the layout and resolves a route for
  every finding of every docs example run, in both densities, without rendering.
- `tests/view/route-focus.test.tsx` renders the exported dashboard for each of
  those runs, routes to each example finding and asserts `document.activeElement`
  is a visible element inside the resolved card, with no fake timers.
- `tests/view/finding-anchor.test.tsx` covers a row's landing, flash and
  once-per-route rule.
- `tests/view/board-mounting.test.tsx` covers that a hidden tab and a collapsed
  card hold no widgets and that widget state survives.
- `tests/view/triage-navigation.test.tsx` keeps a few App-level smoke tests of the
  wiring between the controls, the store and the board.

This route deliberately does not cover detector/parser or threshold changes, or
generic badges, tags, chips, or StagePills as controls. Config Audit findings
route like any other: they resolve against `catalog` ∪ `configFindings`.
