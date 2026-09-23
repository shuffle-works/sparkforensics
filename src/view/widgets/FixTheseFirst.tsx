import { useState } from 'react';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, TargetIcon } from 'lucide-react';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { buildRecommendationRollup, isEligible as coreIsEligible, rankFindings, type RollupGroup } from '@sparkforensics/core/recommendation-rollup.ts';
import { coreFindingGenericRecommendation } from '@sparkforensics/core/finding-generic-recommendation.ts';
import { TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { sharedDocAnchor } from '@sparkforensics/core/docs-config.ts';
import { copyText } from '@/lib/clipboard';
import { formatStageIdsLabel, pathBasename } from '@sparkforensics/core/format-utils.ts';
import { REGISTRY } from '@/view/detector-registry';
import { findingActionLabel } from '@/view/finding-action-label';
import { TagBadge } from '@/view/ImpactBadge';
import { StagePill, StagePillGroup } from '@/view/StagePill';
import { formatRawWaste, formatWallClockRange } from '@/view/ImpactEstimate';
import { RowPagination } from '@/view/RowPagination';
import { selectTriageTarget, selectTriageTargetForFinding, type TriageTarget } from '@/view/triage-target';

const PAGE_SIZE = 10;

// Wraps the core `isEligible` with the one check that module can't do itself:
// `REGISTRY` lives in a `.tsx` file, not importable from core.
export function isEligible(finding: Finding): boolean {
  return coreIsEligible(finding) && REGISTRY[finding.type] != null;
}

/** A group's representative impact band: the same finding whose band
 * TypeGroupRow's badge already shows (the highest-impact-tier member, not
 * necessarily the group's worst band). Shared with ImpactBoard.tsx so
 * a group lands in the same band its own badge color would suggest. */
export function groupImpactBand(group: RollupGroup): Finding['impactBand'] {
  return rankFindings(group.findings)[0].impactBand;
}

/** The row's one-line impact figure: the wall-clock range for a time-based
 * finding, the raw resource figure for a `resourceOnly` one, or nothing for a
 * purely informational estimate. Reuses `ImpactEstimate.tsx`'s formatters so
 * the units/rounding match every other surface. */
function impactFigure(finding: Finding): string | null {
  const estimate = finding.impactEstimate;
  if (!estimate) return null;
  if (estimate.wallClock) return formatWallClockRange(estimate.wallClock.low, estimate.wallClock.high);
  if (estimate.rawWaste) return formatRawWaste(estimate.rawWaste);
  return null;
}

/** A short per-row location tag, abbreviated ("St." not "Stage") to fit the
 * compact row's right-aligned monospace figure. Falls back through the location
 * keys a Finding can carry: a per-stage detector sets `stageId`; a sql-scope one
 * sets `stageIds`; a config-scope one sets `property`; app-level findings have
 * no location. */
function locationTag(finding: Finding): string | null {
  const stageLabel = finding.stageId != null
    ? `St.${finding.stageId}`
    : finding.stageIds && finding.stageIds.length > 0
      ? `St.${formatStageIdsLabel(finding.stageIds)}`
      : null;

  // Two distinct duplicate-subtree groups can touch the same stage set with the
  // same root operator name, so stage + root name isn't unique; fold in
  // `duplicateSubtreeIdentity`'s groupIndex+executionId suffix to disambiguate.
  if (finding.type === 'duplicatePlanSubtree' && finding.rootName != null) {
    const identity = duplicateSubtreeIdentity(finding);
    return stageLabel && identity ? `${stageLabel} · ${identity}` : (identity ?? stageLabel);
  }

  if (stageLabel) return stageLabel;
  if (finding.property) return String(finding.property);
  return null;
}

/** duplicatePlanSubtree's disambiguator (root operator + groupIndex, no stage
 * list): the load-bearing identity a `StagePillGroup` alone can't show.
 * `groupIndex` alone isn't enough across the whole-run rollup: it resets to 0
 * per SQL execution, so two executions can each produce "the 2nd Filter group"
 * with the same `rootName`+`groupIndex` despite disjoint stage sets. Folding in
 * `executionId` keeps the label unique, the same way `findingId()` does. */
function duplicateSubtreeIdentity(finding: Finding): string | null {
  if (finding.type !== 'duplicatePlanSubtree' || finding.rootName == null) return null;
  const root = pathBasename(finding.rootName);
  const numbered = finding.groupIndex != null ? `${root} #${Number(finding.groupIndex) + 1}` : root;
  return finding.executionId != null ? `${numbered} (SQL ${finding.executionId})` : numbered;
}

/** A finding's location as a clickable pill (`StagePill`), or a `StagePillGroup`
 * when `stageIds` names more than one. For duplicatePlanSubtree, its
 * root-operator/groupIndex identity renders as trailing text next to the
 * pills; with `stackIdentity`, it instead leads on its own row above a
 * de-emphasized pill row (`stagePillClassName`), since the identity is the
 * more useful signal there and the pills are supporting detail. A
 * config-scope `property` (or no location) stays `locationTag`'s plain text. */
function LocationBadge({
  finding,
  textClassName,
  visibleLimit,
  stackIdentity,
  stagePillClassName,
}: {
  finding: Finding;
  textClassName?: string;
  visibleLimit?: number;
  stackIdentity?: boolean;
  stagePillClassName?: string;
}) {
  const { stageId, stageIds } = finding;
  if (stageId != null) return <StagePill stageId={stageId} />;
  if (stageIds && stageIds.length > 0) {
    const identity = duplicateSubtreeIdentity(finding);
    const identityEl = identity ? (
      <span className={cn('truncate', textClassName)} title={identity}>
        {identity}
      </span>
    ) : null;
    const pillsEl = (
      <StagePillGroup
        pills={stageIds.map((id) => ({ id }))}
        visibleLimit={visibleLimit}
        pillOverrideClassName={stackIdentity ? stagePillClassName : undefined}
      />
    );
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-1.5', stackIdentity ? 'flex-col' : 'flex-wrap')}>
        {stackIdentity ? (
          <>
            {identityEl}
            {pillsEl}
          </>
        ) : (
          <>
            {pillsEl}
            {identityEl}
          </>
        )}
      </span>
    );
  }
  const text = locationTag(finding);
  return text ? (
    <span className={cn('min-w-0 truncate', textClassName)} title={text}>
      {text}
    </span>
  ) : null;
}

