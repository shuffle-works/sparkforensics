import { useStore } from '@/store/store';
import type { PlanGraphRouteProps } from '@/view/PlanGraphRoute';

/** Shared store-selector logic for App.tsx's and ExportApp.tsx's
 * PlanGraphRouteContainer; returns null when there's no stage to route to.
 *
 * Standalone file, not part of PlanGraphRoute.tsx, on purpose: that module
 * pulls in @xyflow/react + dagre and App.tsx only loads it via `lazy()`.
 * Importing only the `PlanGraphRouteProps` type from there (erased at build
 * time) lets App.tsx share this selector without dragging the graph code back
 * into its initial chunk. */
export function usePlanGraphRouteProps(): PlanGraphRouteProps | null {
  const stageId = useStore((s) => s.planGraph.stageId);
  const initialScope = useStore((s) => s.planGraph.initialScope);
  const appModel = useStore((s) => s.appModel);
  const catalog = useStore((s) => s.catalog);
  const activeFileId = useStore((s) => s.activeFileId);
  const closePlanGraph = useStore((s) => s.closePlanGraph);

  if (stageId == null) return null;
  return { stageId, initialScope, appModel, findings: catalog, activeFileId, onClose: closePlanGraph };
}
