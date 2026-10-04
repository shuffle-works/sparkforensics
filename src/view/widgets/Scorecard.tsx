import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { RunInterpretation, ScorecardFlag } from '@sparkforensics/core/run-interpretation.ts';
import type { WidgetProps } from '@/view/detector-registry';
import { IMPACT_BG_CLASS, ImpactDot } from '@/view/ImpactBadge';
import { useWidgetDensity } from '@/store/store';

// Run-info stats row: wall-clock, efficiency, unused core time (not problem
// counts, which live in RunVerdict and the Findings tab). Basic view
// captions say what each number measures and which direction is better, so
// Efficiency (a share of time) and Unused core time (a share of core-hours) never
// read as contradicting each other; Advanced view keeps the raw breakdowns.
// Every figure and flag comes from the run's interpretation (run-interpretation.ts).
export type ScorecardProps = Pick<WidgetProps, 'catalog'> & { interpretation: RunInterpretation };

type FlagImpactBand = ScorecardFlag;

// Gauge colors come from ImpactBadge.tsx's shared impact-band vocabulary
// (IMPACT_BG_CLASS), indexed by the tile's flag; a tile's flag is never
// 'info', so only the critical/warning entries are ever read here.

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

// Never a border on the tile itself: the grid's own `divide-x`/`divide-y`
// separators are border-left/border-top, and a tile claiming `border-l-*`
// would overwrite that separator on the same CSS property. The flag reads
// from the eyebrow's status dot and the gauge's status color instead.

function KpiTile({ eyebrow, value, meta, flag = null, bar, dataTestid }: KpiTileProps) {
  return (
    <div data-testid={dataTestid} data-flag={flag ?? undefined} className="flex flex-col px-4 py-3.5">
      {/* Signal-only color rule: only a flagged tile carries a status dot. */}
      <span className="trace-eyebrow flex items-center gap-1.5 tracking-[.06em]">
        {flag && <ImpactDot impactBand={flag} />}
        {eyebrow}
      </span>
      <div className="kpi-value mt-1 font-mono text-[1.875rem] leading-[1.2] font-semibold tracking-[-0.02em] tabular-nums">{value}</div>
      <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>
      {bar}
    </div>
  );
}

/** Efficiency/Unused core time's compact instrument: the metric's own percentage as a
 * fill width, colored by the tile's flag (or the healthy `clean` token when
 * unflagged) so severity reads pre-attentively instead of requiring the user
 * to read the number and the color separately. */
function ProportionBar({ pct, flag, label }: { pct: number; flag: FlagImpactBand; label: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div role="img" aria-label={label} className="mt-2.5 h-1.5 w-full overflow-hidden rounded-[1px] bg-chart-idle">
      <div className={cn('h-full rounded-[1px]', flag ? IMPACT_BG_CLASS[flag] : 'bg-clean')} style={{ width: `${clamped}%` }} />
    </div>
  );
}

/** Wall-clock's compact instrument: active stage time vs the rest of the run.
 * Neutral muted, never a status color: wall-clock is a measurement, not a grade. */
function ActiveIdleBar({ active, total }: { active: number; total: number }) {
  const activePct = total > 0 ? Math.max(0, Math.min(100, (active / total) * 100)) : 0;
  return (
    <div
      role="img"
      aria-label={`Active ${formatDuration(active)} of ${formatDuration(total)} total`}
      className="mt-2.5 flex h-1.5 w-full overflow-hidden rounded-[1px] bg-chart-idle"
    >
      <div className="h-full bg-muted-foreground" style={{ width: `${activePct}%` }} />
      <div className="h-full flex-1 bg-muted-foreground/35" />
    </div>
  );
}

// `formatDuration(0)` reads as '—' (its shared "no measurable value" glyph),
// which for stage-active time on a real run looks like broken/missing data
// rather than "nothing ran". Spell out the zero case instead of chaining
// into that glyph.
/** A figure in the tile's big mono type with its unit smaller and muted
 * ("17.2" + "s"); text that isn't a plain number-and-unit renders as is. */
function figureWithUnit(text: string): ReactNode {
  const match = /^(\d[\d.,]*)\s*([a-zA-Z%]+)$/.exec(text);
  return match ? (<>{match[1]}<small>{match[2]}</small></>) : text;
}

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

export function Scorecard({ interpretation, catalog }: ScorecardProps) {
  const density = useWidgetDensity();
  const { runShape, coverage, wallClock } = interpretation;
  if (runShape.wallClockMs == null) return <TimingUnavailableNotice />;

  const total = runShape.wallClockMs;
  const stagesActive = wallClock.stagesActive;
  // No stage recorded an end: "0%" would grade a run nothing measured (the
  // verdict says the stage checks had nothing to measure).
  const measured = !coverage.noFinishedStages;
  const efficiency = runShape.efficiencyPct;
  const effFlag = runShape.efficiencyFlag;

  const coldStart = catalog.find((f) => f.type === 'coldStart');

  const wastagePct = runShape.unusedCoreTimePct;
  const wastageFlag = runShape.unusedCoreTimeFlag;

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
          value={total > 0 ? figureWithUnit(formatDuration(total)) : '—'}
          meta={
            density === 'advanced' || stagesActive <= 0 ? (
              <>
                {formatRanLabel(stagesActive)}
                {coldStart ? ` · ${coldStart.value}s cold start` : ''}
              </>
            ) : (
              'Total run time.'
            )
          }
          bar={<ActiveIdleBar active={stagesActive} total={total} />}
        />
        <KpiTile
          eyebrow="Efficiency"
          dataTestid="kpi-efficiency"
          value={!measured ? <span className="text-base">Not measured</span> : efficiency == null ? <span className="text-base">Unavailable</span> : (<>{efficiency}<small>%</small></>)}
          flag={effFlag}
          meta={
            !measured
              ? 'No stage in this log recorded an end, so there is no stage time to measure.'
              : efficiency == null
              ? 'This run has no complete application timing interval.'
              : density !== 'advanced'
                ? `Share of the run with a stage running (${formatDuration(stagesActive)}). Higher is better.`
                : total > stagesActive
                  ? `${formatRanLabel(stagesActive)} · ${formatDuration(total - stagesActive)} idle/gap time`
                  : 'executors active the whole run'
          }
          bar={efficiency != null ? <ProportionBar pct={efficiency} flag={effFlag} label={`Efficiency ${efficiency}%`} /> : undefined}
        />
        <KpiTile
          eyebrow="Unused core time"
          dataTestid="kpi-wastage"
          value={wastagePct == null ? <span className="text-base">Unavailable</span> : (<>{wastagePct}<small>%</small></>)}
          flag={wastageFlag}
          meta={
            runShape.unusedCoreTimeUnavailableReason === 'application-timing'
              ? 'Unused core time needs complete application timing.'
              : runShape.unusedCoreTimeUnavailableReason === 'core-usage-summary'
                ? 'Unused core time needs the core-usage summary.'
                : runShape.unusedCoreTimeUnavailableReason === 'executor-capacity'
                  ? 'Unused core time needs usable executor-capacity data.'
                  : density === 'advanced'
                    ? 'Driver-idle + executor-slack core-hours as a share of available capacity. Directional, not a cost figure.'
                    : 'Share of executor core time that ran no task. Lower is better. Not a cost figure.'
          }
          bar={wastagePct != null ? <ProportionBar pct={wastagePct} flag={wastageFlag} label={`Unused core time ${wastagePct}%`} /> : undefined}
        />
      </div>
    </Card>
  );
}
