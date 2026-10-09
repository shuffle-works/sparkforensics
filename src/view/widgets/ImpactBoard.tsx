import { Suspense, useMemo, useState } from 'react';

import { Table, TableBody } from '@/components/ui/table';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import type { WidgetProps } from '@/view/detector-registry';
import { useInterpretation, type BoardGroup } from '@/view/interpretation';
import { triageTargetFor, type TriageTarget } from '@/view/triage-target';
import {
  CleanChecks,
  computeActiveWidgets,
  SUGGESTED_IMPROVEMENTS_ANCHOR_ID,
  type ActiveWidget,
} from '@/view/widgets/Alerts';
import {
  FindingRow,
  TypeGroupRow,
  useFixTheseFirstData,
  type RowEvidence,
} from '@/view/widgets/FixTheseFirst';
import { WidgetCardSkeleton } from '@/view/WidgetCard';
import { WidgetGrid, WidgetGridItem } from '@/view/WidgetGrid';

export interface ImpactBoardProps extends WidgetProps {
  stages: AppModel['stages'];
  onRoute: (target: TriageTarget) => void;
  /** The findings the verdict's steps lead with: the verdict lists them, so the board starts after them. */
  verdictLeads?: ReadonlySet<Finding>;
  /** Widgets whose evidence card the verdict shows in place; a board row on one routes to it. */
  verdictWidgetIds?: ReadonlySet<string>;
}

const IMPACT_BAND_LABEL: Record<Finding['impactBand'], string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};
const IMPACT_BAND_ORDER_LIST: Finding['impactBand'][] = ['critical', 'warning', 'info'];

/** One impact band: its recommendation rows as a compact table. Each row owns
 * at most one "Show evidence" control. The first row of a widget's type in the
 * band expands that widget's card in place; a later row of the same type, or
 * a type whose card the verdict shows, routes to the card that holds it.
 * Evidence cards no row owns stay in a grid under the table, collapsed.
 * Renders nothing (no heading) when the band has neither row nor card. */
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
  subheading,
}: {
  impactBand: Finding['impactBand'];
  groups: BoardGroup[];
  widgets: ActiveWidget[];
  allFindings: Finding[];
  expandedGroupKey: string | null;
  onToggleGroup: (key: string) => void;
  onRoute: (target: TriageTarget) => void;
  /** Whether the band heading is a sub-heading of "More findings". */
  subheading: boolean;
} & WidgetProps) {
  const widgetProps: WidgetProps = { appModel, catalog, configFindings, getTaskData, activeFileId };
  const { evidenceByGroup, unowned } = useMemo(() => {
    const byWidget = new Map(widgets.map((widget) => [widget.widgetId, widget]));
    const taken = new Set<string>();
    const evidenceByGroup = new Map<string, ActiveWidget>();
    for (const group of groups) {
      const widgetId = triageTargetFor(group.findings[0])?.widgetId;
      const widget = widgetId ? byWidget.get(widgetId) : undefined;
      if (!widget || taken.has(widget.widgetId)) continue;
      taken.add(widget.widgetId);
      evidenceByGroup.set(group.key, widget);
    }
    return { evidenceByGroup, unowned: widgets.filter((widget) => !taken.has(widget.widgetId)) };
  }, [groups, widgets]);

  if (groups.length === 0 && widgets.length === 0) return null;
  const headingId = `impact-band-${impactBand}-heading`;
  const Heading = subheading ? 'h3' : 'h2';
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      {/* tabIndex -1: the top bar's count chip focuses the band it names. */}
      {/* Mono uppercase group label (Trace): the band reads from the tags below it. */}
      <Heading id={headingId} tabIndex={-1} className="trace-eyebrow scroll-mt-20 rounded-sm px-1 pt-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {IMPACT_BAND_LABEL[impactBand]}
      </Heading>
      {groups.length > 0 && (
        <Table className="findings-table">
          <TableBody>
            {groups.map((group) => {
              const evidence: RowEvidence = { widget: evidenceByGroup.get(group.key) ?? null, widgetProps };
              if (group.findings.length === 1) {
                return <FindingRow key={group.findings[0].id} finding={group.findings[0]} allFindings={allFindings} onRoute={onRoute} evidence={evidence} />;
              }
              const { key } = group;
              return (
                <TypeGroupRow
                  key={key}
                  group={group}
                  allFindings={allFindings}
                  expanded={expandedGroupKey === key}
                  onToggle={() => onToggleGroup(key)}
                  onRoute={onRoute}
                  evidence={evidence}
                />
              );
            })}
          </TableBody>
        </Table>
      )}
      {unowned.length > 0 && (
        <WidgetGrid>
          {unowned.map(({ component: Widget, widgetId, index }) => (
            <WidgetGridItem key={widgetId} cardId={`alert-${index}`} widgetId={widgetId}>
              <Suspense fallback={<WidgetCardSkeleton />}>
                <Widget {...widgetProps} defaultCollapsed />
              </Suspense>
            </WidgetGridItem>
          ))}
        </WidgetGrid>
      )}
    </section>
  );
}

