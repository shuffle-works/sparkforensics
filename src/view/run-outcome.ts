import type { Finding, Job } from '@sparkforensics/core/types.ts';

/** Finding types that mean work did not finish: a stage attempt that failed
 * outright, and jobs that ended without succeeding. Failed tasks that a retry
 * recovered (`failures`) are not in this set: the run still completed. */
export const FAILURE_TYPES: ReadonlySet<string> = new Set(['stageFailed', 'jobFailureRate']);

/** Longest failure reason the verdict quotes; Spark reasons can carry a whole
 * stack trace, and the first line already names the cause. */
export const FAILURE_REASON_MAX_CHARS = 240;

/** How the run ended, as far as its jobs say. `failedJobs` and `totalJobs`
 * count only jobs with an end record, so a job still running when an
 * incomplete log stops is neither. */
export interface RunOutcome {
  failedJobs: number;
  totalJobs: number;
  /** Stages of the failed jobs: a failure there is what stopped a job. */
  failedJobStageIds: ReadonlySet<number>;
  /** Spark's own recorded reason for the failure, first line only, or null
   * when the log records none. */
  reason: string | null;
  /** The stage whose failure reason is quoted, or null when the reason came
   * from a job's exception or there is none. */
  reasonStageId: number | null;
}

function firstLine(text: string): string | null {
  const line = text.split('\n')[0].trim();
  if (line.length === 0) return null;
  return line.length > FAILURE_REASON_MAX_CHARS ? `${line.slice(0, FAILURE_REASON_MAX_CHARS - 3).trimEnd()}...` : line;
}

function exceptionText(exception: unknown): string | null {
  if (typeof exception === 'string') return exception;
  return null;
}

/** Summarizes the run's job results. The reason prefers a failed stage that
 * belongs to a failed job (the stage is the nearer cause), then any failed
 * stage, then the first failed job's exception message. */
export function summarizeRunOutcome(jobs: Map<number, Job>, findings: Finding[]): RunOutcome {
  const ended = [...jobs.values()].filter((job) => job.result != null);
  const failed = ended.filter((job) => job.succeeded === false).sort((a, b) => a.id - b.id);
  const failedStageIds = new Set(failed.flatMap((job) => job.stageIds));
  const stageReasons = findings
    .filter((finding) => finding.type === 'stageFailed' && typeof finding.value === 'string')
    .sort((a, b) => Number(failedStageIds.has(b.stageId as number)) - Number(failedStageIds.has(a.stageId as number)));
  const stageSource = stageReasons[0];
  const rawReason =
    (stageSource?.value as string | undefined)
    ?? failed.map((job) => exceptionText(job.exception)).find((text) => text != null)
    ?? null;
  return {
    failedJobs: failed.length,
    totalJobs: ended.length,
    failedJobStageIds: failedStageIds,
    reason: failed.length > 0 && rawReason != null ? firstLine(rawReason) : null,
    reasonStageId: stageSource?.stageId ?? null,
  };
}

/** Whether the quoted reason is this finding's own: the stage failure whose
 * first line it is, or the job-failure finding when exactly one job failed
 * and the reason belongs to that job. Any other failure has a cause the
 * verdict does not show. */
export function quotesReasonOf(finding: Finding, outcome: RunOutcome): boolean {
  if (outcome.reason == null) return false;
  if (finding.type === 'stageFailed') return typeof finding.value === 'string' && firstLine(finding.value) === outcome.reason;
  if (finding.type === 'jobFailureRate') {
    return outcome.failedJobs === 1 && (outcome.reasonStageId == null || outcome.failedJobStageIds.has(outcome.reasonStageId));
  }
  return false;
}
