import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, FileText, GitCompareArrows, Home, Keyboard, Moon, Sun, Workflow } from 'lucide-react';

import { badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Chip, severityBadgeVariants } from '@/view/ImpactBadge';
import { isCleanRun } from '@sparkforensics/core/check-coverage.ts';
import { summarizeRunOutcome } from '@sparkforensics/core/run-outcome.ts';
import { isEligible } from '@/view/widgets/FixTheseFirst';
import { EvidenceExport, EvidenceExportMenuItems, useEvidenceExport } from '@/view/EvidenceExport';
import { FileSwitcher } from '@/view/FileSwitcher';
import { GraphViewPickerDialog, type GraphViewPickerEntry } from '@/view/GraphViewPickerDialog';
import { KeyboardShortcutsDialog } from '@/view/KeyboardShortcutsDialog';
import { WidgetDensityControl, WidgetDensityMenuItem } from '@/view/WidgetDensityControl';
import { store, useStore } from '@/store/store';
import { useTheme } from '@/theme/ThemeProvider';
import { worstImpactBand, formatDuration, IMPACT_BAND_ORDER } from '@sparkforensics/core/format-utils.ts';
import { stageIdsForSqlExec } from '@sparkforensics/core/detectors.ts';
import { cn } from '@/lib/utils';
import type { RecentFileEntry } from '@/view/RecentList';
import type { AppModel, Finding, ImpactBand, StageId } from '@sparkforensics/core/types.ts';

// Relative, not `/docs/`: the app itself can be published under a subpath
// (e.g. the hub's `/sparkforensics/`), and a leading slash would resolve
// against the domain root instead of wherever this app actually loaded from.
// Mirrors CompareLanding.tsx's DOCS_SITE_ROOT.
const DOCS_SITE_ROOT = 'docs/';

function verdictLabel(worst: ImpactBand, count: number): string {
  if (worst === 'warning') return `${count} warning${count === 1 ? '' : 's'}`;
  return `${count} ${worst}`;
}

function findingMatchesExecutionStage(finding: Finding, stageIds: readonly StageId[]): boolean {
  if (finding.stageId != null && stageIds.includes(finding.stageId)) return true;
  return finding.stageIds?.some((stageId) => stageIds.includes(stageId)) ?? false;
}

/** Every SQL execution eligible for the Topbar's "open the graph view
 * directly" entry point: it must have a resolved plan tree and at least one
 * linked stage to anchor the graph on. `description`/`startTime`/`endTime`
 * are declared `unknown` on SqlExecution (see the spec's typing footnote), so
 * every read here is guarded rather than trusted. */
function eligibleGraphExecutions(appModel: AppModel, catalog: Finding[]): GraphViewPickerEntry[] {
  const out: GraphViewPickerEntry[] = [];
  for (const [executionId, exec] of appModel.sql) {
    if (!exec.planTree) continue;
    const ids = stageIdsForSqlExec(executionId, appModel.stages);
    const stageId = ids.length > 0 ? Math.min(...ids) : null;
    if (stageId == null) continue;
    const rawDescription = exec.description;
    const label = typeof rawDescription === 'string' && rawDescription.trim()
      ? rawDescription
      : `SQL execution #${executionId}`;
    const rawStart = exec.startTime;
    const rawEnd = exec.endTime;
    const duration = typeof rawStart === 'number' && typeof rawEnd === 'number'
      ? formatDuration(rawEnd - rawStart)
      : null;
    const stageFindings = catalog.filter((f) => findingMatchesExecutionStage(f, ids));
    const worst = worstImpactBand(stageFindings);
    const impactBand: ImpactBand | null = worst ?? null;
    const findingCount = stageFindings.length;
    out.push({
      executionId,
      stageId,
      label,
      secondary: duration ? `#${executionId} · ${duration}` : `#${executionId}`,
      impactBand,
      findingCount,
    });
  }
  // Recognition over recall: surface the high-impact/actionable executions
  // first, so a long list doesn't bury a critical finding below unflagged
  // ones. Unflagged entries (impact band null) always sort last.
  out.sort((a, b) => {
    const rankA = a.impactBand ? IMPACT_BAND_ORDER[a.impactBand] : Infinity;
    const rankB = b.impactBand ? IMPACT_BAND_ORDER[b.impactBand] : Infinity;
    if (rankA !== rankB) return rankA - rankB;
    return a.executionId - b.executionId;
  });
  return out;
}

