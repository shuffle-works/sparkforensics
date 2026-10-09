import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { TagBadge } from '@/view/ImpactBadge';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import type { WidgetProps } from '@/view/detector-registry';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { usePresentedToneOf } from '@/view/impact-presentation';

/** Single-row body for an active `jobFailureRate` finding. App-scoped (no
 * StagePill), always one row (no pagination). */
function JobFailuresRow({ finding }: { finding: FindingOf<'jobFailureRate'> }) {
  const { failedJobs, totalJobs, failedTasks, totalTasks, taskFailureRate, value } = finding;

  return (
    <div className="flex flex-col gap-1 transition-colors">
      <p>
        Failure rate: <strong>{value}%</strong> ({failedJobs} of {totalJobs} completed jobs)
      </p>
      <AdvancedOnly>
        <p className="text-xs text-muted-foreground">
          Task-failure context: {failedTasks} of {totalTasks} tasks failed ({taskFailureRate}%).
        </p>
      </AdvancedOnly>
      <ImpactEstimate finding={finding} />
    </div>
  );
}

/** App-level job-failure-rate rollup, complementing the per-stage Failed Tasks
 * card. Renders only when a `jobFailureRate` finding is present in the
 * catalog; otherwise `computeActiveWidgets` (`Alerts.tsx`) never mounts this
 * component and the type shows as a Clean Checks row instead. */
export function JobFailures({ catalog, defaultCollapsed = true }: WidgetProps) {
  const [finding] = findingsOfType(catalog, 'jobFailureRate');
  const toneOf = usePresentedToneOf();

  if (!finding) return null;

  const { value, failedJobs, totalJobs } = finding;

  return (
    <WidgetCard
      title="Job Failures"
      fixFor={[finding]}
      impactBand={toneOf(finding)}
      badges={<TagBadge type="jobFailureRate" impactBand={toneOf(finding)} />}
      defaultCollapsed={defaultCollapsed}
      summary={
        <WidgetLeadSummary
          value={`${value}%`}
          context={`${failedJobs} of ${totalJobs} completed jobs failed`}
        />
      }
    >
      <JobFailuresRow finding={finding} />
    </WidgetCard>
  );
}
