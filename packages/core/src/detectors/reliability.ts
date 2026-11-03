import { costOnly, noWasteModel, retryWallClockMs, singleStageImpact } from '../impact-model.ts';
import { MAX_FAILURE_GROUPS, describeTaskFailure, type TaskFailureGroup } from '../task-failure.ts';
import { adviseFailureGroup, adviseStageFailure } from '../failure-advice.ts';
import type { Finding, ImpactEstimate } from '../types.ts';
import { defineAppDetector, defineStageDetector } from './define.ts';
import type { DetectorFailureReason } from './types.ts';

function pickDominantReason(reasons: DetectorFailureReason[] | undefined): string | null {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  return [...reasons].sort((a, b) => b.count - a.count)[0].reason;
}

// Groups arrive most frequent first: the largest group under the dominant reason tag, so a named
// error or its advice agrees with the tag even when one tag splits into many messages.
function dominantFailureGroup(stage: { failureReasons?: DetectorFailureReason[]; failureGroups?: TaskFailureGroup[] }): TaskFailureGroup | undefined {
  const dominantReason = pickDominantReason(stage.failureReasons);
  return stage.failureGroups?.find((g) => g.reason === dominantReason);
}

export const stageFailedDetector = defineStageDetector({
  type: 'stageFailed', order: 42, fixEffort: 'code', version: 1,
  emits: ['stageFailed'],
  docAnchor: '#bottleneck-failures',
  thresholds: {},
  detect(stage, ctx): Finding | null {
    if (stage.stageFailureReason == null) return null;
    const abortTexts = [
      ...[...ctx.jobs.values()].map((j) => j.exception),
      ...[...ctx.stages.values()].map((s) => (s.id === stage.id ? null : s.stageFailureReason)),
    ].filter((t): t is string => typeof t === 'string');
    const advice = adviseStageFailure(stage.id, stage.stageFailureReason, abortTexts);
    return {
      type: 'stageFailed', stageId: stage.id, impactBand: 'critical',
      variant: 'stageFailure',
      metric: 'stageFailureReason', valueText: stage.stageFailureReason,
      numTasks: stage.taskCount,
      memoryBytesSpilled: stage.memoryBytesSpilled,
      failedTaskDetails: stage.failedTaskSamples ?? [],
      recommendation: advice?.recommendation ?? `This stage attempt failed outright. Inspect the driver log for the failure reason and the job that triggered it.`,
      ...(advice && { remediation: advice.remediation }),
    };
  },
  estimate: noWasteModel,
});

export const failuresDetector = defineStageDetector({
  type: 'failures', order: 40, fixEffort: 'code', version: 2,
  emits: ['failures'],
  docAnchor: '#bottleneck-failures',
  thresholds: { minTasks: 10, warnRate: 0.05, critRate: 0.20 },
  detect(stage, _ctx, thresholds): Finding | null {
    if (stage.taskCount < thresholds.minTasks) return null;
    if (!stage.failedTasks) return null;
    const failureRate = stage.failedTasks / stage.taskCount;
    if (failureRate <= thresholds.warnRate) return null;
    const value = Math.round(failureRate * 1000) / 10;
    const dominantReason = pickDominantReason(stage.failureReasons);
    const allGroups = stage.failureGroups ?? [];
    const dominantGroup = dominantFailureGroup(stage);
    const dominantError = (dominantGroup ? describeTaskFailure(dominantGroup) : null) ?? dominantReason;
    const failureGroups = allGroups.slice(0, MAX_FAILURE_GROUPS);
    const groupedTasks = failureGroups.reduce((sum, g) => sum + g.count, 0);
    const advice = adviseFailureGroup(dominantGroup);
    return {
      type: 'failures', stageId: stage.id,
      impactBand: failureRate > thresholds.critRate ? 'critical' : 'warning',
      metric: 'failureRate', value,
      failedTasks: stage.failedTasks,
      dominantReason,
      dominantError,
      // One entry per distinct error (tag, class, message, loss reason), each with one bounded
      // stack excerpt; otherFailedTasks counts the failed tasks no shown group covers.
      failureGroups,
      otherFailedTasks: Math.max(0, stage.failedTasks - groupedTasks),
      recommendation: `${value}% of tasks failed${dominantError ? ` (dominant error: ${dominantError})` : ''}: ${advice?.recommendation ?? 'investigate driver logs for executor instability or data-driven errors.'}`,
      ...(advice && { remediation: advice.remediation }),
    };
  },
  estimate: noWasteModel,
});

export const retryWasteDetector = defineStageDetector({
  type: 'retryWaste', order: 45, fixEffort: 'code', version: 1,
  emits: ['retryWaste'],
  docAnchor: '#bottleneck-retry-waste',
  thresholds: { minWasted: 3, minWasteMs: 30000 },
  detect(stage, _ctx, thresholds): Finding | null {
    const wasted = stage.wastedAttempts ?? 0;
    const wastedMs = stage.retryWasteMs ?? 0;
    if (wasted < thresholds.minWasted || wastedMs < thresholds.minWasteMs) return null;
    // From the retried attempts themselves: when the retries succeed, no failure stays on the stage.
    const advice = adviseFailureGroup(stage.retryFailureGroups?.[0]);
    return {
      type: 'retryWaste', stageId: stage.id,
      impactBand: 'warning',
      metric: 'retryWasteMs', value: wastedMs,
      numTasks: stage.taskCount,
      memoryBytesSpilled: stage.memoryBytesSpilled,
      retriedTaskDetails: stage.retryTaskSamples ?? [],
      recommendation: `Retried task attempts wasted ${Math.round(wastedMs / 1000)}s of executor time (${wasted} attempt${wasted === 1 ? '' : 's'}) even though the stage completed: ${advice?.recommendation ?? 'investigate executor loss or fetch failures.'}`,
      ...(advice && { remediation: advice.remediation }),
      extended: `${wasted} task attempts were superseded by a later retry, wasting ${Math.round(wastedMs / 1000)}s of executor time. Common causes: executor loss (OOM-kill, node death) or shuffle FetchFailed forcing a stage-map recompute. Check driver logs for the dominant reason (see the Failures widget) even if the final failure rate looks low; retries hide the true cost.`,
    };
  },
  estimate(finding, ctx): ImpactEstimate | null {
    // The waste figure lives on the Stage, not the Finding: detect() only re-publishes it as metric/value.
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    const wasteMs = (stage.retryWasteMs as number | undefined) ?? 0;
    const wallClockMs = retryWallClockMs(stage);
    return singleStageImpact(wallClockMs, finding.stageId, ctx,
      wallClockMs === wasteMs ? 'measured' : 'modeled', { value: wasteMs, unit: 'ms' });
  },
});

export const jobFailureRateDetector = defineAppDetector({
  type: 'jobFailureRate', order: 110, fixEffort: 'code', version: 1,
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