export interface TopbarProps {
  onLoadNew: () => void;
  recentEntries: RecentFileEntry[];
  activeFileId: string | null;
  onPickRecent: (id: string) => void;
  onRemoveRecent: (id: string) => void;
  /** Opens the two-run comparison with the open run as Run A. Omitted where
   * there is nothing to compare from (the export bundle). */
  onCompare?: () => void;
  /** Shows the Findings list at the given impact band (the top bar's count
   * chip). Omitted where there is no list to jump to. */
  onJumpToFindings?: (impactBand: ImpactBand) => void;
  /** When provided, replaces the impact chip and the whole dashboard
   * action cluster (comparison button, evidence export, plan-graph button)
   * with this content, used by non-dashboard routes (e.g. the plan graph
   * view) that need Topbar's shared app-identity/file-switcher chrome plus
   * their own section-specific controls instead. The theme toggle stays
   * visible either way. */
  sectionControls?: ReactNode;
  /** Optional content rendered on the left, next to the file switcher (e.g.
   * the plan graph route's page title), so a route's heading sits at the start
   * of the bar rather than crammed into the right-hand `sectionControls`. */
  leadingContent?: ReactNode;
}

export function Topbar({
  onLoadNew,
  recentEntries,
  activeFileId,
  onPickRecent,
  onRemoveRecent,
  onCompare,
  onJumpToFindings,
  sectionControls,
  leadingContent,
}: TopbarProps) {
  const app = useStore((s) => s.appModel.app);
  const catalog = useStore((s) => s.catalog);
  const skippedLines = useStore((s) => s.skippedLines);
  const exportMode = useStore((s) => s.exportMode);
  const { theme, toggle } = useTheme();
  const moreOptionsTriggerRef = useRef<HTMLButtonElement>(null);
  const comparison = useStore((s) => s.comparison);
  // Not while a comparison is paused behind "Back to comparison": that
  // control already leads back to one. Needs app, the condition for the open
  // run to be snapshotted as Run A.
  const showCompare = onCompare != null && !sectionControls && !exportMode && activeFileId != null && app != null && !comparison.baselineId;
  const evidence = useEvidenceExport();
  const appModel = useStore((s) => s.appModel);
  const graphEntries = useMemo(() => eligibleGraphExecutions(appModel, catalog), [appModel, catalog]);
  const [graphPickerOpen, setGraphPickerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== '?') return;
      // Don't hijack "?" while the user is typing it into a search box or
      // any other text field (the Type/Stage filter search, a future text
      // input, etc.).
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      event.preventDefault();
      setShortcutsOpen(true);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  function handleOpenGraphView() {
    if (graphEntries.length === 0) return;
    if (graphEntries.length === 1) {
      store.getState().openPlanGraph(graphEntries[0].stageId, { initialScope: 'full' });
      return;
    }
    setGraphPickerOpen(true);
  }

  function handlePickGraphExecution(stageId: StageId) {
    store.getState().openPlanGraph(stageId, { initialScope: 'full' });
    setGraphPickerOpen(false);
  }

  const name = app?.name || 'Spark Application';
  const sub = [app?.id, app?.sparkVersion ? `Spark ${app.sparkVersion}` : null]
    .filter(Boolean)
    .join(' · ');

  // Count what the verdict ranks: eligible findings, config included and
  // evidence caveats left out, so the chip and the verdict never disagree.
  const configFindings = useStore((s) => s.configFindings);
  const allFindings = useMemo(() => [...catalog, ...configFindings], [catalog, configFindings]);
  const eligible = useMemo(() => allFindings.filter(isEligible), [allFindings]);
  const worst = worstImpactBand(eligible);
  const count = worst ? eligible.filter((f) => f.impactBand === worst).length : 0;
  const clean = isCleanRun(appModel, allFindings);
  const failedJobs = summarizeRunOutcome(appModel.jobs, allFindings).failedJobs;

  return (
    <header className="sticky top-0 z-30 flex min-w-0 flex-wrap items-center gap-3 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
      {/* PlanGraphRoute supplies its own <h1> via sectionControls; Dashboard
          (the only caller with no sectionControls) has none of its own, so
          this is its one page heading. */}
      {sectionControls ? null : <h1 className="sr-only">SparkForensics</h1>}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {!sectionControls && !exportMode ? (
          <Button
            variant="ghost"
            size="icon"
            className="tap-target-comfortable shrink-0"
            aria-label="New analysis"
            title="Start a new analysis"
            onClick={onLoadNew}
          >
            <Home aria-hidden="true" />
          </Button>
        ) : null}
        {exportMode ? (
          <div className="flex min-w-0 shrink flex-col items-start justify-center gap-0 py-1">
            <span className="min-w-0 truncate font-heading text-sm font-semibold">{name}</span>
            {sub ? <span className="w-full min-w-0 truncate text-left text-xs text-muted-foreground">{sub}</span> : null}
          </div>
        ) : (
          <FileSwitcher
            activeName={name}
            activeSub={sub}
            activeId={activeFileId}
            entries={recentEntries}
            onPick={onPickRecent}
            onRemove={onRemoveRecent}
            onOpenNew={onLoadNew}
          />
        )}
        {skippedLines > 0 ? (
          <div className="min-w-0 truncate text-xs text-warning">
            {skippedLines} line{skippedLines === 1 ? '' : 's'} skipped: malformed or invalid data
          </div>
        ) : null}
        {leadingContent}
      </div>

      {sectionControls ? (
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-3 max-sm:order-3 max-sm:w-full max-sm:shrink max-sm:gap-2">
          {sectionControls}
        </div>
      ) : worst ? (
        onJumpToFindings ? (
          // A way in, not just a count: jumps to that band of the Findings list.
          <button
            type="button"
            aria-label={`${verdictLabel(worst, count)}: show them in Findings`}
            title="Show them in Findings"
            onClick={() => onJumpToFindings(worst)}
            className={cn(
              badgeVariants(),
              severityBadgeVariants({ impactBand: worst }),
              'tap-target-comfortable cursor-pointer font-mono hover:underline focus-visible:outline-none',
            )}
          >
            {verdictLabel(worst, count)}
          </button>
        ) : (
          <Chip label={verdictLabel(worst, count)} impactBand={worst} className="shrink-0" />
        )
      ) : failedJobs > 0 ? (
        <Chip label="Run failed" impactBand="critical" className="shrink-0" />
      ) : clean ? (
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-clean/10 px-2 py-0.5 text-xs font-medium text-clean',
          )}
        >
          <span aria-hidden="true" className="inline-block size-2 shrink-0 rounded-full bg-clean" />
          No findings
        </span>
      ) : (
        // Nothing to fix, but the verdict lists checks this log could not run.
        <span className="inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
          Not fully checked
        </span>
      )}

      <div className="flex shrink-0 items-center gap-1">
        {!sectionControls && comparison.baselineId && !comparison.active ? (
          <Button
            variant="ghost"
            size="sm"
            className="tap-target-comfortable"
            onClick={() => store.getState().setComparisonActive(true)}
          >
            ← Back to comparison
          </Button>
        ) : null}
        <div className="hidden items-center gap-1 sm:flex">
          {showCompare ? (
            <Button
              variant="ghost"
              size="sm"
              className="tap-target-comfortable"
              aria-label="Compare with another run"
              title="Compare with another run"
              onClick={onCompare}
            >
              <GitCompareArrows aria-hidden="true" />
              {/* Short below xl so the run name keeps its room in the bar. */}
              <span aria-hidden="true" className="xl:hidden">Compare</span>
              <span aria-hidden="true" className="hidden xl:inline">Compare with another run</span>
            </Button>
          ) : null}
          {!sectionControls ? <EvidenceExport /> : null}
          {!sectionControls && graphEntries.length > 0 ? (
            <Button variant="ghost" size="sm" className="tap-target-comfortable" onClick={handleOpenGraphView}>
              <Workflow aria-hidden="true" className="text-plan-aggregate" />
              Plan graph
            </Button>
          ) : null}
          {!sectionControls ? <WidgetDensityControl /> : null}
          <Button
            variant="ghost"
            size="icon"
            className="tap-target-comfortable"
            aria-label="Docs"
            title="Read the docs"
            nativeButton={false}
            render={<a href={DOCS_SITE_ROOT} target="_blank" rel="noopener noreferrer" />}
          >
            <FileText aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="tap-target-comfortable"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => setShortcutsOpen(true)}
          >
            <Keyboard aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="tap-target-comfortable"
            aria-label="Toggle theme"
            aria-pressed={theme === 'light'}
            title="Toggle theme"
            onClick={toggle}
          >
            {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </Button>
        </div>
        <DropdownMenu
          onOpenChange={(open, eventDetails) => {
            if (!open && eventDetails.reason === 'outside-press') {
              setTimeout(() => {
                if (document.activeElement === document.body) {
                  moreOptionsTriggerRef.current?.focus();
                }
              });
            }
          }}
        >
          <DropdownMenuTrigger
            ref={moreOptionsTriggerRef}
            className="tap-target-comfortable inline-flex size-8 items-center justify-center rounded-lg hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 sm:hidden"
            aria-label="More options"
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {showCompare ? (
              <DropdownMenuItem onClick={onCompare}>
                <GitCompareArrows aria-hidden="true" />
                Compare with another run
              </DropdownMenuItem>
            ) : null}
            {!sectionControls ? (
              <>
                <EvidenceExportMenuItems {...evidence} />
                <DropdownMenuSeparator />
              </>
            ) : null}
            {!sectionControls && graphEntries.length > 0 ? (
              <DropdownMenuItem onClick={handleOpenGraphView}>
                <Workflow aria-hidden="true" className="text-plan-aggregate" />
                Plan graph
              </DropdownMenuItem>
            ) : null}
            {!sectionControls ? <WidgetDensityMenuItem /> : null}
            <DropdownMenuItem
              nativeButton={false}
              render={<a href={DOCS_SITE_ROOT} target="_blank" rel="noopener noreferrer" />}
            >
              Docs
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShortcutsOpen(true)}>Keyboard shortcuts</DropdownMenuItem>
            <DropdownMenuItem onClick={toggle}>Toggle theme</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <GraphViewPickerDialog
        open={graphPickerOpen}
        entries={graphEntries}
        onSelect={handlePickGraphExecution}
        onOpenChange={setGraphPickerOpen}
      />
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </header>
  );
}
