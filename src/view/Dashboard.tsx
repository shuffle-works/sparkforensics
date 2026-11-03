import { Suspense, useCallback, useMemo, useState, type DragEvent, type ReactNode } from 'react';

import { selectAppModel, selectCatalog, selectConfigFindings, store, useStore, useWidgetDensity } from '@/store/store';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isAlwaysMountedType, type WidgetProps } from '@/view/detector-registry';
import { findingName } from '@sparkforensics/core/finding-names.ts';
import { BoardLayoutContext } from '@/view/BoardLayoutContext';
import {
  buildBoardLayout,
  type BoardLayout,
  type StepEvidence,
} from '@/view/board-layout';
import { NoMatchBanner } from '@/view/EmptyStateBanners';
import { FindingFilterBar } from '@/view/FindingFilterBar';
import { FindingFilterProvider, useFindingFilter } from '@/view/FindingFilterContext';
import { eligibleFindings, useInterpretation } from '@/view/interpretation';
import { InlineEvidence } from '@/view/InlineEvidence';
import { routeTo } from '@/view/board-route';
import { BOARD_LANDMARK, bandLandmark, VERDICT_LANDMARK } from '@/view/route-keys';
import {
  deriveOptions,
  emptySelection,
  excludingDimensions,
  filterFindings,
  IMPACT_BANDS,
  isEmptySelection,
  matchesFilter,
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
import { SampleRunNotice } from '@/view/SampleRunNotice';
import { Scorecard } from '@/view/widgets/Scorecard';
import { ImpactBoard } from '@/view/widgets/ImpactBoard';
import { StageDetailDialog } from '@/view/widgets/StageDetailDialog';
import { StageTable } from '@/view/widgets/StageTable';
import { Timeline } from '@/view/widgets/Timeline';
import { EvidenceAvailability } from '@/view/widgets/EvidenceAvailability';
import { WallClock } from '@/view/widgets/WallClock';
import { Topbar } from '@/view/Topbar';
import { WidgetCardSkeleton } from '@/view/WidgetCard';
import { WidgetGrid, WidgetGridItem } from '@/view/WidgetGrid';
import { useIngest } from '@/store/useIngest';
import { useTriageShortcuts } from '@/view/useTriageShortcuts';
import { useRecentFiles } from '@/view/useRecentFiles';
import type { TriageTarget } from '@/view/triage-target';
import type { Finding } from '@sparkforensics/core/types.ts';

type ActiveTab = 'findings' | 'full-report';

/**
 * "Full app report" tab content: the structural widgets (WallClock,
 * Timeline, Executor Count, Stage Summary, Evidence Availability) plus the
 * fixed-order tail of non-detector report lenses ("Widget rendering order" in
 * docs-site/contributor-guide/architecture/widget-rendering.md).
 * `REGISTRY` widgets render inside the Findings tab's `ImpactBoard`, not
 * here, except the always-mounted Core Locality chart, a run-wide reference
 * view that sits beside the executor timeline. Selecting the tab is itself the
 * disclosure. The Scorecard lives in its own strip above the tabs, shared by
 * both. The layout decides which reference tiles exist, so a tile with nothing
 * to show leaves no blank grid cell.
 */
function ReferenceSection({
  layout,
  appModel,
  catalog,
  configFindings,
  getTaskData,
  onRoute,
}: WidgetProps & { layout: BoardLayout; onRoute: (target: TriageTarget) => void }) {
  return (
    <div className="space-y-6">
      <h2 className="sr-only">Full app report</h2>
      <WallClock />
      <Timeline appModel={appModel} catalog={catalog} />
      <ExecutorCountChart appModel={appModel} />
      <StageTable appModel={appModel} catalog={catalog} getTaskData={getTaskData} onRoute={onRoute} />
      <WidgetGrid>
        {layout.reference.map((card) => (
          <WidgetGridItem key={card.key} cardId={card.key} collapsedTile>
            {card.kind === 'widget' ? (
              <Suspense fallback={<WidgetCardSkeleton />}>
                <card.component appModel={appModel} catalog={catalog} configFindings={configFindings} getTaskData={getTaskData} defaultCollapsed />
              </Suspense>
            ) : card.kind === 'evidence-availability' ? <EvidenceAvailability ledger={appModel.evidenceAvailability} />
              : card.kind === 'etl-phases' ? <EtlPhases />
                : card.kind === 'scaling-sim' ? <ScalingSim appModel={appModel} />
                  : card.kind === 'efficiency-model' ? <EfficiencyModel />
                    : <CoreUsageHistogram appModel={appModel} getTaskData={getTaskData} />}
          </WidgetGridItem>
        ))}
      </WidgetGrid>
    </div>
  );
}

/** Names the filter values a route cleared, for the notice that says so. */
function clearedFilterNotice(dimensions: FilterDimension[], selection: FilterSelection, subject: string): string {
  const parts = dimensions.map((dimension) => {
    if (dimension === 'impactBands') return selection.impactBands.size > 0 ? `${[...selection.impactBands].join(', ')} impact` : 'default impact';
    if (dimension === 'types') return [...selection.types].map((type) => findingName(type)).join(', ');
    return [...selection.stages].map((stageId) => `Stage ${stageId}`).join(', ');
  });
  return `Cleared the ${parts.join(' and ')} filter${parts.length === 1 ? '' : 's'} to show ${subject}.`;
}

/** The filtered board body: reads the active filter, builds the board's layout once (which cards
 * exist, their rows and order), and renders it, so counts, pills, the active/clean split and every
 * route resolve against the same data. Lives inside FindingFilterProvider. */
function FilteredBoard({
  appModel,
  catalog,
  configFindings,
  getTaskData,
  options,
  renderTopbar,
}: WidgetProps & {
  options: FilterOptions;
  renderTopbar: (onJumpToFindings: (impactBand: Finding['impactBand']) => void) => ReactNode;
}) {
  const { selection, replaceSelection } = useFindingFilter();
  const density = useWidgetDensity();
  const interpretation = useInterpretation();
  const activeTab = useStore((s) => s.board.tab);
  const layoutInput = useMemo(
    () => ({ interpretation, appModel, catalog, configFindings: configFindings ?? [], density }),
    [interpretation, appModel, catalog, configFindings, density],
  );
  const layout = useMemo(() => buildBoardLayout({ ...layoutInput, selection }), [layoutInput, selection]);
  useTriageShortcuts({ enabled: density === 'advanced', layout });
  const widgetProps = useMemo<WidgetProps>(
    () => ({ appModel, catalog, configFindings, getTaskData }),
    [appModel, catalog, configFindings, getTaskData],
  );
  const renderVerdictEvidence = useCallback((evidence: Extract<StepEvidence, { kind: 'panel' }>, finding: Finding) => (
    <InlineEvidence widget={evidence.widget} widgetProps={widgetProps} stated={[finding]} panel={evidence.panel} cardKey={evidence.cardKey} />
  ), [widgetProps]);
  // Tied to the selection the route produced, so any later filter change hides it.
  const [filterNotice, setFilterNotice] = useState<{ text: string; selection: FilterSelection } | null>(null);

  // A jump from an unfiltered surface (verdict, stage dialog, top bar chip) must land on the board:
  // clear only the filter dimensions that hide it. Returns the layout under the cleared selection.
  const revealFinding = useCallback((finding: Finding, subject: string): BoardLayout => {
    const dimensions = excludingDimensions(finding, selection);
    if (dimensions.length === 0) return layout;
    const next = { ...selection };
    for (const dimension of dimensions) Object.assign(next, { [dimension]: emptySelection()[dimension] });
    // An empty impact selection lists critical and warning only, so an info finding needs the info band named.
    if (dimensions.includes('impactBands') && finding.impactBand === 'info') next.impactBands = new Set(IMPACT_BANDS);
    replaceSelection(next);
    setFilterNotice({ text: clearedFilterNotice(dimensions, selection, subject), selection: next });
    return buildBoardLayout({ ...layoutInput, selection: next });
  }, [layout, layoutInput, selection, replaceSelection]);
  const routeFinding = useCallback((target: TriageTarget) => {
    routeTo(layout, target);
  }, [layout]);
  const routeToVisible = useCallback((target: TriageTarget) => {
    const visible = isAlwaysMountedType(target.finding.type) ? layout : revealFinding(target.finding, 'this finding');
    routeTo(visible, target);
  }, [layout, revealFinding]);
  const showMoreFindings = useCallback(() => {
    routeTo(layout, { kind: 'landmark', id: BOARD_LANDMARK });
  }, [layout]);
  // The top bar's count chip: reveal the band it counts (the finding needing the fewest cleared
  // dimensions) and land on its heading. A band the verdict's steps already hold has no row in the
  // Findings tab: land on the verdict, which lists it.
  const jumpToFindings = useCallback((impactBand: Finding['impactBand']) => {
    const counted = eligibleFindings(interpretation).filter((f) => f.impactBand === impactBand && !layout.verdictLeads.has(f));
    const closest = counted.reduce<Finding | null>((best, finding) => (
      !best || excludingDimensions(finding, selection).length < excludingDimensions(best, selection).length ? finding : best
    ), null);
    if (!closest) {
      routeTo(layout, { kind: 'landmark', id: VERDICT_LANDMARK });
      return;
    }
    routeTo(revealFinding(closest, `the ${impactBand} findings`), { kind: 'landmark', id: bandLandmark(impactBand) });
  }, [interpretation, layout, selection, revealFinding]);
  const filteredCatalog = useMemo(() => filterFindings(catalog, selection), [catalog, selection]);
  const filteredConfig = useMemo(() => filterFindings(configFindings ?? [], selection), [configFindings, selection]);

  // The board renders two filtered streams (catalog + config), so the count and
  // the no-match state must consider both: filtering to a CFG-only type (e.g.
  // configAudit) empties `filteredCatalog` while `filteredConfig` still has
  // matches, and must NOT show "No findings match".
  const totalFilteredCount = filteredCatalog.length + filteredConfig.length;
  // Info findings the impact filter leaves out, that every other filter keeps.
  const hiddenNotes = useMemo(() => [...catalog, ...(configFindings ?? [])].filter((finding) => (
    finding.impactBand === 'info' && !matchesFilter(finding, selection) && matchesFilter({ ...finding, impactBand: 'warning' } as Finding, selection)
  )).length, [catalog, configFindings, selection]);
  const filteredToEmpty = (catalog.length + (configFindings ?? []).length) > 0 && totalFilteredCount === 0 && hiddenNotes === 0;
  const showFilterBar = density === 'advanced' || !isEmptySelection(selection);
  const { listedCount } = layout;

  return (
    <BoardLayoutContext.Provider value={layout}>
    {/* First in tab order: past the top bar's controls to the verdict. */}
    <button
      type="button"
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow focus:ring-2 focus:ring-ring"
      onClick={() => routeTo(layout, { kind: 'landmark', id: VERDICT_LANDMARK })}
    >
      Skip to the verdict
    </button>
    {renderTopbar(jumpToFindings)}
    <main className="mx-auto w-full max-w-[80rem] min-w-0 flex-1 space-y-4 px-4 pt-5 pb-12 sm:px-8">
      <SampleRunNotice />
      {/* Verdict and Scorecard first, from the unfiltered catalog: they answer "how did this
          run go and where do I start", which a board filter must not change. */}
      {interpretation ? <RunVerdict
          interpretation={interpretation}
          onRoute={routeToVisible}
          onShowMoreFindings={showMoreFindings}
          moreFindingsCount={listedCount}
          steps={layout.steps}
          renderEvidence={renderVerdictEvidence}
        /> : null}
      {interpretation ? <Scorecard interpretation={interpretation.data} catalog={catalog} /> : null}
      {/* Filtering is a power control: Advanced mode shows it, and so does an
          active selection (e.g. from a shared URL), so a filtered board never
          hides the control that explains and clears it. */}
      {showFilterBar && <FindingFilterBar options={options} resultCount={totalFilteredCount} hiddenNotes={hiddenNotes} />}
      {/* The notice explains what the bar lost, so it goes when the bar does
          (Basic view once a route cleared the last active filter). */}
      {showFilterBar && filterNotice?.selection === selection ? (
        <p role="status" className="text-sm text-muted-foreground">{filterNotice.text}</p>
      ) : null}
      {hiddenNotes > 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {hiddenNotes} info note{hiddenNotes === 1 ? '' : 's'} hidden. Select the info impact pill in Filter findings
          {showFilterBar ? '' : ' (in Advanced view)'} to show {hiddenNotes === 1 ? 'it' : 'them'}.
        </p>
      ) : null}
      {filteredToEmpty && <NoMatchBanner />}
      {/* Filtering to nothing at all is already covered by NoMatchBanner
          above, so skip the whole tab set here rather than render an empty
          board under it. */}
      {!filteredToEmpty && (
        <Tabs value={activeTab} onValueChange={(value) => store.getState().selectTab(value as ActiveTab)}>
          <TabsList variant="chrome" aria-label="Report view">
            {/* Chrome variant triggers render ~37px tall (py-2 + text-sm line
                height + border-t), above the 32px baseline tap-target-comfortable
                assumes, so the base -6px inset alone already clears 44px; no
                --sm modifier needed here. */}
            <TabsTrigger value="findings" className="tap-target-comfortable">
              Findings
              {listedCount > 0 ? <span aria-hidden="true" className="font-mono text-xs font-normal text-muted-foreground tabular-nums">{listedCount}</span> : null}
            </TabsTrigger>
            <TabsTrigger value="full-report" className="tap-target-comfortable">Full app report</TabsTrigger>
          </TabsList>
          <TabsContent value="findings">
            <h2 className="sr-only">Findings</h2>
            <ImpactBoard layout={layout} widgetProps={widgetProps} onRoute={routeFinding} />
          </TabsContent>
          <TabsContent value="full-report">
            <ReferenceSection
              layout={layout}
              appModel={appModel}
              catalog={filteredCatalog}
              getTaskData={getTaskData}
              configFindings={filteredConfig}
              onRoute={routeFinding}
            />
          </TabsContent>
        </Tabs>
      )}
      {/* Full, unfiltered catalog: a stage pill must still open evidence even
          when the finding is filtered out of the board lists. */}
      <StageDetailDialog appModel={appModel} catalog={catalog} getTaskData={getTaskData} onRoute={routeToVisible} showInfo={selection.impactBands.has('info')} />
    </main>
    </BoardLayoutContext.Provider>
  );
}

