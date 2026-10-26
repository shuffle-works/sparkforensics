import { ArrowRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { findingActionLabel } from '@sparkforensics/core/finding-action-label.ts';
import { TagBadge } from '@/view/ImpactBadge';
import { findingAt, savingsOf, useInterpretation } from '@/view/interpretation';
import { emptySelection, matchesFilter } from '@/view/finding-filter';
import { selectTriageTargetForFinding, type TriageTarget } from '@/view/triage-target';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { recommendationParts } from '@sparkforensics/core/finding-names.ts';
import { formatDuration, IMPACT_BAND_ORDER } from '@sparkforensics/core/format-utils.ts';
import type { Finding, ImpactBand, Stage } from '@sparkforensics/core/types.ts';

interface RecEntry {
  extended: string | null;
}

/** Groups a stage's findings by `type`, one chip per type with its distinct
 * recommendations underneath, in the order the run's interpretation gives
 * (`typeOrder`: the stage's own verdict step, so "start with the first" agrees
 * with the run verdict, then worst band). Tracks the worst-impact-band finding
 * itself (not just its band) so the compact chip and expanded
 * `<ImpactEstimate>` reuse the finding that drove the displayed band. */
function groupFindingsByType(
  findings: Finding[],
  typeOrder: string[],
): [string, { impactBand: ImpactBand; finding: Finding; recs: Map<string, RecEntry> }][] {
  const groups = new Map<string, { impactBand: ImpactBand; finding: Finding; recs: Map<string, RecEntry> }>();
  for (const f of findings) {
    if (!groups.has(f.type)) groups.set(f.type, { impactBand: f.impactBand, finding: f, recs: new Map() });
    const g = groups.get(f.type)!;
    if (IMPACT_BAND_ORDER[f.impactBand] < IMPACT_BAND_ORDER[g.impactBand]) {
      g.impactBand = f.impactBand;
      g.finding = f;
    }
    if (f.recommendation && !g.recs.has(f.recommendation)) {
      g.recs.set(f.recommendation, {
        extended: f.type === 'retryWaste' ? f.extended ?? null : null,
      });
    }
  }
  const rank = (type: string) => (typeOrder.includes(type) ? typeOrder.indexOf(type) : typeOrder.length);
  return [...groups.entries()].sort(([aType], [bType]) => rank(aType) - rank(bType));
}

/** One finding-type's recommendation line, plus its extended text and impact
 * estimate, all shown unconditionally: no disclosure to open. */
function RecommendationRow({
  rec,
  extended,
  finding,
  showImpactEstimate,
  className,
}: {
  rec: string;
  extended: string | null;
  finding: Finding;
  showImpactEstimate: boolean;
  className?: string;
}) {
  const { measured, fix } = recommendationParts(rec);
  return (
    <div className={cn('space-y-para text-sm', className)}>
      {measured ? <p className="max-w-full leading-normal break-words"><span className="font-medium">What's happening: </span>{measured}</p> : null}
      <p className="max-w-full leading-normal break-words">
        <span className="font-medium">What to try: </span>
        {fix}
      </p>
      {extended ? <p className="text-xs text-muted-foreground">{extended}</p> : null}
      {showImpactEstimate ? <ImpactEstimate finding={finding} /> : null}
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** One plain sentence placing the stage in the run: how long it ran, what
 * share of the run that was, how many tasks it split into, and how many
 * findings it carries. */
function stageSummary(stage: Stage, runMs: number | null, findingTypes: number, hiddenNotes: number): string {
  const duration = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
  const parts: string[] = [];
  if (duration > 0) {
    const share = runMs != null && runMs > 0 ? Math.round((duration / runMs) * 100) : null;
    parts.push(`Ran for ${formatDuration(duration)}${share != null ? `, ${share}% of this ${formatDuration(runMs!)} run` : ''}`);
  }
  if ((stage.taskCount ?? 0) > 0) parts.push(`split into ${plural(stage.taskCount!, 'task')}`);
  const lead = parts.length > 0 ? `${parts.join(', ')}.` : '';
  const hidden = hiddenNotes > 0 ? `${plural(hiddenNotes, 'info note')} hidden.` : '';
  const found =
    findingTypes === 0
      ? (hidden ? '' : 'Nothing was flagged on this stage.')
      : findingTypes === 1
        ? '1 finding here.'
        : `${findingTypes} findings here. They often share one cause, so start with the first.`;
  return [lead, found, hidden].filter(Boolean).join(' ');
}

export interface StageFindingsProps {
  stage: Stage;
  catalog: Finding[];
  /** Lists info findings too, as the dashboard does once its filter selects the
   * info band. Off by default: info findings are counted as hidden notes. */
  showInfo: boolean;
  /** Adds a Show evidence button per finding type. Omitted where there is no
   * board to route to. */
  onShowEvidence?: (target: TriageTarget) => void;
}

/** "Why was this stage flagged": the stage's place in the run, then every
 * finding for it grouped by type, each read like a verdict step: what to do,
 * what it measured, what to try, what it could save, and
 * a route to its evidence on the board. Shared by the stage detail dialog and
 * the plan graph's stage panel so the text cannot drift between them. */
export function StageFindings({ stage, catalog, showInfo, onShowEvidence }: StageFindingsProps) {
  const interpretation = useInterpretation();
  // Same stage rule the verdict groups its steps by, so a sql-scope finding
  // that touches only this stage (stageIds: [id]) is listed here too.
  const stageFindings = interpretation?.data.stages[String(stage.id)];
  const stageCatalog = interpretation && stageFindings
    ? stageFindings.findingIndexes.map((index) => findingAt(interpretation, index)).filter((f): f is Finding => f != null)
    : [];
  const findings = showInfo ? stageCatalog : stageCatalog.filter((f) => matchesFilter(f, emptySelection()));
  const groups = groupFindingsByType(findings, stageFindings?.typeOrder ?? []);
  const runMs = interpretation?.data.runShape.wallClockMs ?? null;

  return (
    <section aria-label="Why this stage was flagged" className="space-y-3">
      <p className="text-sm text-muted-foreground">{stageSummary(stage, runMs, groups.length, stageCatalog.length - findings.length)}</p>
      {groups.length > 0 ? (
        <ol className="divide-y rounded-md border px-3">
          {groups.map(([type, { impactBand, finding, recs }]) => {
            // Gate on the compact formatter, not the mere presence of `impactEstimate`:
            // an informational estimate has the field but `<ImpactEstimate>` renders
            // nothing for it, which would leave an empty gap below the recommendation.
            const hasEstimate = savingsOf(interpretation, finding)?.compact != null;
            const target = onShowEvidence ? selectTriageTargetForFinding(finding, catalog) : null;
            return (
              <li key={type} className="space-y-3 py-3" data-testid="stage-finding">
                <div className="flex flex-wrap items-center gap-2">
                  <TagBadge type={type} impactBand={impactBand} />
                  <h3 className="text-sm font-semibold">{findingActionLabel(finding)}</h3>
                </div>
                {[...recs.entries()].map(([rec, { extended }], i) => (
                  <RecommendationRow
                    key={i}
                    className={i > 0 ? 'border-t pt-3' : undefined}
                    rec={rec}
                    extended={extended}
                    finding={finding}
                    // Per-type figure: show only once, on the first recommendation.
                    showImpactEstimate={i === 0 && hasEstimate}
                  />
                ))}
                {target && onShowEvidence ? (
                  <Button size="sm" variant="outline" onClick={() => onShowEvidence(target)}>
                    Show evidence
                    <ArrowRight aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
