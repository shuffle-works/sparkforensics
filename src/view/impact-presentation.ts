import { useStore } from '@/store/store';
import { worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { AppModel, Finding, ImpactBand } from '@sparkforensics/core/types.ts';

/** The color a finding is drawn in: its impact band, or `neutral` for a
 * critical finding whose recoverable time is a small share of the run. */
export type ImpactTone = ImpactBand | 'neutral';

/** Red claims the run's attention, so a critical finding keeps it only when
 * its potential saving is at least this share of the run. */
export const MEANINGFUL_SHARE_OF_RUN = 0.1;

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

/** The tone to draw a finding in. The finding's band and its figures stay as
 * computed; only critical findings with a known, small share go neutral. */
export function presentedTone(finding: Finding, app: AppModel['app']): ImpactTone {
  if (finding.impactBand !== 'critical') return finding.impactBand;
  const share = shareOfRun(finding, app);
  return share != null && share < MEANINGFUL_SHARE_OF_RUN ? 'neutral' : 'critical';
}

/** A share of the run as "2% of run" ("<1% of run" when it rounds to nothing). */
export function formatShareOfRun(share: number): string {
  const percent = share * 100;
  return percent > 0 && percent < 1 ? '<1% of run' : `${Math.round(percent)}% of run`;
}

/** `presentedTone` for the open run. */
export function usePresentedTone(finding: Finding): ImpactTone {
  const app = useStore((s) => s.appModel.app);
  return presentedTone(finding, app);
}

/** `presentedTone` bound to the open run, for a widget that draws many findings. */
export function usePresentedToneOf(): (finding: Finding) => ImpactTone {
  const app = useStore((s) => s.appModel.app);
  return (finding) => presentedTone(finding, app);
}

/** The tone for several findings drawn as one (a widget card, its tag): their
 * worst band, neutral when none of its critical findings is a meaningful share. */
export function worstPresentedTone(findings: readonly Finding[], app: AppModel['app']): ImpactTone | undefined {
  const worst = worstImpactBand([...findings]);
  if (worst !== 'critical') return worst;
  return findings.some((finding) => presentedTone(finding, app) === 'critical') ? 'critical' : 'neutral';
}

/** `worstPresentedTone` for the open run. */
export function useWorstPresentedTone(findings: readonly Finding[]): ImpactTone | undefined {
  const app = useStore((s) => s.appModel.app);
  return worstPresentedTone(findings, app);
}
