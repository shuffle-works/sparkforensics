import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import { store, useStore, useWidgetDensity } from '@/store/store';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { REGISTRY, type WidgetProps } from '@/view/detector-registry';
import { NoMatchBanner } from '@/view/EmptyStateBanners';
import { EvidenceAvailabilityProvider, useEvidenceAvailabilityDisclosure } from '@/view/EvidenceAvailabilityContext';
import { FindingFilterBar } from '@/view/FindingFilterBar';
import { FindingFilterProvider, useFindingFilter } from '@/view/FindingFilterContext';
import {
  deriveOptions,
  emptySelection,
  excludingDimensions,
  filterFindings,
  isEmptySelection,
  type FilterDimension,
  type FilterOptions,
  type FilterSelection,
} from '@/view/finding-filter';
import { CoreUsageHistogram } from '@/view/widgets/CoreUsageHistogram';
import { EfficiencyModel } from '@/view/widgets/EfficiencyModel';
import { EtlPhases } from '@/view/widgets/EtlPhases';
import { ExecutorCountChart } from '@/view/widgets/ExecutorCountChart';
import { ScalingSim } from '@/view/widgets/ScalingSim';
import { RunVerdict } from '@/view/widgets/RunVerdict';
import { Scorecard } from '@/view/widgets/Scorecard';
import { ImpactBoard } from '@/view/widgets/ImpactBoard';
import { StageDetailDialog } from '@/view/widgets/StageDetailDialog';
import { StageTable } from '@/view/widgets/StageTable';
import { Timeline } from '@/view/widgets/Timeline';
import { EvidenceAvailability } from '@/view/widgets/EvidenceAvailability';
import { WallClock } from '@/view/widgets/WallClock';
import { WastedCoreHours } from '@/view/widgets/WastedCoreHours';
import { Topbar } from '@/view/Topbar';
import { WidgetGrid, WidgetGridItem } from '@/view/WidgetGrid';
import { useIngest } from '@/store/useIngest';
import { useRecentFiles } from '@/view/useRecentFiles';
import {
  TriageNavigationProvider,
  type WidgetRegistration,
} from '@/view/TriageNavigationContext';
import {
  selectTriageTargetForFinding,
  type TriageTarget,
} from '@/view/triage-target';
import type { Finding } from '@sparkforensics/core/types.ts';

type ActiveTab = 'findings' | 'full-report';

interface RouteRequest {
  target: TriageTarget;
  token: number;
}

/**
 * "Full app report" tab content: the structural widgets (WallClock,
 * Timeline, Executor Count, Stage Summary, Evidence Availability) plus the
 * fixed-order tail of non-detector report lenses ("Widget rendering order" in
 * docs-site/contributor-guide/architecture/widget-rendering.md).
 * `REGISTRY` widgets render unconditionally inside the Findings tab's
 * `ImpactBoard`, not here; selecting the tab is itself the disclosure. The
 * Scorecard lives in its own strip above the tabs, shared by both.
 */
function ReferenceSection({
  appModel,
  catalog,
  getTaskData,
  activeFileId,
  onRoute,
}: WidgetProps & { onRoute: (target: TriageTarget) => void }) {
  return (
    <div className="space-y-6">
      <h2 className="sr-only">Full app report</h2>
      <WallClock appModel={appModel} />
      <Timeline appModel={appModel} catalog={catalog} />
      <ExecutorCountChart appModel={appModel} activeFileId={activeFileId} />
      <StageTable appModel={appModel} catalog={catalog} getTaskData={getTaskData} onRoute={onRoute} />
      <WidgetGrid>
        <WidgetGridItem cardId="reference-evidence-availability" collapsedTile>
          <EvidenceAvailability ledger={appModel.evidenceAvailability} />
        </WidgetGridItem>
        <WidgetGridItem cardId="reference-etl-phases" collapsedTile><EtlPhases appModel={appModel} /></WidgetGridItem>
        <WidgetGridItem cardId="reference-scaling-sim" collapsedTile><ScalingSim appModel={appModel} /></WidgetGridItem>
        <WidgetGridItem cardId="reference-efficiency-model" collapsedTile><EfficiencyModel appModel={appModel} /></WidgetGridItem>
        <WidgetGridItem cardId="reference-wasted-core-hours" collapsedTile><WastedCoreHours appModel={appModel} /></WidgetGridItem>
        <WidgetGridItem cardId="reference-core-usage-histogram" collapsedTile><CoreUsageHistogram appModel={appModel} getTaskData={getTaskData} /></WidgetGridItem>
      </WidgetGrid>
    </div>
  );
}

