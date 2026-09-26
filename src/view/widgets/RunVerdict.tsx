import { useState } from 'react';
import { ArrowRight, CheckIcon, ChevronDownIcon, ChevronUpIcon, CircleCheck, CircleX, CopyIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { formatDuration, typeTag } from '@sparkforensics/core/format-utils.ts';
import { computeWallClock } from '@sparkforensics/core/wall-clock.ts';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { useWidgetDensity } from '@/store/store';
import { REGISTRY } from '@/view/detector-registry';
import { useOptionalDocs } from '@/view/DocsContext';
import { docsHref } from '@/view/docs-href';
import { FAILURE_TYPES, quotesReasonOf, summarizeRunOutcome, type RunOutcome } from '@/view/run-outcome';
import { findingActionLabel } from '@/view/finding-action-label';
import { TAG_HELP } from '@/view/finding-tag-help';
import { TagBadge } from '@/view/ImpactBadge';
import {
  buildNextSteps,
  IDLE_NOTABLE_PCT,
  isIdleCapacityStep,
  NEXT_STEP_LIMIT,
  estimateProvenance,
  hasFinishedStage,
  isCleanRun,
  savingsMeaning,
  verdictIdlePct,
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

/** The run facts the verdict's wording depends on, read once. */
interface RunFacts {
  /** Wall-clock of the whole run, or null with no complete timing interval. */
  runMs: number | null;
  /** Allocated executor capacity that ran no task (`verdictIdlePct`). */
  idlePct: number | null;
  /** The log has no end-of-run record, so it covers only part of the run. */
  incomplete: boolean;
  /** No finding at all, ranked or not, no failed job, and nothing the log
   * lacked to run a check: the only state the verdict calls clean. */
  clean: boolean;
  outcome: RunOutcome;
  /** The log has stages but none recorded an end, so no stage check had
   * anything to measure. */
  noFinishedStages: boolean;
}

function isFailedRun(facts: RunFacts): boolean {
  return facts.outcome.failedJobs > 0;
}

/** The failed-run title: the one thing a newcomer must know before any
 * tuning advice is that the job did not finish. */
function failedTitle({ failedJobs, totalJobs }: RunOutcome): string {
  if (failedJobs < totalJobs) return `${failedJobs} of ${totalJobs} jobs failed in this run`;
  return totalJobs === 1 ? 'This run failed: its job did not finish' : `This run failed: all ${totalJobs} jobs did not finish`;
}

/** An action label as it reads after "Start here:": only its first letter
 * drops to lower case, so a name inside it ("Switch to Kryo") keeps its
 * capital, and a leading acronym ("GC", "OOM") is left alone. */
function lowerFirst(label: string): string {
  if (/^[A-Z]{2}/.test(label)) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function verdictTitle(eligible: Finding[], steps: NextStep[], facts: RunFacts): string {
  if (isFailedRun(facts)) return failedTitle(facts.outcome);
  if (eligible.length === 0 && facts.incomplete) return 'This log looks incomplete, so results cover only part of the run';
  if (eligible.length === 0 && facts.noFinishedStages) return 'This log has no finished stages to check';
  if (eligible.length === 0 && !facts.clean) return 'Nothing to fix, but some checks could not run on this log';
  if (eligible.length === 0) return 'No findings to fix right now.';
  // Every real detector writes a recommendation, so an eligible finding with
  // no route is a defensive case: still never call such a run clean.
  if (steps.length === 0) return `${plural(eligible.length, 'finding')} to review`;
  const lead = steps[0];
  if (isIdleCapacityStep(lead) && facts.idlePct != null) return `Start with cluster size: ${facts.idlePct}% of executor capacity sat idle`;
  if (lead.stageId != null) return `Start with Stage ${lead.stageId}`;
  return `Start here: ${lowerFirst(findingActionLabel(lead.lead.finding))}`;
}

/** The run-level summary under the title: how much was found and where, what
 * the first fix is worth, and the run's idle capacity when that is large
 * enough to matter but is not the first step (whose title already says it). */
function verdictSummary(eligible: Finding[], steps: NextStep[], facts: RunFacts): string[] {
  const sentences: string[] = [];
  const { failedJobs, totalJobs } = facts.outcome;
  if (failedJobs > 0) {
    if (eligible.some((finding) => !FAILURE_TYPES.has(finding.type))) {
      sentences.push('Fix the failure before tuning: the other findings cover only the work that ran.');
    }
  } else if (totalJobs > 0 && !facts.incomplete) {
    sentences.push(totalJobs === 1 ? 'Its one job succeeded.' : `All ${totalJobs} jobs succeeded.`);
  }
  if (eligible.length === 0) {
    if (failedJobs > 0) return sentences;
    if (facts.clean) sentences.push('Every check passed for this run.');
  } else if (steps.length === 0) {
    sentences.push('They are listed by impact under Findings.');
  } else {
    sentences.push(`${plural(eligible.length, 'finding')} in ${plural(steps.length, 'place')}.`);
    const wallClock = steps[0].lead.finding.impactEstimate?.wallClock;
    if (isIdleCapacityStep(steps[0])) {
      sentences.push('A smaller cluster or dynamic allocation would free the idle cores for other jobs.');
    } else if (wallClock && facts.runMs != null) {
      sentences.push(`The first fix could save up to ${formatDuration(wallClock.high)} of this ${formatDuration(facts.runMs)} run.`);
    }
    if (steps.some((step) => step.related.length > 0)) {
      sentences.push('Findings in the same stage usually share one cause, so they are grouped together and their savings overlap rather than add up.');
    }
  }
  if (facts.incomplete) {
    sentences.push('The log has no end-of-run record, so these figures cover only the part of the run it captured.');
  }
  const leadIsIdle = steps.length > 0 && isIdleCapacityStep(steps[0]);
  if (!leadIsIdle && facts.idlePct != null && facts.idlePct >= IDLE_NOTABLE_PCT) {
    sentences.push(
      steps.some(isIdleCapacityStep)
        ? `${facts.idlePct}% of the executor capacity sat idle, so the cluster may be larger than this job needs.`
        : `${facts.idlePct}% of the run's core time went unused, so the cluster may be larger than this job needs.`,
    );
  }
  return sentences;
}

const STACK_TRACE_HINT = 'Open the driver log only if you need the full stack trace.';

/** What the failure step whose reason the verdict quotes tells the reader:
 * the detector's "inspect the driver log for the reason" would send a
 * newcomer looking for something already on screen. The copied text carries
 * the reason itself, since "quoted above" means nothing once pasted. */
function quotedReasonText(reason: string): { shown: string; copied: string } {
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return {
    shown: `Spark's recorded reason is quoted above. ${STACK_TRACE_HINT}`,
    copied: `Spark's recorded reason: ${sentence} ${STACK_TRACE_HINT}`,
  };
}

/** One step as pasteable text: the action, what to try, and the savings. */
function stepCopyText(finding: Finding, recommendation: string, stageId: number | null = null): string {
  const impact = impactFigure(finding);
  const meaning = savingsMeaning(finding);
  const savings = impact && meaning ? `${impact} ${meaning}` : impact;
  const where = stageId != null ? ` in Stage ${stageId}` : '';
  const headline = `${findingActionLabel(finding)}${where}: ${recommendation}`;
  return [/[.!?]$/.test(headline) ? headline : `${headline}.`, savings ? `Potential savings: ${savings}` : null]
    .filter(Boolean)
    .join(' ');
}

/** The whole verdict as a pasteable checklist for a ticket or a message:
 * run, verdict, numbered steps (with their stage), and how many more places
 * the full list holds. */
function planCopyText(input: {
  runName: string | null;
  title: string;
  steps: { step: NextStep; recommendation: string }[];
  remaining: number;
}): string {
  const lines = [input.runName ? `Spark run ${input.runName}: ${input.title}` : input.title, ''];
  input.steps.forEach(({ step, recommendation }, index) => {
    lines.push(`${index + 1}. ${stepCopyText(step.lead.finding, recommendation, step.stageId)}`);
  });
  if (input.remaining > 0) lines.push('', `${plural(input.remaining, 'more place')} to look at in the full findings list.`);
  return lines.join('\n');
}

function CopyTextButton({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid={testId}
      onClick={() => {
        copyText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          // Clipboard access can fail (permissions, embed context); the steps
          // stay selectable, so no error state is needed.
          .catch(() => {});
      }}
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

function CopyStepButton({ finding, recommendation }: { finding: Finding; recommendation: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const summary = stepCopyText(finding, recommendation);
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

function NextStepItem({
  step,
  index,
  quotedReason,
  onRoute,
}: {
  step: NextStep;
  index: number;
  /** Spark's recorded reason when it is this step's own, else null. */
  quotedReason: string | null;
  onRoute: (target: TriageTarget) => void;
}) {
  const { openStage } = useStageDetail();
  const { finding } = step.lead;
  const quoted = quotedReason == null ? null : quotedReasonText(quotedReason);
  const recommendation = quoted?.shown ?? recommendationText(finding);
  const help = TAG_HELP[typeTag(finding.type)];
  const impact = impactFigure(finding);
  const meaning = savingsMeaning(finding);
  const titleId = `next-step-${index}-title`;
  const advanced = useWidgetDensity() === 'advanced';
  const provenance = advanced ? estimateProvenance(finding) : null;
  // Same rule every widget uses: only a marker other than high is shown.
  const confidence = advanced && finding.confidence && finding.confidence !== 'high' ? finding.confidence : null;
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
      <div className="min-w-0 flex-1 space-y-1.5 [overflow-wrap:anywhere]">
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
              {meaning ? <span className="font-sans"> {meaning}</span> : null}
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
          {recommendation}
        </p>
        {provenance || confidence ? (
          // Advanced view: how far to trust the step's number and the finding.
          <p className="text-xs text-muted-foreground" data-testid="next-step-provenance">
            {provenance ? (
              <>
                <span className="font-medium text-foreground">Estimate: </span>
                {provenance}
              </>
            ) : null}
            {confidence ? (
              <span title={typeof finding.validationRequired === 'string' ? finding.validationRequired : undefined}>
                {provenance ? ' ' : ''}
                {`${confidence[0].toUpperCase()}${confidence.slice(1)} confidence: verify before acting.`}
              </span>
            ) : null}
          </p>
        ) : null}
        {step.related.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Also flagged here: {step.related.map((f) => REGISTRY[f.type]?.findingLabel ?? f.type).join(', ')}. These
            often share this cause, so the same fix may clear them too.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant={index === 0 ? 'default' : 'outline'} data-shortcut-target onClick={() => onRoute(step.lead)}>
            Show evidence
            <ArrowRight aria-hidden="true" />
          </Button>
          {step.stageId != null ? (
            <Button size="sm" variant="ghost" onClick={() => openStage(step.stageId!)}>
              Stage {step.stageId} details
            </Button>
          ) : null}
          <CopyStepButton finding={finding} recommendation={quoted?.copied ?? recommendation} />
        </div>
      </div>
    </li>
  );
}

/** How the rest of the report is organized, relative so it works under any
 * published subpath (same rule as `findingGuideUrl`). */
const UNDERSTANDING_FINDINGS_URL = 'docs/user-guide/understanding-findings.html';

/** A collapsed primer on the handful of Spark terms every step leans on
 * (stage, task, executor, shuffle) and on how to read savings and colors.
 * Basic view only: an expert turning Advanced view on does not need it. */
function NewcomerPrimer() {
  const [open, setOpen] = useState(false);
  const docs = useOptionalDocs();
  return (
    <div className="text-sm">
      <button
        type="button"
        className="tap-target-comfortable inline-flex cursor-pointer items-center gap-1 rounded-sm text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-controls="newcomer-primer"
        onClick={() => setOpen((value) => !value)}
      >
        New to Spark tuning? How to read this report
        {open ? <ChevronUpIcon aria-hidden="true" className="size-4" /> : <ChevronDownIcon aria-hidden="true" className="size-4" />}
      </button>
      {open ? (
        <div id="newcomer-primer" className="mt-2 max-w-prose space-y-2 rounded-md border border-border bg-muted/40 p-3 text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Stages and tasks.</span> Spark splits each job into stages. A
            stage runs the same code as many tasks, one per slice (partition) of the data, and it finishes only when its
            slowest task does. Stage numbers match the Spark UI.
          </p>
          <p>
            <span className="font-medium text-foreground">Executors and cores.</span> Tasks run on executors, the
            worker processes of your cluster, one task per core at a time. Idle capacity is how much of those cores ran
            nothing.
          </p>
          <p>
            <span className="font-medium text-foreground">Shuffle.</span> Moving data between stages, for example for a
            join or a group-by. It is often the most expensive part of a job.
          </p>
          <p>
            <span className="font-medium text-foreground">Potential savings and colors.</span> A time figure, such as
            58.6s of run time, estimates how much sooner the run could finish; it is not a guarantee. A resource
            figure in core-hours (core-h) or gigabyte-hours of memory (GB-h) is cluster time a fix would free up: it
            cuts cost, but may not shorten the run. Red (critical), amber (warning) and blue (info) show how
            serious each finding is. When a finding shows a time-savings figure, its color usually follows that figure.
          </p>
          <a
            href={docsHref(UNDERSTANDING_FINDINGS_URL)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-primary underline-offset-4 hover:underline"
            onClick={(event) => {
              // Same passthrough as every other in-app docs link: a modified or
              // non-primary click keeps the browser's own new-tab behavior.
              if (!docs || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              docs.openSite(UNDERSTANDING_FINDINGS_URL);
            }}
          >
            What every finding means
          </a>
        </div>
      ) : null}
    </div>
  );
}

/** The run's verdict, first thing on the board: one sentence saying where to
 * start, a short summary, and the top places to look as ordered next steps,
 * each with a plain-language explanation, the concrete fix, and a route to its
 * evidence. The full, band-grouped finding list stays in the Findings tab. */
export function RunVerdict({ appModel, catalog, configFindings = [], onRoute }: RunVerdictProps) {
  const allFindings = [...catalog, ...configFindings];
  const eligible = allFindings.filter(isEligible);
  const outcome = summarizeRunOutcome(appModel.jobs, allFindings);
  const failed = outcome.failedJobs > 0;
  const steps = buildNextSteps(eligible, failed ? { failedJobStageIds: outcome.failedJobStageIds } : {});
  const facts: RunFacts = {
    runMs: hasCompleteApplicationInterval(appModel.app) ? computeWallClock(appModel.app, appModel.stages).total : null,
    idlePct: verdictIdlePct(steps, getScorecardEstimates(appModel).wastage.value),
    incomplete: catalog.some((finding) => finding.type === 'incompleteRun'),
    clean: isCleanRun(appModel, allFindings),
    outcome,
    noFinishedStages: !hasFinishedStage(appModel.stages),
  };
  const shown = steps.slice(0, NEXT_STEP_LIMIT);
  const remaining = steps.length - shown.length;
  const { clean } = facts;
  const density = useWidgetDensity();

  return (
    <section
      id="run-verdict"
      // Target of the dashboard's "Skip to the verdict" link.
      tabIndex={-1}
      aria-labelledby="run-verdict-title"
      data-testid="run-verdict"
      className={cn(
        'scroll-mt-20 space-y-4 rounded-xl border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5',
        clean ? 'border-clean/40' : failed ? 'border-critical/40' : 'border-border',
      )}
    >
      <div className="space-y-1">
        <h2
          id="run-verdict-title"
          className={cn('flex items-center gap-2 font-heading text-lg font-semibold', clean && 'text-clean', failed && 'text-critical')}
        >
          {clean ? <CircleCheck aria-hidden="true" className="size-5 shrink-0" /> : null}
          {failed ? <CircleX aria-hidden="true" className="size-5 shrink-0" /> : null}
          {verdictTitle(eligible, steps, facts)}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">{verdictSummary(eligible, steps, facts).join(' ')}</p>
        {outcome.reason ? (
          <p data-testid="run-failure-reason" className="max-w-prose pt-1 text-sm">
            <span className="font-medium">Spark's recorded reason: </span>
            <code className="font-mono text-xs [overflow-wrap:anywhere]">{outcome.reason}</code>
          </p>
        ) : null}
      </div>
      {density === 'advanced' ? null : <NewcomerPrimer />}
      {shown.length > 0 ? (
        <ol aria-label="Next steps" className="space-y-4">
          {shown.map((step, index) => (
            <NextStepItem
              key={step.key}
              step={step}
              index={index}
              quotedReason={quotesReasonOf(step.lead.finding, outcome) ? outcome.reason : null}
              onRoute={onRoute}
            />
          ))}
        </ol>
      ) : null}
      {shown.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {remaining > 0 ? (
            <p className="text-xs text-muted-foreground">
              {plural(remaining, 'more place')} to look at in the full list under Findings.
            </p>
          ) : (
            <span />
          )}
          <CopyTextButton
            label="Copy next steps"
            testId="copy-plan-button"
            text={planCopyText({
              runName: appModel.app?.name ?? null,
              title: verdictTitle(eligible, steps, facts),
              steps: shown.map((step) => ({
                step,
                recommendation: quotesReasonOf(step.lead.finding, outcome) && outcome.reason
                  ? quotedReasonText(outcome.reason).copied
                  : recommendationText(step.lead.finding),
              })),
              remaining,
            })}
          />
        </div>
      ) : null}
      {density === 'advanced' && shown.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          {failed
            ? 'Order: failures first, then by the high end of potential savings; impact band breaks ties.'
            : 'Order: by the high end of potential savings, quantified estimates before unquantified ones; impact band breaks ties.'}
        </p>
      ) : null}
    </section>
  );
}
