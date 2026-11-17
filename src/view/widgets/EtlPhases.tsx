import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { useInterpretation, type InterpretationState } from '@/view/interpretation';
import { formatDuration } from '@sparkforensics/core/view-model';

/** Whether the run has attributable time in any phase; the grid mounts the tile only then. */
export function hasEtlPhases(interpretation: InterpretationState | null): boolean {
  const phases = interpretation?.data.etlPhases;
  return !!phases && phases.extract + phases.transform + phases.load > 0;
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
export function EtlPhases() {
  const interpretation = useInterpretation();
  const phases = interpretation?.data.etlPhases;
  if (!phases || !hasEtlPhases(interpretation)) return null;

  const dominant = PHASES.reduce((acc, phase) => (phases[phase.key] > phases[acc.key] ? phase : acc));

  return (
    <WidgetCard
      title="ETL Phase Attribution"
      defaultCollapsed
      summary={<WidgetLeadSummary value={`${dominant.label} ${formatDuration(phases[dominant.key])}`} context="largest phase" />}
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
        {/* Plain in both views: explains how overlapping stages are counted. */}
        <div className="text-xs text-muted-foreground">
          Concurrent stages in a phase count once, so no phase exceeds the wall-clock.
        </div>
        <AdvancedOnly>
          <div className="text-xs text-muted-foreground">
            Heuristic: a stage that both shuffles and writes counts in Transform and Load.
          </div>
        </AdvancedOnly>
      </div>
    </WidgetCard>
  );
}
