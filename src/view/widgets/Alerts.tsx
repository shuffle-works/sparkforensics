import type { ComponentType } from 'react';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { Table, TableBody } from '@/components/ui/table';
import { checkCoverage, hasFinishedStage, verdictGaps } from '@sparkforensics/core/check-coverage.ts';
import { IMPACT_BAND_ORDER, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { isRealFinding } from '@sparkforensics/core/recommendation-rollup.ts';
import { getThresholdSummary } from '@sparkforensics/core/threshold-summary.ts';
import type { WidgetProps } from '@/view/detector-registry';
import { isAlwaysMountedType, orderedWidgets, REGISTRY } from '@/view/detector-registry';
import type { Finding } from '@sparkforensics/core/types.ts';
import { CleanCheckRow } from '@/view/widgets/CleanCheckRow';

export const SUGGESTED_IMPROVEMENTS_ANCHOR_ID = 'suggested-improvements';

/** Detector-scope taxonomy for grouping the "Clean checks" disclosure. Every
 * `REGISTRY` type must appear here exactly once; a new detector type needs a
 * matching entry. */
type CleanCheckScope = 'per-stage' | 'app-level' | 'sql-scope' | 'config-scope';

const SCOPE: Record<string, CleanCheckScope> = {
  skew: 'per-stage',
  stageShape: 'per-stage',
  tinyTask: 'per-stage',
  shuffle: 'per-stage',
  partitionSizing: 'per-stage',
  spill: 'per-stage',
  gc: 'per-stage',
  stageFailed: 'per-stage',
  failures: 'per-stage',
  retryWaste: 'per-stage',
  slowHost: 'per-stage',
  stageSlowness: 'per-stage',
  straggler: 'per-stage',
  speculationWaste: 'per-stage',

  incompleteRun: 'app-level',
  coldStart: 'app-level',
  memoryUtilization: 'app-level',
  utilization: 'app-level',
  coreLocality: 'app-level',
  cachingOpportunity: 'app-level',
  cacheUtilization: 'app-level',
  jobFailureRate: 'app-level',
  autoscalingChurn: 'app-level',

  duplicatePlanSubtree: 'sql-scope',
  smallFiles: 'sql-scope',
  underBroadcast: 'sql-scope',
  overBroadcast: 'sql-scope',

  configAudit: 'config-scope',
};

const SCOPE_ORDER: CleanCheckScope[] = ['per-stage', 'app-level', 'sql-scope', 'config-scope'];

const SCOPE_LABEL: Record<CleanCheckScope, string> = {
  'per-stage': 'Per-stage checks',
  'app-level': 'App-level checks',
  'sql-scope': 'SQL plan checks',
  'config-scope': 'Config checks',
};

/**
 * "Suggested Improvements" has two tiers. An active grid: every `REGISTRY`
 * widget component except the always-mounted one, ranked by worst
 * impact band, shown when at least one of its types has a finding in
 * `catalog` ∪ `configFindings`. A collapsed "Clean checks" disclosure: every
 * remaining `REGISTRY` type (not component) with zero findings gets its own
 * `CleanCheckRow`. The always-mounted reference widget (Core Usage by
 * Locality) lives in the Full app report tab instead, so it never collapses
 * to a clean-check line either. `configFindings` is a separate
 * stream from `catalog`, so the impact-band ranking must look at both.
 */
export interface ActiveWidget {
  component: ComponentType<WidgetProps>;
  widgetId: string;
  index: number;
  findings: Finding[];
  impactBand: Finding['impactBand'];
}

/** Every `REGISTRY` component except the always-mounted one(s), ranked by
 * worst impact band then widget order, for any component with at least one
 * finding in `catalog` ∪ `configFindings`. */
export function computeActiveWidgets(catalog: Finding[], configFindings: Finding[]): ActiveWidget[] {
  // isRealFinding: a mere evidence-unavailable caveat (e.g. memoryUtilization's
  // dataUnavailable variant) isn't grounds for an active widget card of its own.
  const combined = [...catalog, ...configFindings].filter(isRealFinding);

  const componentWidgets = orderedWidgets()
    .filter(({ type }) => !isAlwaysMountedType(type))
    .map(({ component, widgetId, type }, index) => {
      const findings = combined.filter((finding) => finding.type === type);
      return { component, widgetId, index, findings, impactBand: worstImpactBand(findings) };
    });

  return componentWidgets
    .filter((widget): widget is ActiveWidget => widget.impactBand !== undefined)
    .sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand] || a.index - b.index);
}

