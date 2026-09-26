import { lazy, Suspense, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Toaster } from '@/components/ui/sonner';
import { useStore } from '@/store/store';
import { useIngest } from '@/store/useIngest';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import { compareRuns } from '@sparkforensics/core/run-comparison.ts';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { CompareLanding } from '@/view/CompareLanding';
import { DocsProvider } from '@/view/DocsContext';
import { DocsSheet } from '@/view/DocsSheet';
import { RunComparison } from '@/view/RunComparison';
import { summarizeRunOutcome } from '@/view/run-outcome';
import { isIncompleteRun } from '@/view/run-verdict';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { usePlanGraphRouteProps } from '@/view/usePlanGraphRouteProps';

const PlanGraphRoute = lazy(() =>
  import('./view/PlanGraphRoute').then(({ PlanGraphRoute }) => ({ default: PlanGraphRoute })),
);

const DashboardRoute = lazy(() =>
  import('./view/Dashboard').then(({ Dashboard }) => ({ default: Dashboard })),
);

/** Resolves the two selected snapshots and renders the comparison. Closes the
 * comparison if either snapshot is gone. */
function RunComparisonRoute() {
  const comparison = useStore((s) => s.comparison);
  const close = useStore((s) => s.closeComparison);
  const { prepareComparison, drillIntoRun } = useIngest();
  // Memoize on the two run ids: compareRuns walks stage/plan trees and diffs
  // findings, wasted on unrelated re-renders. Resolve and compare are both pure
  // (the active run was snapshotted at openComparison time), so a plain memo is safe.
  const model = useMemo(() => {
    const prepared =
      comparison.baselineId && comparison.candidateId
        ? prepareComparison(comparison.baselineId, comparison.candidateId)
        : null;
    if (!prepared) return null;
    // Failed jobs come from each run's own job results, as its run verdict
    // counts them; an incomplete log's time covers only what it captured.
    const outcome = (snap: typeof prepared.baseline.snapshot) => ({
      ...summarizeRunOutcome(snap.jobs, snap.catalog),
      incomplete: isIncompleteRun(snap.catalog),
    });
    return {
      ...compareRuns(prepared.baseline, prepared.candidate),
      jobOutcomes: { baseline: outcome(prepared.baseline.snapshot), candidate: outcome(prepared.candidate.snapshot) },
    };
  }, [comparison.baselineId, comparison.candidateId, prepareComparison]);
  // A missing snapshot means the comparison can't be shown; close it from an
  // effect (never mutate the store during render).
  const missing = !model;
  useEffect(() => {
    if (missing) close();
  }, [missing, close]);
  if (!model) {
    return null;
  }
  return (
    <RunComparison
      model={model}
      onClose={close}
      onDrillIn={(which) => {
        const id = which === 'baseline' ? comparison.baselineId : comparison.candidateId;
        if (id) drillIntoRun(id);
      }}
    />
  );
}

/** Resolves the active stage/appModel/findings for the plan graph route.
 * Renders nothing if `planGraph.stageId` is unset (e.g. a stale render during close). */
function PlanGraphRouteContainer() {
  const props = usePlanGraphRouteProps();
  if (!props) return null;
  return (
    <Suspense
      fallback={
        <p role="status" aria-live="polite" aria-label="Loading plan graph" className="p-6 text-sm text-muted-foreground">
          Loading plan graph…
        </p>
      }
    >
      {/* Remount on every distinct anchor stage so a stale requestedScope/
          focusStageId from the previous visit never leaks into the new one. */}
      <PlanGraphRoute key={props.stageId} {...props} />
    </Suspense>
  );
}

/** The local-parse screen: what is happening, how far along, roughly how long
 * is left, a reminder that nothing is uploaded, and (single-run loads only) a
 * way out. A large log can take a while, and a bare percentage gave a
 * first-time visitor no reason to wait or way to stop. */
function ParseProgress({ label, onCancel }: { label: string; onCancel?: () => void }) {
  const parse = useStore((s) => s.parse);
  const pctRounded = Math.round(parse.pct * 100);
  const lineStr = parse.lines > 0 ? ` · ${parse.lines.toLocaleString()} lines` : '';
  const eta = parse.etaMs != null && parse.etaMs > 0 ? `About ${formatDuration(parse.etaMs)} left. ` : '';
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-10">
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
        <p className="font-heading text-lg font-semibold">Reading the event log</p>
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {label}… {pctRounded}%{lineStr}
        </p>
        <Progress value={parse.pct * 100} className="w-full" />
        <p className="text-xs text-muted-foreground">
          {eta}Parsing runs in your browser, so the log stays on this machine.
        </p>
        {onCancel ? (
          <Button variant="ghost" size="sm" className="tap-target-comfortable" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </main>
  );
}

/** Routes on store `status`: idle/error show the drop zone (with the error,
 * if any); local parsing shows page progress, while an SHS parse retains the
 * intake so its form can show progress or recover in place. */
function AppRoutes() {
  const status = useStore((s) => s.status);
  const errorMessage = useStore((s) => s.errorMessage);
  const errorNonce = useStore((s) => s.errorNonce);
  const shsParsing = useStore((s) => s.shsParsing);
  const { cancelParse } = useIngest();
  const planGraphActive = useStore((s) => s.planGraph.active);
  const comparisonActive = useStore((s) => s.comparison.active);
  const compareLoad = useStore((s) => s.compareLoad);

  if (compareLoad) {
    return <ParseProgress label={`Parsing run ${compareLoad.current} of 2`} />;
  }

  if (planGraphActive) return <PlanGraphRouteContainer />;
  if (comparisonActive) return <RunComparisonRoute />;

  if (status === 'ready') {
    return (
      <Suspense
        fallback={
          <p role="status" aria-live="polite" aria-label="Loading dashboard" className="p-6 text-sm text-muted-foreground">
            Loading dashboard…
          </p>
        }
      >
        <DashboardRoute />
      </Suspense>
    );
  }

  if (status === 'parsing' && !shsParsing) {
    return <ParseProgress label="Parsing" onCancel={cancelParse} />;
  }

  return (
    <main className="min-h-screen p-6 sm:p-10">
      <CompareLanding errorMessage={status === 'error' ? errorMessage : null} errorNonce={errorNonce} />
    </main>
  );
}

export default function App() {
  // Dashboard, RunComparison, and PlanGraphRoute each supply their own <h1>/
  // <header> landmark; only the pre-load states have none, so the sr-only app
  // title renders (in its own <header>) just there to avoid a duplicate landmark.
  const status = useStore((s) => s.status);
  const planGraphActive = useStore((s) => s.planGraph.active);
  const comparisonActive = useStore((s) => s.comparison.active);
  const hasOwnHeading = status === 'ready' || planGraphActive || comparisonActive;

  return (
    <ThemeProvider>
      <DocsProvider>
        <StageDetailProvider>
          {hasOwnHeading ? null : (
            <header>
              <h1 className="sr-only">SparkForensics</h1>
            </header>
          )}
          <AppRoutes />
          <DocsSheet />
          <Toaster />
        </StageDetailProvider>
      </DocsProvider>
    </ThemeProvider>
  );
}