/** Falls back to the registry's finding label when a finding somehow reaches
 * here with no `recommendation` text (every real detector sets one; this is
 * a defensive floor, not an expected path, since `Finding.recommendation` is
 * optional on the type). */
function recommendationText(finding: Finding): string {
  const text = typeof finding.recommendation === 'string' ? finding.recommendation.trim() : '';
  if (text) return text;
  return REGISTRY[finding.type]?.findingLabel ?? finding.type;
}

/** A single-finding row: the finding's tag badge, a short action label (bold)
 * over the full recommendation sentence (muted) as the navigate control, and a
 * right-aligned monospace stage/impact figure. */
export function FindingRow({
  finding,
  allFindings,
  onRoute,
}: {
  finding: Finding;
  allFindings: Finding[];
  onRoute: (target: TriageTarget) => void;
}) {
  const target = selectTriageTargetForFinding(finding, allFindings);
  const location = locationTag(finding);
  const impact = impactFigure(finding);
  const text = recommendationText(finding);
  const label = findingActionLabel(finding);
  return (
    <TableRow data-testid="fix-these-first-row" data-finding-type={finding.type}>
      <TableCell className="w-px">
        <TagBadge type={finding.type} impactBand={finding.impactBand} docAnchor={finding.docAnchor} />
      </TableCell>
      <TableCell className="whitespace-normal">
        <button
          type="button"
          className="cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => target && onRoute(target)}
        >
          <span className="block text-sm font-medium">{label}</span>
          <span className="block text-xs text-muted-foreground">{text}</span>
        </button>
      </TableCell>
      {/* flex, not one joined string: as one truncated nowrap string, the
          right-side truncation would hide the important impact figure first.
          Impact keeps `shrink-0` so it stays fully visible; the plain-text
          location fallback is the one that gives way. */}
      <TableCell className="w-px text-right font-mono text-xs text-muted-foreground" title={[location, impact].filter(Boolean).join(' · ')}>
        <span className="flex items-center justify-end gap-1.5">
          <LocationBadge finding={finding} />
          {impact ? <span className="shrink-0">{impact}</span> : null}
        </span>
      </TableCell>
    </TableRow>
  );
}

