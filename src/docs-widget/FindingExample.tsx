import { useMemo, type ReactNode } from 'react';

import { worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { isRealFinding } from '@sparkforensics/core/recommendation-rollup.ts';
import type { Finding } from '@sparkforensics/core/types.ts';
import { Table, TableBody } from '@/components/ui/table';
import { useStore } from '@/store/store';
import { useIngest } from '@/store/useIngest';
import { EvidenceInitiallyOpenContext } from '@/view/InlineEvidenceContext';
import { REGISTRY } from '@/view/detector-registry';
import { StepCodesShownContext } from '@/view/StepCode';
import { InlineEvidence, useEvidencePanel } from '@/view/InlineEvidence';
import { eligibleFindings, findingAt, useInterpretation } from '@/view/interpretation';
import type { ActiveWidget } from '@/view/widgets/Alerts';
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
  const { getTaskData } = useIngest();

  const findings = useMemo(() => [...catalog, ...configFindings], [catalog, configFindings]);
  const finding = findings.find((candidate) => candidate.id === findingId);
  const widget = useMemo((): ActiveWidget | undefined => {
    const entry = finding && REGISTRY[finding.type];
    if (!finding || !entry) return undefined;
    const sameType = findings.filter((candidate) => candidate.type === finding.type && isRealFinding(candidate));
    return {
      component: entry.component,
      widgetId: entry.widgetId,
      type: finding.type,
      index: 0,
      findings: sameType,
      impactBand: worstImpactBand(sameType) ?? finding.impactBand,
    };
  }, [finding, findings]);

  const scope = useMemo(() => (finding ? [finding] : []), [finding]);
  // A step or row states its finding, so its panel shows what the line leaves out, or nothing. A
  // finding shown by its card alone states nothing.
  const panel = useEvidencePanel(widget, appModel, scope, scope);
  const cardPanel = useEvidencePanel(widget, appModel, scope, NOTHING_STATED);

  if (!finding || !interpretation) return <p role="alert">This run has no finding {findingId}.</p>;

  const widgetProps = { appModel, catalog, configFindings, getTaskData, activeFileId };
  const stepIndex = interpretation.data.verdict.steps.findIndex((step) => findingAt(interpretation, step.leadIndex) === finding);
  const isRow = eligibleFindings(interpretation).includes(finding);

  let body: ReactNode;
  if (stepIndex >= 0) {
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
    body = widget && cardPanel ? <InlineEvidence widget={widget} widgetProps={widgetProps} panel={cardPanel} /> : null;
  }

  return (
    <StepCodesShownContext.Provider value={false}>
      <EvidenceInitiallyOpenContext.Provider value>
        {body}
      </EvidenceInitiallyOpenContext.Provider>
    </StepCodesShownContext.Provider>
  );
}
