import { useLayoutEffect, useMemo, type ReactNode } from 'react';

import type { Finding } from '@sparkforensics/core/types';
import { Table, TableBody } from '@/components/ui/table';
import { selectAppModel, selectCatalog, selectConfigFindings, store, useStore, useWidgetDensity } from '@/store/store';
import { useIngest } from '@/store/useIngest';
import { buildBoardLayout, evidencePanelOf, rowEvidence } from '@/view/board-layout';
import { emptySelection } from '@/view/finding-filter';
import { IMPACT_BANDS } from '@sparkforensics/core/view-model';
import { StepCodesShownContext } from '@/view/StepCode';
import { InlineEvidence } from '@/view/InlineEvidence';
import { evidencePlacement } from '@/view/evidence-placement';
import { useInterpretation } from '@/view/interpretation';
import { computeActiveWidgets } from '@/view/widgets/Alerts';
import { FindingRow } from '@/view/widgets/FixTheseFirst';
import { NextStepItem } from '@/view/widgets/RunVerdict';

const NOTHING_STATED: readonly Finding[] = [];

/** One finding of the loaded run, drawn the way the dashboard draws it: as a verdict step when the
 * run's verdict leads with it, else as a Findings row, with its evidence panel open. */
export function FindingExample({ findingId }: { findingId: string }) {
  const appModel = useStore(selectAppModel);
  const catalog = useStore(selectCatalog);
  const configFindings = useStore(selectConfigFindings);
  const interpretation = useInterpretation();
  const density = useWidgetDensity();
  const { getTaskData } = useIngest();

  const findings = useMemo(() => [...catalog, ...configFindings], [catalog, configFindings]);
  const finding = findings.find((candidate) => candidate.id === findingId);
  const widgets = useMemo(
    () => (interpretation ? computeActiveWidgets(catalog, configFindings, interpretation.data.detectors, appModel, density) : []),
    [catalog, configFindings, interpretation, appModel, density],
  );
  const widget = useMemo(
    () => (finding ? widgets.find((candidate) => candidate.type === finding.type) : undefined),
    [finding, widgets],
  );
  const layout = useMemo(
    () => buildBoardLayout({ interpretation, appModel, catalog, configFindings, selection: { ...emptySelection(), impactBands: new Set(IMPACT_BANDS) }, density }),
    [interpretation, appModel, catalog, configFindings, density],
  );
  const placement = finding && interpretation ? evidencePlacement(interpretation, finding, new Set(widgets.map((candidate) => candidate.widgetId))) : null;
  const step = placement?.kind === 'step' ? layout.steps[placement.index] : undefined;
  const scope = useMemo(() => (finding ? [finding] : []), [finding]);
  // A step or row states its finding, so its panel shows what the line leaves out, or nothing. A
  // finding shown by its card alone states nothing.
  const row = useMemo(
    () => (finding ? { kind: 'finding' as const, lineKey: `row:${finding.id}`, finding, evidence: rowEvidence(widget ?? null, scope, scope, { interpretation, appModel, catalog, configFindings, selection: emptySelection(), density }, layout.keyOf) } : null),
    [finding, widget, scope, interpretation, appModel, catalog, configFindings, density, layout.keyOf],
  );
  const cardPanel = useMemo(() => evidencePanelOf(widget, appModel, scope, NOTHING_STATED, density, interpretation), [widget, appModel, scope, density, interpretation]);
  const cardKey = widget && cardPanel && finding ? `alert-${widget.index}-${layout.keyOf(finding)}` : null;

  // This host shows the panel open: the board's disclosure state is where open is decided.
  const openKey = step?.evidence?.kind === 'panel' ? step.evidence.cardKey : placement?.kind === 'row' ? row?.evidence.cardKey : cardKey;
  useLayoutEffect(() => {
    if (openKey) store.getState().setCardOpen(openKey, true);
  }, [openKey]);

  if (!finding || !interpretation || !placement) return <p role="alert">This run has no finding {findingId}.</p>;

  const widgetProps = { appModel, catalog, configFindings, getTaskData };

  let body: ReactNode;
  if (placement.kind === 'step' && step) {
    body = (
      <section className="rounded-xl border border-border bg-card px-4 pb-1 sm:px-5">
        <ol aria-label="Next step" className="verdict-steps" style={{ marginTop: 0, borderTop: 0 }}>
          <NextStepItem
            layout={step}
            interpretation={interpretation}
            renderEvidence={(evidence) => <InlineEvidence widget={evidence.widget} widgetProps={widgetProps} stated={scope} panel={evidence.panel} cardKey={evidence.cardKey} />}
          />
        </ol>
      </section>
    );
  } else if (placement.kind === 'row' && row) {
    body = (
      <Table className="findings-table">
        <TableBody>
          <FindingRow row={row} widgetProps={widgetProps} />
        </TableBody>
      </Table>
    );
  } else if (placement.kind === 'card') {
    body = widget && cardPanel && cardKey ? <InlineEvidence widget={widget} widgetProps={widgetProps} panel={cardPanel} cardKey={cardKey} /> : null;
  } else {
    body = null;
  }

  return <StepCodesShownContext.Provider value={false}>{body}</StepCodesShownContext.Provider>;
}
