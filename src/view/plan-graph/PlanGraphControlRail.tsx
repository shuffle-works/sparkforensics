import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useReactFlow, type Node } from '@xyflow/react';
import { ZoomIn, ZoomOut, Maximize2, Timer, Flag, Info, Map } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PlanGraphSettingsControl } from '@/view/plan-graph/PlanGraphSettingsControl';
import type { PlanGraphDurationMode, PlanGraphFilterMode } from '@sparkforensics/core/types.ts';

type FlowData = { durationSharePct: number | null };
const flowData = (n: Node) => n.data as unknown as FlowData;

export interface PlanGraphControlRailProps {
  /** Plan nodes, for the "Next worst duration" cycle. */
  planNodes: Node[];
  /** Stage boxes carrying findings, pre-sorted worst-first, for "Next problem". */
  problemNodes: Node[];
  filterMode: PlanGraphFilterMode;
  onFilterModeChange: (mode: PlanGraphFilterMode) => void;
  hiddenCount: number;
  durationMode: PlanGraphDurationMode;
  onDurationModeChange: (mode: PlanGraphDurationMode) => void;
  legendOpen: boolean;
  onToggleLegend: () => void;
  miniMapOpen: boolean;
  onToggleMiniMap: () => void;
}

/** One vertical toolbar down the left edge that gathers every global plan-graph
 * control that used to float in its own corner: zoom/fit (was React Flow's
 * Controls), the worst-duration/problem navigation (was a top-left panel), the
 * node-filter and duration settings (was a topbar popover), and the legend and
 * minimap toggles. Grouped View / Navigate / Display, so the canvas itself
 * carries only the graph, the minimap, and the docked detail inspector. */
export function PlanGraphControlRail({
  planNodes,
  problemNodes,
  filterMode,
  onFilterModeChange,
  hiddenCount,
  durationMode,
  onDurationModeChange,
  legendOpen,
  onToggleLegend,
  miniMapOpen,
  onToggleMiniMap,
}: PlanGraphControlRailProps) {
  const { zoomIn, zoomOut, fitView, setCenter } = useReactFlow();

  // Cycle state tracked by node id, not index, so it survives a filter/scope
  // change: if the last-visited node dropped out of the list, the next click
  // restarts from the top. (Moved verbatim from the old in-canvas FocusNav.)
  const [lastWorstDurationId, setLastWorstDurationId] = useState<string | null>(null);
  const [lastProblemId, setLastProblemId] = useState<string | null>(null);

  const worstDurationNodes = [...planNodes]
    .filter((n) => flowData(n).durationSharePct != null)
    .sort((a, b) => (flowData(b).durationSharePct ?? 0) - (flowData(a).durationSharePct ?? 0));

  const jumpTo = (node?: Node) => {
    if (!node) return;
    setCenter(node.position.x, node.position.y, { zoom: 1, duration: 300 });
  };

  const advance = (list: Node[], lastId: string | null, setLastId: (id: string) => void) => {
    if (list.length === 0) return;
    const lastIndex = lastId ? list.findIndex((n) => n.id === lastId) : -1;
    const next = list[(lastIndex + 1) % list.length];
    jumpTo(next);
    setLastId(next.id);
  };

  return (
    <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-card/60 py-2">
      <RailGroup>
        <RailButton label="Zoom in" onClick={() => zoomIn({ duration: 200 })}>
          <ZoomIn aria-hidden="true" />
        </RailButton>
        <RailButton label="Zoom out" onClick={() => zoomOut({ duration: 200 })}>
          <ZoomOut aria-hidden="true" />
        </RailButton>
        <RailButton label="Fit to view" onClick={() => fitView({ duration: 200 })}>
          <Maximize2 aria-hidden="true" />
        </RailButton>
      </RailGroup>

      <RailDivider />

      <RailGroup>
        <RailButton
          label="Next worst duration"
          disabled={worstDurationNodes.length === 0}
          onClick={() => advance(worstDurationNodes, lastWorstDurationId, setLastWorstDurationId)}
        >
          <Timer aria-hidden="true" />
        </RailButton>
        {problemNodes.length > 0 ? (
          <RailButton
            label="Next problem"
            onClick={() => advance(problemNodes, lastProblemId, setLastProblemId)}
          >
            <Flag aria-hidden="true" />
          </RailButton>
        ) : null}
      </RailGroup>

      <RailDivider />

      <RailGroup>
        <PlanGraphSettingsControl
          iconOnly
          filterMode={filterMode}
          onFilterModeChange={onFilterModeChange}
          hiddenCount={hiddenCount}
          durationMode={durationMode}
          onDurationModeChange={onDurationModeChange}
        />
        <RailButton label={legendOpen ? 'Hide legend' : 'Legend'} pressed={legendOpen} onClick={onToggleLegend}>
          <Info aria-hidden="true" />
        </RailButton>
        <RailButton
          label={miniMapOpen ? 'Hide minimap' : 'Show minimap'}
          pressed={miniMapOpen}
          onClick={onToggleMiniMap}
        >
          <Map aria-hidden="true" />
        </RailButton>
      </RailGroup>
    </div>
  );
}

function RailGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center gap-1">{children}</div>;
}

function RailDivider() {
  return <div aria-hidden="true" className="my-0.5 h-px w-6 bg-border" />;
}

function RailButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      // A toggle button in its "on" state gets a filled accent so its state
      // reads at a glance, distinct from the plain ghost hover. Momentary
      // buttons (zoom, fit) pass no `pressed`, so this never applies to them.
      className={cn(
        'tap-target-comfortable',
        pressed && 'bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary',
      )}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