/** One row inside an expanded group's paginated list. The tag and action label
 * are identical for every group member and already sit on the header row, so
 * this row omits them. `colSpan` folds the badge column into the content cell so
 * the trailing figure still lands in the table's third column, lined up with the
 * header. What varies member to member is the location and the recommendation's
 * embedded specifics, so this row leads with the location tag (action label only
 * when there's no location) and keeps the recommendation truncated to one line. */
function FindingInstanceRow({
  finding,
  allFindings,
  onRoute,
  id,
}: {
  finding: Finding;
  allFindings: Finding[];
  onRoute: (target: TriageTarget) => void;
  /** Set only on the first row of an expanded group (see `TypeGroupRow`):
   * the anchor the group's disclosure button's `aria-controls` points at,
   * since a `<tr>` list has no single wrapping element to hang one id on. */
  id?: string;
}) {
  const target = selectTriageTargetForFinding(finding, allFindings);
  const location = locationTag(finding);
  const impact = impactFigure(finding);
  const text = recommendationText(finding);
  const label = findingActionLabel(finding);
  // A `StagePill` is its own clickable control, so it can't nest inside the
  // row's navigate button (invalid HTML, fighting click handlers): it renders as
  // its own line above the button, which then carries the action label only when
  // no location line takes that role.
  const hasLocation = finding.stageId != null || location != null;
  return (
    <TableRow id={id} data-testid="fix-these-first-row" data-finding-type={finding.type} className="bg-muted/50">
      <TableCell colSpan={2} className="whitespace-normal">
        {hasLocation ? (
          <div className="mb-1">
            <LocationBadge finding={finding} textClassName="line-clamp-1 break-words text-xs font-medium font-mono" />
          </div>
        ) : null}
        {/* No max-width, no `truncate` (nowrap): nowrap text's unbroken length
            becomes this auto-layout column's minimum content width, a hard floor
            that forces the whole table wider than its container. `line-clamp-1`
            clips to one line but lets the text wrap, so its min content width is
            just its longest word; `break-words` covers unbroken long paths, so
            the column can shrink to a normal width without overflow. */}
        <button
          type="button"
          className="block w-full cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => target && onRoute(target)}
        >
          {hasLocation ? null : <span className="line-clamp-1 break-words text-xs font-medium">{label}</span>}
          <span className="line-clamp-1 break-words text-xs text-muted-foreground">{text}</span>
        </button>
      </TableCell>
      <TableCell className="w-px text-right font-mono text-xs text-muted-foreground">{impact}</TableCell>
    </TableRow>
  );
}

/** The group's trailing stat, using its `RollupGroup` kind: `time` and
 * `resource` both lead with the "×N" finding count (the "worth expanding"
 * signal); `count` skips it since the impact-band tally already implies N. */
function trailingStat(group: RollupGroup): string {
  if (group.kind === 'time') {
    return `×${group.findingCount} · ${formatWallClockRange(group.recoverableMsHigh, group.recoverableMsHigh)} recoverable`;
  }
  if (group.kind === 'resource') {
    return `×${group.findingCount} · resource-cost projection`;
  }
  return Object.entries(group.byImpactBand)
    .map(([impactBand, count]) => `${count} ${impactBand}`)
    .join(', ');
}

// Same cases as trailingStat(), spelled out for a hover/focus tooltip: the
// row itself stays terse ("×2 · 476ms recoverable") to fit this dense
// table's right-aligned column, but the shorthand ("×N", "recoverable")
// isn't self-explanatory on first read.
function trailingStatTitle(group: RollupGroup): string {
  if (group.kind === 'time') {
    return `${group.findingCount} findings of this type; up to ${formatWallClockRange(group.recoverableMsHigh, group.recoverableMsHigh)} of run time could be recovered by fixing them`;
  }
  if (group.kind === 'resource') {
    return `${group.findingCount} findings of this type; a resource-cost estimate (not run time) is projected for fixing them`;
  }
  return `${group.findingCount} findings of this type, by impact`;
}

