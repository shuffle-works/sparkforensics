import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { attributeEtlPhases } from '@sparkforensics/core/etl-phases.ts';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { AppModel } from '@sparkforensics/core/types.ts';

export interface EtlPhasesProps {
  appModel: AppModel;
}

const PHASES: { label: string; key: 'extract' | 'transform' | 'load' }[] = [
  { label: 'Extract', key: 'extract' },
  { label: 'Transform', key: 'transform' },
  { label: 'Load', key: 'load' },
];

/** Descriptive ETL-phase breakdown. Not a bottleneck flag: no impact-band
 * border, no badges. Phases can overlap (a stage that both shuffles and writes
 * counts in both Transform and Load), so buckets need not sum to wall-clock.
 * Renders nothing when the run has no attributable time in any phase. */
export function EtlPhases({ appModel }: EtlPhasesProps) {
  const phases = attributeEtlPhases(appModel.stages);
  const total = phases.extract + phases.transform + phases.load;
  if (total === 0) return null;

  const dominant = PHASES.reduce((acc, phase) => (phases[phase.key] > phases[acc.key] ? phase : acc));

  return (
    <WidgetCard
      title="ETL Phase Attribution"
      defaultCollapsed
      summary={<WidgetLeadSummary value={`${dominant.label} ${formatDuration(phases[dominant.key])}`} context="largest phase, in summed stage time" />}
    >
      <div className="space-y-1">
        {PHASES.map(({ label, key }) => (
          // div, not <p>: ReferenceSection's AccordionContent applies
          // `[&_p:not(:last-child)]:mb-4` to descendant <p>, whose specificity
          // beats this div's `space-y-1` and forces a 16px gap.
          <div key={key}>
            <strong>{label}</strong>: {formatDuration(phases[key])}
          </div>
        ))}
        {/* Plain in both views: a phase can read longer than the whole run,
            which looks like a bug unless the reader knows the times are summed. */}
        <div className="text-xs text-muted-foreground">
          Each phase adds up the run time of its stages. Stages that run at the same time both count, so a phase
          can add up to more than the run's wall-clock.
        </div>
        <AdvancedOnly>
          <div className="text-xs text-muted-foreground">
            Heuristic: a stage that both shuffles and writes counts in Transform and Load, so
            phases can overlap and need not sum to wall-clock.
          </div>
        </AdvancedOnly>
      </div>
    </WidgetCard>
  );
}
