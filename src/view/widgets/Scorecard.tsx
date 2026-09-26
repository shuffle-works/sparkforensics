import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { computeWallClock } from '@sparkforensics/core/wall-clock.ts';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { WidgetProps } from '@/view/detector-registry';
import { IMPACT_BG_CLASS, IMPACT_TEXT_CLASS, ImpactDot } from '@/view/ImpactBadge';
import { useWidgetDensity } from '@/store/store';
import { getScorecardEstimates, hasCompleteApplicationInterval } from './scorecard-estimates';

// Run-info stats row: wall-clock, efficiency, unused core time (not problem
// counts, which live in RunVerdict and the Findings tab). Basic view
// captions say what each number measures and which direction is better, so
// Efficiency (a share of time) and Unused core time (a share of core-hours) never
// read as contradicting each other; Advanced view keeps the raw breakdowns.
export type ScorecardProps = Pick<WidgetProps, 'appModel' | 'catalog'>;

type FlagImpactBand = 'critical' | 'warning' | null;

// Text/bar colors come from ImpactBadge.tsx's shared impact-band vocabulary
// (IMPACT_TEXT_CLASS/IMPACT_BG_CLASS), indexed by the tile's flag; a tile's
// flag is never 'info', so only the critical/warning entries of those maps
// are ever read here. The left-edge accent is its own local `ACCENT_SHADOW`
// map below, not `IMPACT_BORDER_CLASS`: see the note on `KpiTile`.

interface KpiTileProps {
  eyebrow: string;
  value: ReactNode;
  meta: ReactNode;
  flag?: FlagImpactBand;
  /** Under-the-number proportion/segment instrument (ProportionBar or
   * ActiveIdleBar below); omitted for a tile with no measurable value. */
  bar?: ReactNode;
  dataTestid?: string;
}

// Impact accent as an inset box-shadow, not a border: the grid's own
// `divide-x`/`divide-y` separators are themselves border-left/border-top,
// so a tile that also claimed `border-l-4` (even transparent, when
// unflagged) silently overwrote that separator on the same CSS property —
// two adjacent healthy tiles rendered with no visible boundary at all
// (confirmed live: Wall-clock and an unflagged Efficiency tile ran
// together with zero seam). An inset shadow paints the accent without
// touching border-left, so the divider always renders underneath it.
const ACCENT_SHADOW: Record<'critical' | 'warning', string> = {
  critical: 'inset 4px 0 0 var(--color-critical)',
  warning: 'inset 4px 0 0 var(--color-warning)',
};

function KpiTile({ eyebrow, value, meta, flag = null, bar, dataTestid }: KpiTileProps) {
  return (
    <div
      data-testid={dataTestid}
      // Signal-only color rule: a tile earns a colored edge only when the
      // analysis actually flagged it, never as decoration for a healthy value.
      className="flex flex-col gap-1 p-3"
      style={flag ? { boxShadow: ACCENT_SHADOW[flag] } : undefined}
    >
      <span className={cn('flex items-center gap-1.5 text-xs font-medium text-muted-foreground', flag && IMPACT_TEXT_CLASS[flag])}>
        {flag && <ImpactDot impactBand={flag} />}
        {eyebrow}
      </span>
      <div className={cn('font-heading text-2xl font-semibold', flag && IMPACT_TEXT_CLASS[flag])}>{value}</div>
      <p className="text-xs text-muted-foreground">{meta}</p>
      {bar}
    </div>
  );
}

/** Efficiency/Wastage's compact instrument: the metric's own percentage as a
 * fill width, colored by the tile's flag (or the healthy `clean` token when
 * unflagged) so severity reads pre-attentively instead of requiring the user
 * to read the number and the color separately. */
function ProportionBar({ pct, flag, label }: { pct: number; flag: FlagImpactBand; label: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div role="img" aria-label={label} className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn('h-full rounded-full', flag ? IMPACT_BG_CLASS[flag] : 'bg-clean')} style={{ width: `${clamped}%` }} />
    </div>
  );
}

/** Wall-clock's compact instrument: active stage time vs the rest of the run,
 * using the same stagesActive=clean/idle=muted mapping as WallClock's full
 * breakdown bar. */
function ActiveIdleBar({ active, total }: { active: number; total: number }) {
  const activePct = total > 0 ? Math.max(0, Math.min(100, (active / total) * 100)) : 0;
  return (
    <div
      role="img"
      aria-label={`Active ${formatDuration(active)} of ${formatDuration(total)} total`}
      className="mt-0.5 flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full bg-clean" style={{ width: `${activePct}%` }} />
      <div className="h-full flex-1 bg-muted-foreground/60" />
    </div>
  );
}