/** A type with more than one finding: a collapsed summary row (tag + the
 * highest-impact member's action label and recommendation + the group's trailing
 * stat) that expands to a paginated list of every finding in the group. The
 * tag/label/text come from the same highest-impact finding, so the row reads as
 * one identity even though the trailing stat describes the whole group. */
export function TypeGroupRow({
  group,
  allFindings,
  expanded,
  onToggle,
  onRoute,
}: {
  group: RollupGroup;
  allFindings: Finding[];
  expanded: boolean;
  onToggle: () => void;
  onRoute: (target: TriageTarget) => void;
}) {
  const [page, setPage] = useState(0);
  const sorted = rankFindings(group.findings);
  const best = sorted[0];
  // A type-level sentence, not the best member's own recommendationText: that's one specific
  // instance's numbers/stage next to a trailing stat summing every member, which misrepresents
  // the group. undefined (an uncovered type/discriminant) omits the line rather than fall back
  // to instance text, which would reintroduce the same problem.
  const title = coreFindingGenericRecommendation(best);
  const label = findingActionLabel(best);
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  // Clamp the page used for slicing (not the stored state) so a stale index
  // can't strand the view on an empty page when a finding filter shrinks the
  // group count without remounting.
  const safePage = Math.min(page, Math.max(0, totalPages - 1));
  const pageItems = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  // `aria-controls` target: a stable id from the group's (kind, type, unit)
  // discriminator. A `<tr>` list has no single wrapping element, so it lands on
  // the expanded list's first row (see `FindingInstanceRow`'s `id` prop).
  const contentId = `fix-these-first-group-content-${group.kind}-${group.type}${'unit' in group ? `-${group.unit}` : ''}`;

  return (
    <>
      <TableRow data-testid="fix-these-first-group-row" data-finding-type={group.type}>
        <TableCell className="w-px">
          <TagBadge type={group.type} impactBand={best.impactBand} docAnchor={sharedDocAnchor(group.findings)} />
        </TableCell>
        <TableCell className="whitespace-normal">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={contentId}
            className="cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={onToggle}
          >
            <span className="block text-sm font-medium">{label}</span>
            {title ? <span className="block text-xs text-muted-foreground">{title}</span> : null}
          </button>
        </TableCell>
        <TableCell className="w-px text-right font-mono text-xs text-muted-foreground">
          <span className="inline-flex items-center justify-end gap-1.5" title={trailingStatTitle(group)}>
            {trailingStat(group)}
            {expanded ? (
              <ChevronUpIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            )}
          </span>
        </TableCell>
      </TableRow>
      {expanded && pageItems.map((finding, index) => (
        <FindingInstanceRow
          key={finding.id}
          finding={finding}
          allFindings={allFindings}
          onRoute={onRoute}
          id={index === 0 ? contentId : undefined}
        />
      ))}
      {expanded && totalPages > 1 && (
        <TableRow className="bg-muted/50">
          <TableCell colSpan={3}>
            <RowPagination
              page={safePage}
              totalPages={totalPages}
              onPrev={() => setPage((p) => p - 1)}
              onNext={() => setPage((p) => p + 1)}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** The single most-impactful eligible finding, called out above the table
 * (`selectTriageTarget` ranks by potential savings, not impact band). Rendered
 * as a tinted primary banner rather than a table row so it reads as a callout,
 * not a stray oddly-styled row. It still appears in its own group/row below:
 * this bar is a shortcut, not a filter. The impact figure gets its own labeled
 * stat column since here the number is the point; location stays alongside as
 * its caption. */
export function HighestImpactBar({ target, onRoute }: { target: TriageTarget; onRoute: (target: TriageTarget) => void }) {
  const location = locationTag(target.finding);
  const impact = impactFigure(target.finding);
  const hasLocation = target.finding.stageId != null || location != null;
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    // recommendationText already ends in its own terminator for most finding
    // types; append one only when it's missing so two summaries never collide
    // into a stray "..".
    const headline = `${findingActionLabel(target.finding)} — ${recommendationText(target.finding)}`;
    const summary = [
      /[.!?]$/.test(headline) ? headline : `${headline}.`,
      impact ? `Potential savings: ${impact}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    try {
      await copyText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions, embed context); no user-facing
      // error state needed for this affordance.
    }
  };
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 transition-colors hover:bg-primary/10">
      {/* The card's one interactive control. A `StagePill` (inside
          `LocationBadge` below) is itself a real `<button>`, so it can't nest
          inside another clickable element without violating WCAG 4.1.2, this
          `<button>` wraps only the non-interactive title/recommendation/impact
          content; the location badge renders as a plain sibling below with its
          own independent click behavior, not a descendant needing
          stopPropagation. */}
      <button
        type="button"
        aria-label={`${findingActionLabel(target.finding)}, ${recommendationText(target.finding)}`}
        onClick={() => onRoute(target)}
        className="flex cursor-pointer flex-col gap-2 rounded-lg px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
      >
        <div className="min-w-0 flex-1">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide text-primary uppercase">
            <TargetIcon aria-hidden="true" className="size-3.5" />
            Highest impact
          </span>
          <p className="mt-2 min-w-0">
            <span className="text-sm font-semibold">{findingActionLabel(target.finding)}</span>
            <span className="text-sm text-muted-foreground">, {recommendationText(target.finding)}</span>
          </p>
        </div>
        {/* Its own column, not a second row: on `sm:+` this sits beside the
            title from the top instead of trailing below the whole left side. */}
        {impact ? (
          <div className="min-w-0 sm:shrink-0 sm:text-right">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Potential savings</p>
            <p className="whitespace-nowrap font-mono text-lg font-semibold leading-tight tabular-nums text-primary">{impact}</p>
          </div>
        ) : null}
      </button>
      {/* Some findings carry a stageIds list hundreds of ids long: capped
          width + a 2-line clamp keeps that from stretching the callout, same
          width as the "Potential savings" label so they read as one stat
          column. A StagePill never needs the cap. The identity (what's
          actually duplicated) leads and reads bold; the stage pills below it
          are supporting evidence, so they're shrunk rather than competing for
          attention. Coloring on both stays the same as everywhere else (muted
          caption, default pill) — only size/weight/order carry the emphasis. */}
      <div className={cn('flex items-center gap-3 px-4 pb-3', hasLocation ? 'justify-between' : 'justify-end')}>
        {hasLocation ? (
          <LocationBadge
            finding={target.finding}
            textClassName="line-clamp-2 max-w-[140px] break-words text-xs font-semibold text-muted-foreground"
            visibleLimit={2}
            stackIdentity
            stagePillClassName="h-5 px-1.5 text-[10px] font-normal"
          />
        ) : null}
        <button
          type="button"
          data-testid="copy-finding-button"
          onClick={() => void handleCopy()}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {copied ? (
            <>
              <CheckIcon aria-hidden="true" className="size-3.5" />
              Copied
            </>
          ) : (
            <>
              <CopyIcon aria-hidden="true" className="size-3.5" />
              Copy finding
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/** The `eligible`/`groups`/`triageTarget` values `ImpactBoard.tsx` renders from.
 * Grouped strictly by finding.type (further split by impact kind and, for
 * `resource`, unit: never merged across detector types); cross-group order is
 * `buildRecommendationRollup`'s job. */
export function useFixTheseFirstData(
  catalog: Finding[],
  configFindings: Finding[],
  stages: AppModel['stages'],
): { eligible: Finding[]; groups: RollupGroup[]; triageTarget: TriageTarget | null } {
  const allFindings = [...catalog, ...configFindings];
  const eligible = allFindings.filter(isEligible);
  const groups = buildRecommendationRollup(eligible, stages);
  const triageTarget = selectTriageTarget(eligible);
  return { eligible, groups, triageTarget };
}
