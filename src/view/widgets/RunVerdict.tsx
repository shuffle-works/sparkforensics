import { useState } from 'react';
import { ArrowRight, CheckIcon, ChevronDownIcon, ChevronUpIcon, CircleCheck, CircleX, CopyIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import type { InterpretedStep } from '@sparkforensics/core/run-interpretation.ts';
import type { Finding } from '@sparkforensics/core/types.ts';
import { useStore, useWidgetDensity, type InterpretationState } from '@/store/store';
import { findingName, recommendationParts } from '@sparkforensics/core/finding-names.ts';
import { useOptionalDocs } from '@/view/DocsContext';
import { findingActionLabel } from '@sparkforensics/core/finding-action-label.ts';
import { TagBadge } from '@/view/ImpactBadge';
import { findingAt, savingsOf } from '@/view/interpretation';
import { useStageDetail } from '@/view/StageDetailContext';
import { triageTargetFor, type TriageTarget } from '@/view/triage-target';

export interface RunVerdictProps {
  /** The run's interpretation: the verdict describes the whole run, never the
   * current filter, and is rendered as computed (see run-interpretation.ts). */
  interpretation: InterpretationState;
  onRoute: (target: TriageTarget) => void;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
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

function CopyStepButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await copyText(text);
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
  finding,
  interpretation,
  index,
  onRoute,
}: {
  step: InterpretedStep;
  /** The step's lead finding, resolved from `step.leadIndex`. */
  finding: Finding;
  interpretation: InterpretationState;
  index: number;
  onRoute: (target: TriageTarget) => void;
}) {
  const { openStage } = useStageDetail();
  const { measured, fix } = recommendationParts(step.recommendation);
  const savings = savingsOf(interpretation, finding);
  const impact = savings?.figure ?? null;
  const meaning = savings?.meaning ?? null;
  const titleId = `next-step-${index}-title`;
  const advanced = useWidgetDensity() === 'advanced';
  const provenance = advanced ? (savings?.provenance ?? null) : null;
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
        {measured ? (
          <p className="text-sm">
            <span className="font-medium">What's happening: </span>
            {measured}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">What to try: </span>
          {fix}
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
        {step.relatedTypes.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Also flagged here, likely the same cause: {step.relatedTypes.map(findingName).join(', ')}.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant={index === 0 ? 'default' : 'outline'} data-shortcut-target onClick={() => {
            // Every step lead passed the same routeable check, so the target is never null.
            const target = triageTargetFor(finding);
            if (target) onRoute(target);
          }}>
            Show evidence
            <ArrowRight aria-hidden="true" />
          </Button>
          {step.stageId != null ? (
            <Button size="sm" variant="ghost" onClick={() => openStage(step.stageId!)}>
              Stage {step.stageId} details
            </Button>
          ) : null}
          <CopyStepButton text={step.copyText} />
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
  const exportMode = useStore((s) => s.exportMode);
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
          {/* An exported dashboard carries no docs, so it drops the pointer to them. */}
          {!exportMode ? (
            <a
              href={UNDERSTANDING_FINDINGS_URL}
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
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The run's verdict, first thing on the board: one sentence saying where to
 * start, a short summary, and the top places to look as ordered next steps,
 * each with a plain-language explanation, the concrete fix, and a route to its
 * evidence. The full, band-grouped finding list stays in the Findings tab. */
export function RunVerdict({ interpretation, onRoute }: RunVerdictProps) {
  const { title, summary, failed, clean, failureReason, remaining, copyText } = interpretation.data.verdict;
  const shown = interpretation.data.verdict.steps
    .map((step) => ({ step, finding: findingAt(interpretation, step.leadIndex) }))
    .filter((entry): entry is { step: InterpretedStep; finding: Finding } => entry.finding != null);
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
          {title}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">{summary.join(' ')}</p>
        {failureReason ? (
          <p data-testid="run-failure-reason" className="max-w-prose pt-1 text-sm">
            <span className="font-medium">Spark's recorded reason: </span>
            <code className="font-mono text-xs [overflow-wrap:anywhere]">{failureReason}</code>
          </p>
        ) : null}
      </div>
      {density === 'advanced' ? null : <NewcomerPrimer />}
      {shown.length > 0 ? (
        <ol aria-label="Next steps" className="space-y-4">
          {shown.map(({ step, finding }, index) => (
            <NextStepItem
              key={step.key}
              step={step}
              finding={finding}
              interpretation={interpretation}
              index={index}
              onRoute={onRoute}
            />
          ))}
        </ol>
      ) : null}
      {shown.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {remaining > 0 ? (
            <p className="text-xs text-muted-foreground">
              {plural(remaining, 'more place')} under Findings.
            </p>
          ) : (
            <span />
          )}
          <CopyTextButton
            label="Copy next steps"
            testId="copy-plan-button"
            text={copyText ?? ''}
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
