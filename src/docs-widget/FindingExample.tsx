import { useMemo, type ReactNode } from 'react';

import { Table, TableBody } from '@/components/ui/table';
import { useStore } from '@/store/store';
import { useIngest } from '@/store/useIngest';
import { EvidenceInitiallyOpenContext } from '@/view/InlineEvidenceContext';
import { StepCodesShownContext } from '@/view/StepCode';
import { InlineEvidence } from '@/view/InlineEvidence';
import { eligibleFindings, findingAt, useInterpretation } from '@/view/interpretation';
import { computeActiveWidgets } from '@/view/widgets/Alerts';
import { FindingRow } from '@/view/widgets/FixTheseFirst';
import { NextStepItem } from '@/view/widgets/RunVerdict';

const NO_ROUTE = () => {};

/** One finding of the loaded run, drawn the way the dashboard draws it: as a verdict step when the
 * run's verdict leads with it, else as a Findings row, with its evidence panel open. */
export function FindingExample({ findingId }: { findingId: string }) {
  const appModel = useStore((s) => s.appModel);
  const catalog = useStore((s) => s.catalog);
  const configFindings = useStore((s) => s.configFindings);
  const activeFileId = useStore((s) => s.activeFileId);
  const interpretation = useInterpretation();
  const { getTaskData } = useIngest();

  const findings = useMemo(() => [...catalog, ...configFindings], [catalog, configFindings]);
  const finding = findings.find((candidate) => candidate.id === findingId);
  const widget = useMemo(() => (
    finding && interpretation
      ? computeActiveWidgets(catalog, configFindings, interpretation.data.detectors).find((w) => w.findings.includes(finding))
      : undefined
  ), [finding, interpretation, catalog, configFindings]);

  if (!finding || !interpretation) return <p role="alert">This run has no finding {findingId}.</p>;

  const widgetProps = { appModel, catalog, configFindings, getTaskData, activeFileId };
  const stepIndex = interpretation.data.verdict.steps.findIndex((step) => findingAt(interpretation, step.leadIndex) === finding);
  const isRow = eligibleFindings(interpretation).includes(finding);

  let body: ReactNode;
  if (stepIndex >= 0) {
    const evidence = widget
      ? { widgetId: widget.widgetId, card: <InlineEvidence widget={widget} widgetProps={widgetProps} stated={[finding]} scope={[finding]} /> }
      : null;
    body = (
      <section className="rounded-xl border border-border bg-card px-4 pt-5 pb-1 sm:px-5">
        <p className="trace-eyebrow">Next step</p>
        <ol aria-label="Next step" className="verdict-steps">
          <NextStepItem
            step={interpretation.data.verdict.steps[stepIndex]}
            finding={finding}
            interpretation={interpretation}
            index={stepIndex}
            onRoute={NO_ROUTE}
            evidence={evidence}
          />
        </ol>
      </section>
    );
  } else if (isRow) {
    body = (
      <Table className="findings-table">
        <TableBody>
          <FindingRow finding={finding} allFindings={findings} onRoute={NO_ROUTE} evidence={{ widget: widget ?? null, widgetProps }} />
        </TableBody>
      </Table>
    );
  } else {
    body = widget ? <InlineEvidence widget={widget} widgetProps={widgetProps} scope={[finding]} /> : null;
  }

  return (
    <StepCodesShownContext.Provider value={false}>
      <EvidenceInitiallyOpenContext.Provider value>
        {body}
      </EvidenceInitiallyOpenContext.Provider>
    </StepCodesShownContext.Provider>
  );
}