/** The Findings tab body: "More findings", the findings the verdict's steps do
 * not lead with, grouped by impact band (Critical → Warning → Info) with their
 * evidence expandable in place, followed by the Clean checks disclosure. The
 * run-level verdict (where to start, and the clean-run message) sits above
 * the tabs in `RunVerdict`. */
export function ImpactBoard({
  appModel,
  catalog,
  configFindings = [],
  stages,
  getTaskData,
  activeFileId,
  onRoute,
  verdictLeads,
  verdictWidgetIds,
}: ImpactBoardProps) {
  // Recompute the rollup/active-widget ranking only when the underlying findings
  // (or stages) change, not on every `setExpandedGroupKey` re-render.
  const interpretation = useInterpretation();
  const { groups, eligible } = useMemo(() => {
    const rest = (findings: Finding[]) => (verdictLeads ? findings.filter((finding) => !verdictLeads.has(finding)) : findings);
    return useFixTheseFirstData(rest(catalog), rest(configFindings), stages, interpretation);
  }, [catalog, configFindings, stages, interpretation, verdictLeads]);
  const allFindings = [...catalog, ...configFindings];
  const detectors = interpretation?.data.detectors;
  const activeWidgets = useMemo(
    () => (detectors
      ? computeActiveWidgets(catalog, configFindings, detectors).filter((widget) => !verdictWidgetIds?.has(widget.widgetId))
      : []),
    [catalog, configFindings, detectors, verdictWidgetIds],
  );
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);

  const { groupsByImpactBand, widgetsByImpactBand } = useMemo(() => {
    const groupsByImpactBand = new Map<Finding['impactBand'], BoardGroup[]>();
    for (const group of groups) {
      const impactBand = group.band;
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

  // With the verdict's steps taken out, "More findings" is what is left; a
  // board with nothing left says so instead of showing an empty list.
  const hasVerdictLeads = (verdictLeads?.size ?? 0) > 0;
  const nothingLeft = eligible.length === 0;
  return (
    <div id={SUGGESTED_IMPROVEMENTS_ANCHOR_ID} className="space-y-6 scroll-mt-20">
      {hasVerdictLeads ? (
        nothingLeft ? (
          <p data-testid="no-more-findings" className="text-sm text-muted-foreground">No more findings to show.</p>
        ) : (
          <h2 data-testid="more-findings-heading" className="font-heading text-base font-semibold">
            More findings <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">({eligible.length})</span>
          </h2>
        )
      ) : null}
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
          subheading={hasVerdictLeads}
        />
      ))}
      {interpretation ? <CleanChecks catalog={catalog} configFindings={configFindings} coverage={interpretation.data.coverage} detectors={interpretation.data.detectors} /> : null}
    </div>
  );
}
