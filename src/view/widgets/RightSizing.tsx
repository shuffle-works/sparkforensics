import { AdvancedOnly } from '@/view/AdvancedOnly';
import { TagBadge } from '@/view/ImpactBadge';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import type { WidgetProps } from '@/view/detector-registry';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';

function RightSizingRow({ finding }: { finding: FindingOf<'rightSizing'> }) {
  const { value, observedCores, observedActiveMs, modeledActiveMs, modelErrorPct } = finding;

  return (
    <div className="flex flex-col gap-1 transition-colors">
      <p>
        Modeled need: about <strong>{value}</strong> of the {observedCores} cores held at peak
      </p>
      <p className="text-xs text-muted-foreground">
        Stage time {formatDuration(modeledActiveMs)} modeled at {value} cores, against {formatDuration(observedActiveMs)} observed.
      </p>
      <AdvancedOnly>
        <p className="text-xs text-muted-foreground">
          Model error at the observed core count: {modelErrorPct}%.
        </p>
      </AdvancedOnly>
    </div>
  );
}

/** App-level right-sizing recommendation from the what-if scaling model. Renders only when a
 * `rightSizing` finding is present in the catalog. */
export function RightSizing({ catalog, defaultCollapsed = true }: WidgetProps) {
  const [finding] = findingsOfType(catalog, 'rightSizing');

  if (!finding) return null;

  const { impactBand, value, observedCores } = finding;

  return (
    <WidgetCard
      title="Right-sized Cluster"
      fixFor={[finding]}
      impactBand={impactBand}
      badges={<TagBadge type="rightSizing" impactBand={impactBand} />}
      defaultCollapsed={defaultCollapsed}
      summary={
        <WidgetLeadSummary
          value={`${value} of ${observedCores} cores`}
          context="modeled need"
        />
      }
    >
      <RightSizingRow finding={finding} />
    </WidgetCard>
  );
}
