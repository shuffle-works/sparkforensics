// The one place that decides what a run's application start and end mean. Every surface (the
// verdict, budgets, the detectors, MCP, the dashboard) reads these four facts instead of testing
// `endTime` itself; `rules/no-app-timing-outside-run-timing.yml` bans the copies.

export interface RunTiming {
  /** The log records a finite application start and an end after it. */
  complete: boolean;
  /** End minus start of a complete interval, else null. */
  durationMs: number | null;
  /** The latest completion among stages with a submit and a completion time: where a clock ends
   * when the log has no application end. Null when no stage finished. */
  fallbackEndMs: number | null;
  /** The log has an application start but no application end (a truncated capture). */
  incomplete: boolean;
}

type TimedApp = { startTime?: number | null; endTime?: number | null };
type TimedStages = Map<number, { submittedAt?: number | null; completedAt?: number | null }>;

const NO_STAGES: TimedStages = new Map();

export function runTiming(app: TimedApp | null | undefined, stages: TimedStages = NO_STAGES): RunTiming {
  const start = app?.startTime;
  const end = app?.endTime;
  const complete = typeof start === 'number' && Number.isFinite(start)
    && typeof end === 'number' && Number.isFinite(end) && end > start;
  let fallbackEndMs: number | null = null;
  for (const stage of stages.values()) {
    if (stage.submittedAt != null && stage.completedAt != null && (fallbackEndMs == null || stage.completedAt > fallbackEndMs)) fallbackEndMs = stage.completedAt;
  }
  return {
    complete,
    durationMs: complete ? (end as number) - (start as number) : null,
    fallbackEndMs,
    incomplete: start != null && end == null,
  };
}