/** The collapsed "Clean checks" disclosure: the part of Suggested
 * Improvements that isn't the impact-band-ranked active grid. */
export function CleanChecks({ appModel, catalog, configFindings = [] }: Pick<WidgetProps, 'appModel' | 'catalog' | 'configFindings'>) {
  // isRealFinding: a mere evidence-unavailable caveat (e.g. memoryUtilization's
  // dataUnavailable variant) doesn't keep a type out of the Clean-checks list.
  const combined = [...catalog, ...configFindings].filter(isRealFinding);

  // A check the log could not run is not a pass: the same rule the verdict
  // and the CLI/MCP report use to withhold "clean" (an evidence caveat, a
  // per-stage check on a log where no stage finished, or a run-span check on
  // a log with no ApplicationEnd).
  const noFinishedStages = !hasFinishedStage(appModel.stages);
  const { isNotRun } = checkCoverage(appModel.stages, [...catalog, ...configFindings]);

  const zeroFindingTypes = Object.keys(REGISTRY)
    .filter((type) => !isAlwaysMountedType(type))
    .filter((type) => !combined.some((finding) => finding.type === type))
    .map((type) => ({ type, findingLabel: REGISTRY[type].findingLabel }));
  const cleanWidgets = zeroFindingTypes.filter(({ type }) => !isNotRun(type));
  const notRunWidgets = zeroFindingTypes.filter(({ type }) => isNotRun(type));
  // Why each check could not run, each line naming what to turn on next time.
  const notRunReasons = notRunWidgets.length > 0 ? verdictGaps([...catalog, ...configFindings], noFinishedStages) : [];

  // Grouped by detector scope so a clean run's 20+ rows read as four short
  // labeled lists instead of one flat wall; `SCOPE_ORDER` fixes the order and
  // skips empty scopes. Falls back to 'app-level' for a type with no `SCOPE`
  // entry (only test-double types) so an unmapped type still renders.
  const cleanWidgetsByScope = new Map<CleanCheckScope, typeof cleanWidgets>();
  for (const widget of cleanWidgets) {
    const scope = SCOPE[widget.type] ?? 'app-level';
    if (!cleanWidgetsByScope.has(scope)) cleanWidgetsByScope.set(scope, []);
    cleanWidgetsByScope.get(scope)!.push(widget);
  }

  return (
    <Accordion>
      <AccordionItem value="clean-checks">
        <AccordionTrigger>Clean checks</AccordionTrigger>
        <AccordionContent>
          {notRunWidgets.length > 0 ? (
            <div data-testid="clean-checks-not-run" className="pb-4">
              <p className="pb-1 text-xs font-medium text-muted-foreground">Not checked on this log</p>
              <p className="pb-2 text-xs text-muted-foreground">
                The log lacked the data these checks need, so they neither passed nor failed.
              </p>
              {notRunReasons.length > 0 ? (
                <ul data-testid="clean-checks-not-run-reasons" className="list-disc space-y-0.5 pb-2 pl-5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {notRunReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
              <Table>
                <TableBody>
                  {notRunWidgets.map(({ type, findingLabel }) => (
                    <CleanCheckRow key={type} type={type} label={findingLabel} thresholdSummary={getThresholdSummary(type)} status="notRun" />
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
          <p className="pb-2 text-xs text-muted-foreground">
            {cleanWidgets.length === 0 ? 'No check could run on this log.' : 'Every check below passed. No fix needed.'}
            <AdvancedOnly> Each line's caption states the threshold it was measured against.</AdvancedOnly>
          </p>
          {SCOPE_ORDER.map((scope) => {
            const widgets = cleanWidgetsByScope.get(scope);
            if (!widgets || widgets.length === 0) return null;
            return (
              <div key={scope} className="pt-3 first:pt-0">
                <p className="pb-1 text-xs font-medium text-muted-foreground">{SCOPE_LABEL[scope]}</p>
                <Table>
                  <TableBody>
                    {widgets.map(({ type, findingLabel }) => (
                      <CleanCheckRow key={type} type={type} label={findingLabel} thresholdSummary={getThresholdSummary(type)} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            );
          })}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
