import type { Finding, SparkAppInfo } from './types.ts';
import { STRAGGLER_FLOOR_PCT_WARN, STRAGGLER_FLOOR_PCT_CRIT } from './detectors.ts';

// Reused from straggler's own thresholds (marked NOT SOURCED: unvalidated there): apply the same
// accepted noise floor globally rather than inventing a second cutoff. Imported so they can't drift.
const IMPACT_FLOOR_PCT_WARN = STRAGGLER_FLOOR_PCT_WARN;
const IMPACT_FLOOR_PCT_CRIT = STRAGGLER_FLOOR_PCT_CRIT;

function appDurationMs(app: SparkAppInfo | null): number | null {
  if (app?.startTime == null || app?.endTime == null) return null;
  const durationMs = app.endTime - app.startTime;
  return durationMs > 0 ? durationMs : null;
}

/**
 * Overwrites `.impactBand` for any finding with a quantified wall-clock estimate, grading it purely
 * by recoverable time as a fraction of the run's duration: a full replace (either direction), not a
 * promote-only floor. Findings with no wallClock estimate (resourceOnly/informational), an
 * unknown/zero app duration, or an explicit safety-signal exemption (partitionSizing's
 * maxPartitionTooBig rule) are left as the detector set them. Mutates in place and returns the array.
 *
 * Grades wallClock.high (matching triage-target/FixTheseFirst, which rank by the same optimistic
 * figure), a deliberate split from view/impact-sort.ts's 'impact' sort, which ranks by .low so an
 * optimistic-but-contended finding never outranks a smaller certain one. Same range, two fields for
 * two questions.
 */
export function deriveImpactBand(findings: Finding[], app: SparkAppInfo | null): Finding[] {
  const durationMs = appDurationMs(app);
  if (durationMs == null) return findings;
  for (const finding of findings) {
    // maxPartitionTooBig is a hardcoded-critical OOM/crash-risk safety signal, not a
    // time-recovery one, yet it carries a real wallClock estimate (unlike the other hardcoded-
    // critical findings, which stay costOnly/informational and are exempted below by having no
    // wallClock at all). Exempt it explicitly so a long-running job never demotes an active
    // crash risk down to 'info' just because fixing it saves little wall-clock time relative to
    // the run.
    if (finding.type === 'partitionSizing' && finding.rule === 'maxPartitionTooBig') continue;
    const recoverableMs = finding.impactEstimate?.wallClock?.high;
    if (recoverableMs == null) continue;
    const pct = recoverableMs / durationMs;
    finding.impactBand = pct >= IMPACT_FLOOR_PCT_CRIT ? 'critical' : pct >= IMPACT_FLOOR_PCT_WARN ? 'warning' : 'info';
  }
  return findings;
}