// `formatDuration(0)` reads as '—' (its shared "no measurable value" glyph),
// which for stage-active time on a real run looks like broken/missing data
// rather than "nothing ran". Spell out the zero case instead of chaining
// into that glyph.
function formatRanLabel(activeMs: number): string {
  return activeMs > 0 ? `Ran ${formatDuration(activeMs)}` : 'No stage activity recorded';
}

/** With no complete application timing interval, wall-clock, efficiency, and
 * wastage are all unavailable at once (each derives from
 * `hasCompleteApplicationInterval`), so one amber notice replaces the row
 * instead of stacking the same reason across three tiles. */
function TimingUnavailableNotice() {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4">
      <ImpactDot impactBand="warning" className="mt-1.5" />
      <p className="text-sm text-warning">
        <span className="font-semibold tracking-wide uppercase">Timing unavailable</span>
        {'. This run has no complete application timing interval, so wall-clock, efficiency, and unused core time can’t be measured.'}
      </p>
    </div>
  );
}

export function Scorecard({ appModel, catalog }: ScorecardProps) {
  const density = useWidgetDensity();
  const { app, stages } = appModel;
  const hasTiming = hasCompleteApplicationInterval(app);
  if (!hasTiming) return <TimingUnavailableNotice />;

  const wc = computeWallClock(app, stages);
  const estimates = getScorecardEstimates(appModel);

  const total = wc.total;
  const efficiency = estimates.efficiency.value;
  const effFlag: FlagImpactBand = efficiency == null ? null : efficiency < 75 ? 'critical' : efficiency < 90 ? 'warning' : null;

  const coldStart = catalog.find((f) => f.type === 'coldStart');

  const wastagePct = estimates.wastage.value;
  const wastageFlag: FlagImpactBand = wastagePct == null ? null : wastagePct >= 70 ? 'critical' : wastagePct >= 40 ? 'warning' : null;

  // Stays a raw Card, not WidgetCard: WidgetCard always renders an <h3>, and
  // Scorecard mounts above the tab strip with no enclosing <h2> section, so
  // that heading would jump straight from the page's h1 (h1->h3), which
  // tests/view/dashboard-render.test.tsx's outline walk (and WCAG 2.4.10)
  // both reject. WidgetCard would also add a title row, a collapse chevron,
  // and a border-l-4, none of which this chrome-free KPI strip wants.
  return (
    <Card className="overflow-hidden py-0">
      <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <KpiTile
          eyebrow="Wall-clock"
          dataTestid="kpi-wall-clock"
          value={total > 0 ? formatDuration(total) : '—'}
          meta={
            density === 'advanced' || wc.stagesActive <= 0 ? (
              <>
                {formatRanLabel(wc.stagesActive)}
                {coldStart ? ` · ${coldStart.value}s cold start` : ''}
              </>
            ) : (
              `Total run time. Stages were running for ${formatDuration(wc.stagesActive)} of it.`
            )
          }
          bar={<ActiveIdleBar active={wc.stagesActive} total={total} />}
        />
        <KpiTile
          eyebrow="Efficiency"
          dataTestid="kpi-efficiency"
          value={efficiency == null ? 'Unavailable' : (<>{efficiency}<small>%</small></>)}
          flag={effFlag}
          meta={
            efficiency == null
              ? 'This run has no complete application timing interval.'
              : density !== 'advanced'
                ? 'Share of the run with a stage running. Higher is better.'
                : total > wc.stagesActive
                  ? `${formatRanLabel(wc.stagesActive)} · ${formatDuration(total - wc.stagesActive)} idle/gap time`
                  : 'executors active the whole run'
          }
          bar={efficiency != null ? <ProportionBar pct={efficiency} flag={effFlag} label={`Efficiency ${efficiency}%`} /> : undefined}
        />
        <KpiTile
          eyebrow="Unused core time"
          dataTestid="kpi-wastage"
          value={wastagePct == null ? 'Unavailable' : (<>{wastagePct}<small>%</small></>)}
          flag={wastageFlag}
          meta={
            estimates.wastage.unavailableReason === 'application-timing'
              ? 'Unused core time needs complete application timing.'
              : estimates.wastage.unavailableReason === 'core-usage-summary'
                ? 'Unused core time needs the core-usage summary.'
                : estimates.wastage.unavailableReason === 'executor-capacity'
                  ? 'Unused core time needs usable executor-capacity data.'
                  : density === 'advanced'
                    ? 'Driver-idle + executor-slack core-hours as a share of available capacity. Directional, not a cost figure.'
                    : 'Driver idle plus executor slack across the whole run, so it can run higher than the idle capacity a verdict step reports. Lower is better. Not a cost figure.'
          }
          bar={wastagePct != null ? <ProportionBar pct={wastagePct} flag={wastageFlag} label={`Unused core time ${wastagePct}%`} /> : undefined}
        />
      </div>
    </Card>
  );
}
