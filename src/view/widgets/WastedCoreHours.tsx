import { AdvancedOnly } from '@/view/AdvancedOnly';
import { ImpactDot } from '@/view/ImpactBadge';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { computeWastedCoreHours, MS_PER_CORE_HOUR } from '@sparkforensics/core/wasted-core-hours.ts';
import type { AppModel } from '@sparkforensics/core/types.ts';
import { DesignSpikeConfidenceBadge, formatCoreHours } from './design-spike-widget-shared';

export interface WastedCoreHoursProps {
  appModel: AppModel;
}

// Capacity core-hours held vs. core-hours that actually ran tasks.
// The top-N list ranks stages by task core-time, NOT by waste: per-stage waste
// isn't attributable here because concurrent stages share allocated capacity.
export function WastedCoreHours({ appModel }: WastedCoreHoursProps) {
  const m = computeWastedCoreHours(appModel.app, appModel.executors.added, appModel.runAggregates);
  if (m.totalCoreHours == null) return null;

  const wastedPct = m.totalCoreHours > 0 ? Math.round((m.wastedCoreHours! / m.totalCoreHours) * 100) : 0;

  return (
    <WidgetCard
      title="Wasted Core-Hours"
      statusBadge={<DesignSpikeConfidenceBadge />}
      defaultCollapsed
      summary={
        <WidgetLeadSummary
          value={<span className="whitespace-nowrap">{formatCoreHours(m.wastedCoreHours!)}</span>}
          context={`wasted of ${formatCoreHours(m.totalCoreHours)} allocated`}
        />
      }
    >
      <div className="space-y-2 text-sm">
        <p>
          Allocated: <strong>{formatCoreHours(m.totalCoreHours)}</strong> · Used:{' '}
          <strong>{formatCoreHours(m.usefulCoreHours!)}</strong>
        </p>
        <p>
          <ImpactDot impactBand="info" /> Wasted: <strong>{formatCoreHours(m.wastedCoreHours!)}</strong> ({wastedPct}%
          of allocated)
        </p>
        <AdvancedOnly>
          <p className="text-muted-foreground text-xs">
            Allocated = {m.totalCores} cores over the run; used = core-time that actually ran tasks.
          </p>
        </AdvancedOnly>
        {m.topStages.length > 0 && (
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">Top stages by task core-time</p>
            <ul className="space-y-0.5">
              {m.topStages.map((s) => (
                <li key={s.stageId} className="flex justify-between gap-2">
                  <span>Stage {s.stageId}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatCoreHours(s.coreMs / MS_PER_CORE_HOUR)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </WidgetCard>
  );
}
