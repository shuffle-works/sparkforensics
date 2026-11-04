import { costOnly } from '../../impact-model.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { defineAppDetector } from '../define.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface JobFailureRateEvidence {
  failedJobs: number;
  totalJobs: number;
  failedTasks: number;
  totalTasks: number;
  // Mean wall-clock of the failed jobs that recorded both timestamps, ms (0 when none did).
  avgJobDurationMs: number;
  taskFailureRate: number;
}

export interface JobFailureRateFinding extends NumericFinding<'jobFailureRate'>, JobFailureRateEvidence {}

export const jobFailureRateDetector = defineAppDetector({
  type: 'jobFailureRate', order: 110, bandPolicy: 'failure', fixEffort: 'code', version: 1,
  emits: ['jobFailureRate'],
  docAnchor: '#bottleneck-job-failure-rate',
  thresholds: { infoRate: 0.10, warnRate: 0.30, critRate: 0.50 },
  detect(ctx, thresholds): Finding | null {
    const { jobs, stages } = ctx;
    const all = jobs ? [...jobs.values()] : [];
    const completed = all.filter(j => j.result != null);
    if (completed.length === 0) return null;
    const failedJobList = completed.filter(j => j.succeeded === false);
    const failedJobs = failedJobList.length;
    const rate = failedJobs / completed.length;
    if (rate < thresholds.infoRate) return null;
    let totalTasks = 0, failedTasks = 0;
    for (const s of stages.values()) { totalTasks += s.taskCount ?? 0; failedTasks += s.failedTasks ?? 0; }
    const taskFailureRate = totalTasks > 0 ? failedTasks / totalTasks : 0;
    // Average wall-clock of failed jobs, for the impact estimator's cost-only figure. Jobs
    // missing either timestamp are excluded (not counted as zero); with none timed the average is 0.
    const timedFailedJobs = failedJobList.filter(j => j.submissionTime != null && j.completionTime != null);
    const avgJobDurationMs = timedFailedJobs.length > 0
      ? timedFailedJobs.reduce((s, j) => s + (j.completionTime! - j.submissionTime!), 0) / timedFailedJobs.length
      : 0;
    const totalJobs = completed.length;
    return {
      type: 'jobFailureRate', stageId: null,
      impactBand: rate >= thresholds.critRate ? 'critical' : rate >= thresholds.warnRate ? 'warning' : 'info',
      metric: 'jobFailureRate', value: Math.round(rate * 1000) / 10,
      failedJobs, totalJobs, failedTasks, totalTasks, avgJobDurationMs,
      taskFailureRate: Math.round(taskFailureRate * 1000) / 10,
      recommendation: `${failedJobs} of ${totalJobs} jobs never recovered: inspect the driver log for the failed job(s) and the stage failures that triggered them.`,
    };
  },
  estimate(finding): ImpactEstimate | null {
    const failedJobs = (finding.failedJobs as number | undefined) ?? 0;
    const avgJobDurationMs = (finding.avgJobDurationMs as number | undefined) ?? 0;
    const coreHoursIsh = (failedJobs * avgJobDurationMs) / 3.6e6;
    return costOnly('modeled', { value: coreHoursIsh, unit: 'coreHours' });
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  jobFailureRate: { finding: JobFailureRateFinding; evidence: JobFailureRateEvidence };
}

export const detectors = [jobFailureRateDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  jobFailureRate: ['failedJobs', 'totalJobs', 'failedTasks', 'totalTasks', 'avgJobDurationMs', 'taskFailureRate'],
} as const satisfies {
  jobFailureRate: readonly AllKeys<JobFailureRateEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  jobFailureRate: [],
} as const satisfies {
  jobFailureRate: readonly (DiscriminatorSlot & AllKeys<FindingOf<'jobFailureRate'>>)[];
};
