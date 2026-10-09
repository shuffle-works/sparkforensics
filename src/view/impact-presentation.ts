import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

/** The share of the run a finding's wall-clock saving could recover (the same
 * optimistic figure the impact band grades), or null when the finding has no
 * wall-clock estimate or the run has no duration. */
export function shareOfRun(finding: Finding, app: AppModel['app']): number | null {
  // The same duration the band grades against (core's appDurationMs, which the
  // export bundle may not import).
  const durationMs = app?.startTime != null && app?.endTime != null ? app.endTime - app.startTime : null;
  const recoverableMs = finding.impactEstimate?.wallClock?.high;
  if (durationMs == null || durationMs <= 0 || recoverableMs == null) return null;
  return recoverableMs / durationMs;
}

/** A share of the run as "2% of run" ("<1% of run" when it rounds to nothing). */
export function formatShareOfRun(share: number): string {
  const percent = share * 100;
  return percent > 0 && percent < 1 ? '<1% of run' : `${Math.round(percent)}% of run`;
}
