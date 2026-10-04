import { useMemo } from 'react';

import { cn } from '@/lib/utils';
import { useStore, type InterpretationState } from '@/store/store';
import type { ImpactBand, Stage } from '@sparkforensics/core/types.ts';
import { computeRunEndSec, formatRunClock, runClockTicks, runStartMs } from '@/view/charts/run-clock';
import { IMPACT_BG_CLASS, IMPACT_TEXT_CLASS } from '@/view/ImpactBadge';
import { findingAt, stepCodes } from '@/view/interpretation';
import { selectTimelineStages } from '@/view/widgets/Timeline';

/** Rows the strip shows before capping to the longest stages (step stages always stay). */
const STRIP_MAX_STAGES = 8;
const STRIP_MAX_TICKS = 6;
/** A bar narrower than this share of the run puts its step code beside it, not inside. */
const INSIDE_LABEL_MIN_PCT = 8;

interface StripStep {
  code: string;
  impactBand: ImpactBand;
}

interface StripRow {
  stage: Stage;
  leftPct: number;
  widthPct: number;
  step: StripStep | null;
}

const pct = (sec: number, runEndSec: number) => Math.max(0, Math.min(100, (sec / runEndSec) * 100));

/** The verdict's compact stage strip: the longest stages as bars on a run clock
 * (seconds from app start, 0 to the run's end), with each verdict step's stage in its status color and labelled
 * with its step code. Renders nothing when the run has no usable timing. */
export function VerdictStrip({ interpretation }: { interpretation: InterpretationState }) {
  const appModel = useStore((s) => s.appModel);
  const steps = interpretation.data.verdict.steps;

  const strip = useMemo(() => {
    const runEndSec = computeRunEndSec(appModel);
    const startMs = runStartMs(appModel);
    if (runEndSec == null || startMs == null) return null;

    const stepByStage = new Map<number, StripStep>();
    const { byStage } = stepCodes(interpretation);
    steps.forEach((step, i) => {
      const lead = findingAt(interpretation, step.leadIndex);
      if (step.stageId == null || !lead || byStage.get(step.stageId) !== `F${i + 1}`) return;
      stepByStage.set(step.stageId, { code: byStage.get(step.stageId)!, impactBand: lead.impactBand });
    });

    const timed = [...appModel.stages.values()].filter((s) => s.submittedAt && s.completedAt);
    const { stages: longest, total } = selectTimelineStages(timed, STRIP_MAX_STAGES);
    const shownIds = new Set(longest.map((s) => s.id));
    // A step's stage is always on the strip, even when it is not among the longest.
    const extra = timed.filter((s) => stepByStage.has(s.id) && !shownIds.has(s.id));
    const stages = [...longest, ...extra].sort((a, b) => a.submittedAt! - b.submittedAt!);
    if (stages.length === 0) return null;

    const rows: StripRow[] = stages.map((stage) => {
      const leftPct = pct((stage.submittedAt! - startMs) / 1000, runEndSec);
      const endPct = pct((stage.completedAt! - startMs) / 1000, runEndSec);
      return { stage, leftPct, widthPct: Math.max(endPct - leftPct, 0.5), step: stepByStage.get(stage.id) ?? null };
    });
    return { rows, runEndSec, total, ticks: runClockTicks(runEndSec, STRIP_MAX_TICKS) };
  }, [appModel, interpretation, steps]);

  if (!strip) return null;
  const { rows, runEndSec, total, ticks } = strip;
  const description = [
    `${rows.length === total ? `All ${total}` : `${rows.length} of ${total}`} stages on the run clock, ${formatRunClock(runEndSec)} total.`,
    ...rows
      .filter((row) => row.step)
      .map((row) => `Step ${row.step!.code}: Stage ${row.stage.id}, from ${formatRunClock((row.leftPct / 100) * runEndSec)} to ${formatRunClock(((row.leftPct + row.widthPct) / 100) * runEndSec)}.`),
  ].join(' ');

  return (
    <figure data-testid="verdict-strip" className="verdict-strip m-0" role="img" aria-label={description}>
      <div aria-hidden="true">
        {rows.map(({ stage, leftPct, widthPct, step }) => {
          const inside = widthPct >= INSIDE_LABEL_MIN_PCT;
          return (
            <div key={stage.id} className="verdict-strip__row" data-step-code={step?.code}>
              <span className={cn('truncate', step && 'text-foreground')}>stage {stage.id}</span>
              <div className="verdict-strip__lane">
                {ticks.slice(1, -1).map((t) => (
                  <i key={t} className="verdict-strip__grid" style={{ left: `${pct(t, runEndSec)}%` }} />
                ))}
                <div
                  className={cn('verdict-strip__bar', step ? IMPACT_BG_CLASS[step.impactBand] : 'verdict-strip__bar--neutral')}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                >
                  {step && inside ? <span className="verdict-strip__code verdict-strip__code--inside">{step.code}</span> : null}
                </div>
                {step && !inside ? (
                  <span
                    className={cn('verdict-strip__code', IMPACT_TEXT_CLASS[step.impactBand])}
                    // Beside the bar: to its right, or to its left when it ends near the run's end.
                    style={leftPct + widthPct < 88 ? { left: `calc(${leftPct + widthPct}% + 4px)` } : { right: `calc(${100 - leftPct}% + 4px)` }}
                  >
                    {step.code}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
        <div className="verdict-strip__axis">
          <span />
          <div>
            {ticks.map((t, i) => (
              <span
                key={t}
                style={
                  i === 0 ? { left: 0 } : i === ticks.length - 1 ? { right: 0 } : { left: `${pct(t, runEndSec)}%`, transform: 'translateX(-50%)' }
                }
              >
                {formatRunClock(t)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}
