import { Suspense, useMemo, useState } from 'react';

import { Table, TableBody } from '@/components/ui/table';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import type { WidgetProps } from '@/view/detector-registry';
import type { TriageTarget } from '@/view/triage-target';
import {
  AlwaysVisibleAndCleanChecks,
  computeActiveWidgets,
  SUGGESTED_IMPROVEMENTS_ANCHOR_ID,
  type ActiveWidget,
} from '@/view/widgets/Alerts';
import {
  FindingRow,
  groupImpactBand,
  TypeGroupRow,
  useFixTheseFirstData,
} from '@/view/widgets/FixTheseFirst';
import { WidgetCardSkeleton } from '@/view/WidgetCard';
import { WidgetGrid, WidgetGridItem } from '@/view/WidgetGrid';
import type { RollupGroup } from '@sparkforensics/core/recommendation-rollup.ts';

export interface ImpactBoardProps extends WidgetProps {
  stages: AppModel['stages'];
  onRoute: (target: TriageTarget) => void;
}

const IMPACT_BAND_LABEL: Record<Finding['impactBand'], string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};
const IMPACT_BAND_ORDER_LIST: Finding['impactBand'][] = ['critical', 'warning', 'info'];

function groupKey(group: RollupGroup): string {
  return `${group.kind}-${group.type}-${'unit' in group ? group.unit : ''}`;
}

/** One impact band: its recommendation rows as a compact table, followed by
 * its active widget cards as a grid. Renders nothing (no heading) when the
 * band has neither row nor card. */
function ImpactGroup({
  impactBand,
  groups,
  widgets,
  allFindings,
  expandedGroupKey,
  onToggleGroup,
  onRoute,
  appModel,
  catalog,
  configFindings,
  getTaskData,
  activeFileId,
}: {
  impactBand: Finding['impactBand'];
  groups: RollupGroup[];
  widgets: ActiveWidget[];
  allFindings: Finding[];
  expandedGroupKey: string | null;
  onToggleGroup: (key: string) => void;
  onRoute: (target: TriageTarget) => void;
} & WidgetProps) {
  if (groups.length === 0 && widgets.length === 0) return null;
  const headingId = `impact-band-${impactBand}-heading`;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="font-heading text-base font-semibold">{IMPACT_BAND_LABEL[impactBand]}</h2>
      {groups.length > 0 && (
        <Table>
          <TableBody>
            {groups.map((group) => {
              if (group.findingCount === 1) {
                return <FindingRow key={group.findings[0].id} finding={group.findings[0]} allFindings={allFindings} onRoute={onRoute} />;
              }
              const key = groupKey(group);
              return (
                <TypeGroupRow
                  key={key}
                  group={group}
                  allFindings={allFindings}
                  expanded={expandedGroupKey === key}
                  onToggle={() => onToggleGroup(key)}
                  onRoute={onRoute}
                />
              );
            })}
          </TableBody>
        </Table>
      )}
      {widgets.length > 0 && (
        <WidgetGrid>
          {widgets.map(({ component: Widget, widgetId, index }) => (
            <WidgetGridItem key={widgetId} cardId={`alert-${index}`} widgetId={widgetId}>
              <Suspense fallback={<WidgetCardSkeleton />}>
                <Widget appModel={appModel} catalog={catalog} configFindings={configFindings} getTaskData={getTaskData} activeFileId={activeFileId} defaultCollapsed />
              </Suspense>
            </WidgetGridItem>
          ))}
        </WidgetGrid>
      )}
    </section>
  );
}

/** The Findings tab body: the recommendation table and the active widget grid,
 * merged and grouped by impact band (Critical → Warning → Info), followed by
 * the always-visible reference pair and the Clean checks disclosure. The
 * run-level verdict (where to start, and the clean-run message) sits above
 * the tabs in `RunVerdict`. */
export function ImpactBoard({ appModel, catalog, configFindings = [], stages, getTaskData, activeFileId, onRoute }: ImpactBoardProps) {
  // Recompute the rollup/active-widget ranking only when the underlying findings
  // (or stages) change, not on every `setExpandedGroupKey` re-render.
  const { groups } = useMemo(
    () => useFixTheseFirstData(catalog, configFindings, stages),
    [catalog, configFindings, stages],
  );
  const allFindings = [...catalog, ...configFindings];
  const activeWidgets = useMemo(() => computeActiveWidgets(catalog, configFindings), [catalog, configFindings]);
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);

  const { groupsByImpactBand, widgetsByImpactBand } = useMemo(() => {
    const groupsByImpactBand = new Map<Finding['impactBand'], RollupGroup[]>();
    for (const group of groups) {
      const impactBand = groupImpactBand(group);
      if (!groupsByImpactBand.has(impactBand)) groupsByImpactBand.set(impactBand, []);
      groupsByImpactBand.get(impactBand)!.push(group);
    }
    const widgetsByImpactBand = new Map<Finding['impactBand'], ActiveWidget[]>();
    for (const widget of activeWidgets) {
      if (!widgetsByImpactBand.has(widget.impactBand)) widgetsByImpactBand.set(widget.impactBand, []);
      widgetsByImpactBand.get(widget.impactBand)!.push(widget);
    }
    return { groupsByImpactBand, widgetsByImpactBand };
  }, [groups, activeWidgets]);

  return (
    <div id={SUGGESTED_IMPROVEMENTS_ANCHOR_ID} className="space-y-6 scroll-mt-20">
      {IMPACT_BAND_ORDER_LIST.map((impactBand) => (
        <ImpactGroup
          key={impactBand}
          impactBand={impactBand}
          groups={groupsByImpactBand.get(impactBand) ?? []}
          widgets={widgetsByImpactBand.get(impactBand) ?? []}
          allFindings={allFindings}
          expandedGroupKey={expandedGroupKey}
          onToggleGroup={(key) => setExpandedGroupKey((current) => (current === key ? null : key))}
          onRoute={onRoute}
          appModel={appModel}
          catalog={catalog}
          configFindings={configFindings}
          getTaskData={getTaskData}
          activeFileId={activeFileId}
        />
      ))}
      <AlwaysVisibleAndCleanChecks appModel={appModel} catalog={catalog} configFindings={configFindings} getTaskData={getTaskData} activeFileId={activeFileId} />
    </div>
  );
}
