import { useState } from 'react';
import { ArrowRight, CheckIcon, CircleCheck, CopyIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { formatDuration, typeTag } from '@sparkforensics/core/format-utils.ts';
import { computeWallClock } from '@sparkforensics/core/wall-clock.ts';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { REGISTRY } from '@/view/detector-registry';
import { findingActionLabel } from '@/view/finding-action-label';
import { TAG_HELP } from '@/view/finding-tag-help';
import { TagBadge } from '@/view/ImpactBadge';
import {
  buildNextSteps,
  IDLE_NOTABLE_PCT,
  isIdleCapacityStep,
  NEXT_STEP_LIMIT,
  prioritizeIdleCapacity,
  type NextStep,
} from '@/view/run-verdict';
import { useStageDetail } from '@/view/StageDetailContext';
import type { TriageTarget } from '@/view/triage-target';
import { impactFigure, isEligible, recommendationText } from '@/view/widgets/FixTheseFirst';
import { getScorecardEstimates, hasCompleteApplicationInterval } from '@/view/widgets/scorecard-estimates';

export interface RunVerdictProps {
  appModel: AppModel;
  /** The full, unfiltered catalog: the verdict describes the run, not the
   * current filter. */
  catalog: Finding[];
  configFindings?: Finding[];
  onRoute: (target: TriageTarget) => void;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A savings figure worth printing: a raw-waste figure that rounds to zero
 * ("0.0 core-h") reads as a broken number, so it is dropped. */
function visibleImpact(finding: Finding): string | null {
  const rawWaste = finding.impactEstimate?.rawWaste;
  if (!finding.impactEstimate?.wallClock && rawWaste && Math.round(rawWaste.value * 10) === 0) return null;
  return impactFigure(finding);
}

/** The run facts the verdict's wording depends on, read once. */
interface RunFacts {
  /** Wall-clock of the whole run, or null with no complete timing interval. */
  runMs: number | null;
  /** The Scorecard's Wastage figure: allocated executor capacity that ran no task. */
  idlePct: number | null;
}

function verdictTitle(eligible: Finding[], steps: NextStep[], facts: RunFacts): string {
  if (eligible.length === 0) return 'No findings to fix right now.';
  // Every real detector writes a recommendation, so an eligible finding with
  // no route is a defensive case: still never call such a run clean.
  if (steps.length === 0) return `${plural(eligible.length, 'finding')} to review`;
  const lead = steps[0];
  if (isIdleCapacityStep(lead) && facts.idlePct != null) return `Start with cluster size: ${facts.idlePct}% of executor capacity sat idle`;
  if (lead.stageId != null) return `Start with Stage ${lead.stageId}`;
  return `Start here: ${findingActionLabel(lead.lead.finding).toLowerCase()}`;
}

/** The run-level summary under the title: how much was found and where, what
 * the first fix is worth, and the run's idle capacity when that is large
 * enough to matter but did not lead (the title already says it when it did). */
function verdictSummary(eligible: Finding[], steps: NextStep[], facts: RunFacts): string[] {
  const sentences: string[] = [];
  if (eligible.length === 0) {
    sentences.push('Every check passed for this run.');
  } else if (steps.length === 0) {
    sentences.push('They are listed by impact under Findings.');
  } else {
    sentences.push(`${plural(eligible.length, 'finding')} in ${plural(steps.length, 'place')}.`);
    const wallClock = steps[0].lead.finding.impactEstimate?.wallClock;
    if (isIdleCapacityStep(steps[0])) {
      sentences.push('Most of the cores this run held did no work, so a smaller cluster or dynamic allocation would free them for other jobs.');
    } else if (wallClock && facts.runMs != null) {
      sentences.push(`The first fix could save up to ${formatDuration(wallClock.high)} of this ${formatDuration(facts.runMs)} run.`);
    }
    if (steps.some((step) => step.related.length > 0)) {
      sentences.push('Findings in the same stage usually share one cause, so they are grouped together and their savings overlap rather than add up.');
    }
  }
  const leadIsIdle = steps.length > 0 && isIdleCapacityStep(steps[0]);
  if (!leadIsIdle && facts.idlePct != null && facts.idlePct >= IDLE_NOTABLE_PCT) {
    sentences.push(`${facts.idlePct}% of the executor capacity sat idle, so the cluster may be larger than this job needs.`);
  }
  return sentences;
}

function CopyStepButton({ finding }: { finding: Finding }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const impact = visibleImpact(finding);
    const headline = `${findingActionLabel(finding)}: ${recommendationText(finding)}`;
    const summary = [/[.!?]$/.test(headline) ? headline : `${headline}.`, impact ? `Potential savings: ${impact}` : null]
      .filter(Boolean)
      .join(' ');
    try {
      await copyText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions, embed context); the step text
      // stays selectable, so no error state is needed.
    }
  };
  return (
    <Button variant="ghost" size="sm" data-testid="copy-finding-button" onClick={() => void handleCopy()}>
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function NextStepItem({ step, index, onRoute }: { step: NextStep; index: number; onRoute: (target: TriageTarget) => void }) {
  const { openStage } = useStageDetail();
  const { finding } = step.lead;
  const help = TAG_HELP[typeTag(finding.type)];
  const impact = visibleImpact(finding);
  const titleId = `next-step-${index}-title`;
  return (
    <li className="flex gap-3" data-testid="next-step" aria-labelledby={titleId}>
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
          index === 0 ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
        )}
      >
        {index + 1}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <TagBadge type={finding.type} impactBand={finding.impactBand} docAnchor={finding.docAnchor} />
          <h3 id={titleId} className="text-sm font-semibold">
            {findingActionLabel(finding)}
            {step.stageId != null ? <span className="font-normal text-muted-foreground"> in Stage {step.stageId}</span> : null}
          </h3>
          {impact ? (
            <span className="font-mono text-xs text-muted-foreground tabular-nums sm:ml-auto">
              <span className="font-sans">Potential savings </span>
              <span className="font-semibold text-foreground">{impact}</span>
            </span>
          ) : null}
        </div>
        {help ? (
          <p className="text-sm">
            <span className="font-medium">What's happening: </span>
            {help.description}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">What to try: </span>
          {recommendationText(finding)}
        </p>
        {step.related.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Also flagged here: {step.related.map((f) => REGISTRY[f.type]?.findingLabel ?? f.type).join(', ')}. These
            often share this cause, so the same fix may clear them too.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant={index === 0 ? 'default' : 'outline'} onClick={() => onRoute(step.lead)}>
            Show evidence
            <ArrowRight aria-hidden="true" />
          </Button>
          {step.stageId != null ? (
            <Button size="sm" variant="ghost" onClick={() => openStage(step.stageId!)}>
              Stage {step.stageId} details
            </Button>
          ) : null}
          <CopyStepButton finding={finding} />
        </div>
      </div>
    </li>
  );
}

/** The run's verdict, first thing on the board: one sentence saying where to
 * start, a short summary, and the top places to look as ordered next steps,
 * each with a plain-language explanation, the concrete fix, and a route to its
 * evidence. The full, band-grouped finding list stays in the Findings tab. */
export function RunVerdict({ appModel, catalog, configFindings = [], onRoute }: RunVerdictProps) {
  const eligible = [...catalog, ...configFindings].filter(isEligible);
  const facts: RunFacts = {
    runMs: hasCompleteApplicationInterval(appModel.app) ? computeWallClock(appModel.app, appModel.stages).total : null,
    idlePct: getScorecardEstimates(appModel).wastage.value,
  };
  const steps = prioritizeIdleCapacity(buildNextSteps(eligible), facts.idlePct, facts.runMs);
  const shown = steps.slice(0, NEXT_STEP_LIMIT);
  const remaining = steps.length - shown.length;
  const clean = eligible.length === 0;

  return (
    <section
      aria-labelledby="run-verdict-title"
      data-testid="run-verdict"
      className={cn('space-y-4 rounded-xl border bg-card p-4 sm:p-5', clean ? 'border-clean/40' : 'border-border')}
    >
      <div className="space-y-1">
        <h2 id="run-verdict-title" className={cn('flex items-center gap-2 font-heading text-lg font-semibold', clean && 'text-clean')}>
          {clean ? <CircleCheck aria-hidden="true" className="size-5 shrink-0" /> : null}
          {verdictTitle(eligible, steps, facts)}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">{verdictSummary(eligible, steps, facts).join(' ')}</p>
      </div>
      {shown.length > 0 ? (
        <ol aria-label="Next steps" className="space-y-4">
          {shown.map((step, index) => (
            <NextStepItem key={step.key} step={step} index={index} onRoute={onRoute} />
          ))}
        </ol>
      ) : null}
      {remaining > 0 ? (
        <p className="text-xs text-muted-foreground">
          {plural(remaining, 'more place')} to look at in the full list under Findings.
        </p>
      ) : null}
    </section>
  );
}
