// The run-level sums every surface reads: the CLI metrics block and the run comparison (so the
// dashboard's comparison view and the MCP compare_runs tool) share these, so one name never means
// two figures.
import { nsToMs } from './format-utils.ts';
import type { Stage } from './types.ts';

/** Each stage followed by the work its own figures leave out, shaped like a stage: the attempts a
 * resubmit replaced, and task attempts the stage record dropped (a failed attempt's late tasks,
 * failed retries, losing speculative copies). Summing the result counts every attempt's work,
 * failed ones too. A stage's own record, which the detectors and per-stage views read, is left as
 * it is. */
export function withEarlierAttempts(stages: Stage[]): Stage[] {
  return stages.flatMap((s) => [s, ...[s.earlierAttempts, s.lateAttemptWork]
    .filter((work) => work != null)
    .map(({ durationMs, ...totals }) => ({ id: s.id, ...totals, submittedAt: 0, completedAt: durationMs ?? undefined }))]);
}

/** Summed executor CPU time in ms. Spark records it in nanoseconds and the parser reads an absent
 * metric as 0, so stages that all read 0 never recorded it (older Spark): null, not 0. */
export function totalExecutorCpuMs(stages: Iterable<Pick<Stage, 'executorCpuTime'>>): number | null {
  let ns = 0;
  for (const s of stages) if (typeof s.executorCpuTime === 'number' && Number.isFinite(s.executorCpuTime) && s.executorCpuTime > 0) ns += s.executorCpuTime;
  return ns > 0 ? nsToMs(ns) : null;
}