/** The main app chrome once a file has parsed successfully: topbar, the
 * widget board, the docs sheet, and the stage-detail dialog. Also
 * owns a lightweight drag-to-load overlay so dropping a new file anywhere
 * over the dashboard starts a fresh parse. */
function DashboardContent() {
  const { resetToDropZone, startLoad, getTaskData, compareWithAnotherRun } = useIngest();
  const appModel = useStore(selectAppModel);
  const catalog = useStore(selectCatalog);
  // Config-scope findings are part of the installed run, built once by `analyzeRun`; Dashboard
  // never calls the analyzer directly.
  const configFindings = useStore(selectConfigFindings);
  const activeFileId = useStore((s) => s.activeFileId);
  const exportMode = useStore((s) => s.exportMode);
  const { recentEntries, onPickRecent, onRemoveRecent } = useRecentFiles(activeFileId);
  const [dragOver, setDragOver] = useState(false);

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
      <FindingFilterProvider options={options}>
        <FilteredBoard
          appModel={appModel}
          catalog={catalog}
          configFindings={configFindings}
          getTaskData={getTaskData}
          options={options}
          renderTopbar={(onJumpToFindings) => (
            <Topbar
              onJumpToFindings={onJumpToFindings}
              onLoadNew={resetToDropZone}
              onCompare={compareWithAnotherRun}
              recentEntries={recentEntries}
              activeFileId={activeFileId}
              onPickRecent={onPickRecent}
              onRemoveRecent={onRemoveRecent}
            />
          )}
        />
      </FindingFilterProvider>

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
  return <DashboardContent />;
}
