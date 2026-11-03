import { useMemo, type ReactNode } from 'react';

import type { Finding } from '@sparkforensics/core/types';
import { Table, TableBody } from '@/components/ui/table';
import { useStore, useWidgetDensity } from '@/store/store';
import { useIngest } from '@/store/useIngest';
import { EvidenceInitiallyOpenContext } from '@/view/InlineEvidenceContext';
import { StepCodesShownContext } from '@/view/StepCode';
import { InlineEvidence, useEvidencePanel } from '@/view/InlineEvidence';
import { evidencePlacement } from '@/view/evidence-placement';
import { useInterpretation } from '@/view/interpretation';
import { computeActiveWidgets } from '@/view/widgets/Alerts';
import { FindingRow } from '@/view/widgets/FixTheseFirst';
import { NextStepItem, type StepEvidence } from '@/view/widgets/RunVerdict';

const NO_ROUTE = () => {};
const NOTHING_STATED: readonly Finding[] = [];

/** One finding of the loaded run, drawn the way the dashboard draws it: as a verdict step when the
 * run's verdict leads with it, else as a Findings row, with its evidence panel open. */
export function FindingExample({ findingId }: { findingId: string }) {
  const appModel = useStore((s) => s.appModel);
  const catalog = useStore((s) => s.catalog);
  const configFindings = useStore((s) => s.configFindings);
  const activeFileId = useStore((s) => s.activeFileId);
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

  const scope = useMemo(() => (finding ? [finding] : []), [finding]);
  // A step or row states its finding, so its panel shows what the line leaves out, or nothing. A
  // finding shown by its card alone states nothing.
  const panel = useEvidencePanel(widget, appModel, scope, scope);
  const cardPanel = useEvidencePanel(widget, appModel, scope, NOTHING_STATED);

  if (!finding || !interpretation) return <p role="alert">This run has no finding {findingId}.</p>;

  const widgetProps = { appModel, catalog, configFindings, getTaskData, activeFileId };
  const placement = evidencePlacement(interpretation, finding, new Set(widgets.map((candidate) => candidate.widgetId)));

  let body: ReactNode;
  if (placement.kind === 'step') {
    let evidence: StepEvidence | null = null;
    if (widget) {
      evidence = panel
        ? { kind: 'panel', widgetId: widget.widgetId, panel, card: <InlineEvidence widget={widget} widgetProps={widgetProps} stated={scope} panel={panel} /> }
        : { kind: 'bare', widgetId: widget.widgetId };
    }
    body = (
      <section className="rounded-xl border border-border bg-card px-4 pb-1 sm:px-5">
        <ol aria-label="Next step" className="verdict-steps" style={{ marginTop: 0, borderTop: 0 }}>
          <NextStepItem
            step={interpretation.data.verdict.steps[placement.index]}
            finding={finding}
            interpretation={interpretation}
            index={placement.index}
            evidence={evidence}
          />
        </ol>
      </section>
    );
  } else if (placement.kind === 'row') {
    body = (
      <Table className="findings-table">
        <TableBody>
          <FindingRow finding={finding} allFindings={findings} onRoute={NO_ROUTE} evidence={{ widget: widget ?? null, widgetProps }} />
        </TableBody>
      </Table>
    );
  } else if (placement.kind === 'card') {
    body = widget && cardPanel ? <InlineEvidence widget={widget} widgetProps={widgetProps} panel={cardPanel} /> : null;
  } else {
    body = null;
  }

  return (
    <StepCodesShownContext.Provider value={false}>
      <EvidenceInitiallyOpenContext.Provider value>
        {body}
      </EvidenceInitiallyOpenContext.Provider>
    </StepCodesShownContext.Provider>
  );
}