/** Names the filter values a route cleared, for the notice that says so. */
function clearedFilterNotice(dimensions: FilterDimension[], selection: FilterSelection): string {
  const parts = dimensions.map((dimension) => {
    if (dimension === 'impactBands') return `${[...selection.impactBands].join(', ')} impact`;
    if (dimension === 'types') return [...selection.types].map((type) => REGISTRY[type]?.findingLabel ?? type).join(', ');
    return [...selection.stages].map((stageId) => `Stage ${stageId}`).join(', ');
  });
  return `Cleared the ${parts.join(' and ')} filter${parts.length === 1 ? '' : 's'} to show this finding.`;
}

/** The filtered board body: reads the active filter, derives the filtered
 * catalog/config streams once, and threads them to every widget so counts,
 * pills, the active/clean split, and the first-action route all stay
 * consistent. Lives inside FindingFilterProvider. */
function FilteredBoard({
  appModel,
  catalog,
  configFindings,
  getTaskData,
  activeFileId,
  options,
  onRoute,
  activeTab,
  onActiveTabChange,
}: WidgetProps & {
  options: FilterOptions;
  onRoute: (target: TriageTarget) => void;
  activeTab: ActiveTab;
  onActiveTabChange: (tab: ActiveTab) => void;
}) {
  const { selection, replaceSelection } = useFindingFilter();
  const density = useWidgetDensity();
  // Tied to the selection the route produced, so any later filter change hides it.
  const [filterNotice, setFilterNotice] = useState<{ text: string; selection: FilterSelection } | null>(null);

  // A route target must be on the board to land: clear only the filter
  // dimensions that hide it (the verdict routes from the unfiltered catalog).
  const routeToVisible = useCallback((target: TriageTarget) => {
    const dimensions = excludingDimensions(target.finding, selection);
    if (dimensions.length > 0) {
      const next = { ...selection };
      for (const dimension of dimensions) Object.assign(next, { [dimension]: emptySelection()[dimension] });
      replaceSelection(next);
      setFilterNotice({ text: clearedFilterNotice(dimensions, selection), selection: next });
    }
    onRoute(target);
  }, [selection, replaceSelection, onRoute]);
  const filteredCatalog = useMemo(() => filterFindings(catalog, selection), [catalog, selection]);
  const filteredConfig = useMemo(() => filterFindings(configFindings ?? [], selection), [configFindings, selection]);

  // The board renders two filtered streams (catalog + config), so the count and
  // the no-match state must consider both: filtering to a CFG-only type (e.g.
  // configAudit) empties `filteredCatalog` while `filteredConfig` still has
  // matches, and must NOT show "No findings match".
  const totalFilteredCount = filteredCatalog.length + filteredConfig.length;
  const filteredToEmpty = (catalog.length + (configFindings ?? []).length) > 0 && totalFilteredCount === 0;

  return (
    <main className="flex-1 space-y-6 p-4">
      {/* Verdict first, from the unfiltered catalog: it answers "how did this
          run go and where do I start", which a board filter must not change. */}
      <RunVerdict appModel={appModel} catalog={catalog} configFindings={configFindings} onRoute={routeToVisible} />
      <Scorecard appModel={appModel} catalog={filteredCatalog} />
      {/* Filtering is a power control: Advanced mode shows it, and so does an
          active selection (e.g. from a shared URL), so a filtered board never
          hides the control that explains and clears it. */}
      {(density === 'advanced' || !isEmptySelection(selection)) && (
        <FindingFilterBar options={options} resultCount={totalFilteredCount} />
      )}
      {filterNotice?.selection === selection ? (
        <p role="status" className="text-sm text-muted-foreground">{filterNotice.text}</p>
      ) : null}
      {filteredToEmpty && <NoMatchBanner />}
      {/* Filtering to nothing at all is already covered by NoMatchBanner
          above, so skip the whole tab set here rather than render an empty
          board under it. */}
      {!filteredToEmpty && (
        <Tabs value={activeTab} onValueChange={(value) => onActiveTabChange(value as ActiveTab)}>
          <TabsList variant="chrome" aria-label="Report view">
            {/* Chrome variant triggers render ~37px tall (py-2 + text-sm line
                height + border-t), above the 32px baseline tap-target-comfortable
                assumes, so the base -6px inset alone already clears 44px; no
                --sm modifier needed here. */}
            <TabsTrigger value="findings" className="tap-target-comfortable">Findings</TabsTrigger>
            <TabsTrigger value="full-report" className="tap-target-comfortable">Full app report</TabsTrigger>
          </TabsList>
          {/* keepMounted: switching tabs must not reset ImpactBoard's local
              triage state (expandedGroupKey) or scroll position; a real
              triage session bounces between these tabs constantly. base-ui's
              Tabs.Panel already supports this (hidden via the `hidden`
              attribute, not unmounted); TabsContent passes it through
              untouched, so this is a per-instance opt-in, not a change to
              the shared primitive or its other consumers. */}
          <TabsContent value="findings" keepMounted>
            <h2 className="sr-only">Findings</h2>
            <ImpactBoard
              appModel={appModel}
              catalog={filteredCatalog}
              configFindings={filteredConfig}
              stages={appModel.stages}
              getTaskData={getTaskData}
              activeFileId={activeFileId}
              onRoute={onRoute}
            />
          </TabsContent>
          <TabsContent value="full-report" keepMounted>
            <ReferenceSection
              appModel={appModel}
              catalog={filteredCatalog}
              getTaskData={getTaskData}
              configFindings={filteredConfig}
              activeFileId={activeFileId}
              onRoute={onRoute}
            />
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}

/** The main app chrome once a file has parsed successfully: topbar, the
 * (Phase 3) widget board, the docs sheet, and the stage-detail dialog. Also
 * owns a lightweight drag-to-load overlay so dropping a new file anywhere
 * over the dashboard starts a fresh parse. */
function DashboardContent() {
  const { resetToDropZone, startLoad, getTaskData } = useIngest();
  const appModel = useStore((s) => s.appModel);
  const catalog = useStore((s) => s.catalog);
  const activeFileId = useStore((s) => s.activeFileId);
  const exportMode = useStore((s) => s.exportMode);
  const { recentEntries, onPickRecent, onRemoveRecent } = useRecentFiles(activeFileId);
  const [dragOver, setDragOver] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('findings');
  const { referenceOpen } = useEvidenceAvailabilityDisclosure();
  const [routeRequest, setRouteRequest] = useState<RouteRequest | null>(null);
  const [routeFocusedWidgetId, setRouteFocusedWidgetId] = useState<string | null>(null);
  const [flashedFinding, setFlashedFinding] = useState<Finding | null>(null);
  // Refs mirror the active request so the imperative callbacks below stay
  // referentially stable (widget registration keys on them). `tokenRef`
  // supersedes older requests; `routeFileRef` catches a file swap that keeps
  // the same catalog object refs. Findings are held by reference, so a replaced
  // catalog is detected by `selectTriageTargetForFinding`'s `includes` check.
  const tokenRef = useRef(0);
  const routeRef = useRef<RouteRequest | null>(null);
  const routeFileRef = useRef<string | null>(null);
  const registrationsRef = useRef(new Map<string, WidgetRegistration>());
  const findingAnchorsRef = useRef(new Map<Finding, HTMLElement>());
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The route coordinator's active destination, derived (not separate state)
  // so it's naturally non-null exactly while a route is pending and clears
  // the instant `routeRequest` does. Consumed by widgets via
  // `useActiveRouteTarget()` to notice mid-render "I'm the destination" and
  // jump their own pagination before their anchor row exists.
  const activeRouteTarget = routeRequest?.target ?? null;

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  // `revealEvidence` (evidence links across the app) sets `referenceOpen`
  // true to mean "the reader wants Full app report visible"; under the tab
  // layout that means switching to that tab rather than expanding an
  // accordion.
  useEffect(() => {
    if (referenceOpen) setActiveTab('full-report');
  }, [referenceOpen]);

  const clearRoute = useCallback((token: number) => {
    if (routeRef.current?.token !== token) return;
    routeRef.current = null;
    routeFileRef.current = null;
    setRouteRequest((current) => (current?.token === token ? null : current));
  }, []);

  // Re-validate a request against live store state: a newer request, a file
  // swap, or a catalog that no longer holds the finding by reference makes it
  // stale (never scroll/focus).
  const resolveRoute = useCallback((route: RouteRequest): TriageTarget | null => {
    if (routeRef.current?.token !== route.token) return null;
    const { catalog: currentCatalog, configFindings: currentConfig, activeFileId: currentFileId } = store.getState();
    if (routeFileRef.current !== currentFileId) return null;
    const resolved = selectTriageTargetForFinding(route.target.finding, [...currentCatalog, ...currentConfig]);
    if (!resolved || resolved.widgetId !== route.target.widgetId || resolved.region !== route.target.region) {
      return null;
    }
    return resolved;
  }, []);

  const requestRoute = useCallback((target: TriageTarget) => {
    // Every routeable REGISTRY widget lives in the Findings tab (see
    // ReferenceSection's doc comment above): a route request always needs
    // that tab active, whether it was initiated from Findings itself or
    // from a Full app report control like Stage Summary's own route link.
    setActiveTab('findings');
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    const { catalog: currentCatalog, configFindings: currentConfig, activeFileId: currentFileId } = store.getState();
    const resolved = selectTriageTargetForFinding(target.finding, [...currentCatalog, ...currentConfig]);
    if (!resolved || resolved.widgetId !== target.widgetId || resolved.region !== target.region) {
      routeRef.current = null;
      routeFileRef.current = null;
      setRouteRequest(null);
      return;
    }

    const next = { target: resolved, token };
    routeRef.current = next;
    routeFileRef.current = currentFileId;
    setRouteRequest(next);
  }, []);

  const registerWidget = useCallback((widgetId: string, registration: WidgetRegistration) => {
    registrationsRef.current.set(widgetId, registration);
    // A widget that mounts after a route request (e.g. a Reference widget once
    // its section expands) opens itself here; already-mounted widgets are opened
    // by the layout effect below.
    const route = routeRef.current;
    if (route?.target.widgetId === widgetId && resolveRoute(route)) registration.open();

    return () => {
      if (registrationsRef.current.get(widgetId) === registration) {
        registrationsRef.current.delete(widgetId);
      }
    };
  }, [resolveRoute]);

  const registerFindingAnchor = useCallback((finding: Finding, element: HTMLElement) => {
    findingAnchorsRef.current.set(finding, element);
    return () => {
      if (findingAnchorsRef.current.get(finding) === element) {
        findingAnchorsRef.current.delete(finding);
      }
    };
  }, []);

  const reportWidgetOpen = useCallback((widgetId: string, open: boolean) => {
    if (!open) return;
    const route = routeRef.current;
    if (!route || route.target.widgetId !== widgetId) return;
    const resolved = resolveRoute(route);
    if (!resolved) {
      clearRoute(route.token);
      return;
    }
    const registration = registrationsRef.current.get(widgetId);
    if (!registration) {
      // This WidgetCard just mounted in the same commit as the route request
      // (e.g. routing back into the Findings tab after it was unmounted):
      // its own WidgetGridItem registers as a parent effect that hasn't run
      // yet. Leave the route pending rather than clearing it: registerWidget
      // bumps openRequestGeneration once it does register, which re-fires
      // this reportOpen effect on the next commit so it can complete.
      return;
    }
    const disclosureButton = registration.getDisclosureButton();
    if (!disclosureButton) {
      clearRoute(route.token);
      return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const anchorElement = findingAnchorsRef.current.get(resolved.finding);
    if (anchorElement) {
      // Anchored row exists (a widget wired via `useFindingAnchor`): scroll and
      // focus the exact flagged row instead of the disclosure title, and flash
      // it briefly so it stays findable once focus moves on.
      anchorElement.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'center',
        inline: 'nearest',
      });
      anchorElement.focus({ preventScroll: true });
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      setFlashedFinding(resolved.finding);
      flashTimeoutRef.current = setTimeout(() => {
        flashTimeoutRef.current = null;
        setFlashedFinding(null);
      }, 2000);
    } else {
      // No anchor registered for this finding (widget not yet wired, or a
      // finding type with no per-row anchor); fall back to widget-level title
      // focus.
      registration.wrapperElement.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'start',
        inline: 'nearest',
      });
      disclosureButton.focus({ preventScroll: true });
      setRouteFocusedWidgetId(widgetId);
    }
    clearRoute(route.token);
  }, [clearRoute, resolveRoute]);

  const clearRouteFocus = useCallback((widgetId: string) => {
    setRouteFocusedWidgetId((current) => (current === widgetId ? null : current));
  }, []);

  // Open the request's target: for widgets already registered when the request
  // lands. On next layout the card commits open and reports back via
  // `reportWidgetOpen`, which scrolls + focuses.
  useLayoutEffect(() => {
    if (!routeRequest) return;
    const resolved = resolveRoute(routeRequest);
    if (!resolved) {
      clearRoute(routeRequest.token);
      return;
    }
    registrationsRef.current.get(resolved.widgetId)?.open();
  }, [clearRoute, resolveRoute, routeRequest]);

  // Cancel a pending request when the file or catalog changes out from under it.
  useLayoutEffect(() => {
    const route = routeRef.current;
    if (route && !resolveRoute(route)) clearRoute(route.token);
  }, [activeFileId, catalog, clearRoute, resolveRoute]);

  // Config-scope findings are computed once at ingest time (useIngest.ts's
  // runDone/pickRecent/drillIntoRun, alongside `catalog`) and read from the
  // store here; Dashboard never calls the analyzer directly.
  const configFindings = useStore((s) => s.configFindings);
  // Filter options are derived from the values actually present in the full
  // catalog∪config; passed to the provider (seeds/validates the URL selection)
  // and to the bar.
  const options = useMemo<FilterOptions>(
    () => deriveOptions(catalog, configFindings),
    [catalog, configFindings],
  );

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (exportMode) return;
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (exportMode) return;
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) startLoad(file);
  };

  return (
    <div
      data-testid="dashboard"
      className="relative flex min-h-screen flex-col"
      // Reserve room for the fixed docs panel (published via --docs-inset by
      // DocsSheet); 0px when closed, so the board reflows into the space left.
      style={{ paddingRight: 'var(--docs-inset, 0px)' }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Topbar
        onLoadNew={resetToDropZone}
        recentEntries={recentEntries}
        activeFileId={activeFileId}
        onPickRecent={onPickRecent}
        onRemoveRecent={onRemoveRecent}
      />

      <FindingFilterProvider options={options} fileId={activeFileId}>
        <TriageNavigationProvider
          registerWidget={registerWidget}
          registerFindingAnchor={registerFindingAnchor}
          reportWidgetOpen={reportWidgetOpen}
          clearRouteFocus={clearRouteFocus}
          focusedWidgetId={routeFocusedWidgetId}
          activeRouteTarget={activeRouteTarget}
          flashedFinding={flashedFinding}
        >
          <FilteredBoard
            appModel={appModel}
            catalog={catalog}
            configFindings={configFindings}
            getTaskData={getTaskData}
            activeFileId={activeFileId}
            options={options}
            onRoute={requestRoute}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
          />
        </TriageNavigationProvider>
      </FindingFilterProvider>

      {/* Full, unfiltered catalog: a stage pill must still open evidence even
          when the finding is filtered out of the board lists. */}
      <StageDetailDialog appModel={appModel} catalog={catalog} getTaskData={getTaskData} />

      {dragOver && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80"
        >
          <p className="rounded-lg border-2 border-dashed border-primary px-6 py-4 text-lg font-medium">
            Drop to load a new event log
          </p>
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  return (
    <EvidenceAvailabilityProvider>
      <DashboardContent />
    </EvidenceAvailabilityProvider>
  );
}
