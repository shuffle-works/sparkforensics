import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { TagBadge } from '@/view/ImpactBadge';
import { WidgetCard } from '@/view/WidgetCard';
import type { WidgetProps } from '@/view/detector-registry';
import type { Finding } from '@sparkforensics/core/types.ts';
import { usePresentedToneOf } from '@/view/impact-presentation';

/** Single-row body for the `incompleteRun` finding. App-scoped (no StagePill),
 * always one row (no pagination). */
function IncompleteRunRow({ finding }: { finding: Finding }) {
  const { recommendation } = finding;

  return (
    <div className="flex flex-col gap-1 transition-colors">
      <p className="text-xs text-muted-foreground">
        ApplicationEnd event: <strong>missing</strong>
      </p>
      <ImpactEstimate finding={finding} />
      {recommendation ? <p className="pt-1">{recommendation}</p> : null}
    </div>
  );
}

/** No SparkListenerApplicationEnd was recorded, so every other finding and
 * metric on this board reflects only what was captured before the run was cut
 * off. Renders nothing when the run completed normally. */
export function IncompleteRun({ catalog, defaultCollapsed = true }: WidgetProps) {
  const finding = catalog.find((f) => f.type === 'incompleteRun');
  const toneOf = usePresentedToneOf();
  if (!finding) return null;

  return (
    <WidgetCard
      title="Incomplete Run"
      impactBand={toneOf(finding)}
      badges={<TagBadge type="incompleteRun" impactBand={toneOf(finding)} />}
      defaultCollapsed={defaultCollapsed}
    >
      <IncompleteRunRow finding={finding} />
    </WidgetCard>
  );
}
