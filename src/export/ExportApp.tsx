import { Toaster } from '@/components/ui/sonner';
import { useStore } from '@/store/store';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { DocsProvider } from '@/view/DocsContext';
import { DocsSheet } from '@/view/DocsSheet';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { PlanGraphRoute } from '@/view/PlanGraphRoute';
import { usePlanGraphRouteProps } from '@/view/usePlanGraphRouteProps';
import { Dashboard } from '@/view/Dashboard';

/** Like App.tsx's PlanGraphRouteContainer but without the Suspense wrapper:
 * PlanGraphRoute is a plain top-level import here, not a `lazy()` chunk. */
function PlanGraphRouteContainer() {
  const props = usePlanGraphRouteProps();
  if (!props) return null;
  return <PlanGraphRoute key={props.stageId} {...props} />;
}

/** Trimmed App.tsx for the export bundle: status is always 'ready' (set once
 * by hydrateExportStore), so there's no idle/parsing/error/comparison
 * routing, no DropZone, no CompareLanding, no RunComparison: those chunks
 * are excluded from this build graph by construction (never imported here),
 * not by relying on dead-code elimination to drop an unused branch. */
export function ExportApp() {
  const planGraphActive = useStore((s) => s.planGraph.active);
  return (
    <ThemeProvider>
      <DocsProvider>
        <StageDetailProvider>
          {planGraphActive ? <PlanGraphRouteContainer /> : <Dashboard />}
          <DocsSheet />
          <Toaster />
        </StageDetailProvider>
      </DocsProvider>
    </ThemeProvider>
  );
}
