import type { EvidenceAvailability as EvidenceAvailabilityLedger, EvidenceAvailabilityEntry, EvidenceState } from '@sparkforensics/core/types.ts';
import { useAccessibleTooltip } from '@/view/AccessibleTooltip';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { evidenceLabel, useEvidenceAvailabilityDisclosure, useEvidenceRowRegistration } from '@/view/EvidenceAvailabilityContext';
import { ImpactDot, type ImpactDotProps } from '@/view/ImpactBadge';
import { WidgetCard } from '@/view/WidgetCard';

const STATE_LABELS: Record<EvidenceState, string> = {
  present: 'present',
  disabled: 'disabled',
  notEmitted: 'not emitted',
  notApplicable: 'not applicable',
  outsideEventLog: 'outside event log',
  unknown: 'unknown',
};

// Colored dot per state, via the shared ImpactDot vocabulary: `present` reads
// as available (info), the two "should be here but isn't" states as warning,
// the inert states as muted (ImpactDot's component-local 4th tier).
const STATE_IMPACT: Record<EvidenceState, ImpactDotProps['impactBand']> = {
  present: 'info',
  disabled: 'warning',
  notEmitted: 'warning',
  notApplicable: 'muted',
  outsideEventLog: 'muted',
  unknown: 'muted',
};

function EvidenceRow({ entry }: { entry: EvidenceAvailabilityEntry }) {
  const observedCount = entry.evidence?.count;
  const registerRow = useEvidenceRowRegistration();
  const detail = `${entry.summary}${observedCount != null ? ` · ${observedCount} observed` : ''}`;
  // Accessible tooltip so the detail stays reachable to screen readers, not just
  // mouse-hover users.
  const { tooltipProps, srOnlyTooltip } = useAccessibleTooltip(detail);

  return (
    // `focus:ring-2` (not `focus-visible:`): the row is focused programmatically
    // via `.focus()` on a `tabIndex={-1}` element, which never matches
    // `:focus-visible` in Chromium/Firefox: without this, sighted keyboard
    // users get no visual indication of where focus landed (WCAG 2.4.7).
    <li
      id={`evidence-availability-${entry.key}`}
      tabIndex={-1}
      ref={(el) => registerRow(entry.key, el)}
      className="flex flex-col gap-0.5 rounded-md px-2 py-1 outline-none focus:ring-2 focus:ring-ring"
      {...tooltipProps}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <ImpactDot impactBand={STATE_IMPACT[entry.state]} />
          <span className="truncate text-sm font-medium">{evidenceLabel(entry.key)}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{STATE_LABELS[entry.state]}</span>
        {srOnlyTooltip}
      </span>
      <AdvancedOnly>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </AdvancedOnly>
    </li>
  );
}

/** One-line "3 present · 1 disabled …" tally for the collapsed card header,
 * in the fixed STATE_LABELS order. */
function stateTally(entries: EvidenceAvailabilityEntry[]): string {
  return (Object.keys(STATE_LABELS) as EvidenceState[])
    .map((state) => [state, entries.filter((e) => e.state === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${STATE_LABELS[state]}`)
    .join(' · ');
}

export function EvidenceAvailability({ ledger }: { ledger: EvidenceAvailabilityLedger | null }) {
  const { evidenceCardOpen, setEvidenceCardOpen } = useEvidenceAvailabilityDisclosure();

  return (
    <WidgetCard
      title="Evidence availability"
      open={evidenceCardOpen}
      onOpenChange={setEvidenceCardOpen}
      summary={
        <span className="text-xs text-muted-foreground">
          {ledger ? stateTally(ledger.entries) : 'Unavailable for this restored run'}
        </span>
      }
    >
      {ledger ? (
        <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2" aria-label="Evidence availability ledger">
          {ledger.entries.map((entry) => <EvidenceRow key={entry.key} entry={entry} />)}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Evidence availability is unavailable for this restored run.</p>
      )}
    </WidgetCard>
  );
}
