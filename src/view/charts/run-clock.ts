// Pure helpers for the run clock: seconds from app start on a [0, runEndSec]
// domain, used by the verdict's stage strip.

interface RunTimingSource {
  app?: { startTime?: number | null; endTime?: number | null } | null;
  stages: Map<number, { submittedAt?: number | null; completedAt?: number | null }>;
}

/** App start in epoch ms: the app's own start, else the earliest stage
 * submission. Null when neither is recorded. */
export function runStartMs(appModel: RunTimingSource): number | null {
  if (appModel.app?.startTime) return appModel.app.startTime;
  let earliest = Infinity;
  for (const s of appModel.stages.values()) if (s.submittedAt) earliest = Math.min(earliest, s.submittedAt);
  return Number.isFinite(earliest) ? earliest : null;
}

/** Run length in seconds measured from app start: app end minus app start,
 * falling back to the earliest stage submission for the start and the latest
 * stage completion for the end. Null when no positive span can be derived. */
export function computeRunEndSec(appModel: RunTimingSource): number | null {
  let latestCompletion = -Infinity;
  for (const s of appModel.stages.values()) {
    if (s.completedAt) latestCompletion = Math.max(latestCompletion, s.completedAt);
  }
  const start = runStartMs(appModel);
  const end = appModel.app?.endTime ?? (Number.isFinite(latestCompletion) ? latestCompletion : null);
  if (start == null || end == null || end <= start) return null;
  return (end - start) / 1000;
}

// Clock-friendly steps (seconds): decimal under 10s, then minute/hour multiples.
const TICK_STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400,
];
// A regular tick closer than this fraction of a step to runEnd is dropped so
// its label does not collide with the runEnd label.
const MIN_LAST_GAP = 0.5;

/** Ticks shared by every run-time view: round steps from 0, ending exactly at
 * runEndSec (so the axis' last label is the run's real length). */
export function runClockTicks(runEndSec: number, maxTicks = 10): number[] {
  if (!(runEndSec > 0)) return [0];
  const step =
    TICK_STEPS.find((s) => Math.ceil(runEndSec / s) <= maxTicks - 1) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let k = 0; k * step < runEndSec - MIN_LAST_GAP * step; k++) {
    // Round away float drift (0.1 * 3 = 0.30000000000000004).
    ticks.push(Math.round(k * step * 1000) / 1000);
  }
  ticks.push(runEndSec);
  return ticks;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Compact run-clock label: "12.4s", "5s", "4m", "4m05s", "1h", "1h20m". */
export function formatRunClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0s';
  if (sec < 60) return `${Number(sec.toFixed(1))}s`;
  if (sec < 3600) {
    let m = Math.floor(sec / 60);
    let s = Math.round(sec - m * 60);
    if (s === 60) {
      m += 1;
      s = 0;
    }
    if (m === 60) return '1h';
    return s === 0 ? `${m}m` : `${m}m${pad2(s)}s`;
  }
  let h = Math.floor(sec / 3600);
  let m = Math.round((sec - h * 3600) / 60);
  if (m === 60) {
    h += 1;
    m = 0;
  }
  return m === 0 ? `${h}h` : `${h}h${pad2(m)}m`;
}
