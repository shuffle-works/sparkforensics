import { useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { findingStageIds } from '@sparkforensics/core/findings-of-type.ts';
import { coreFindingGenericRecommendation } from '@sparkforensics/core/finding-generic-recommendation.ts';
import { TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { sharedDocAnchor } from '@sparkforensics/core/docs-config.ts';
import { formatStageIdsLabel, pathBasename } from '@sparkforensics/core/format-utils.ts';
import { findingActionLabel } from '@/view/finding-action-label';
import { TagBadge } from '@/view/ImpactBadge';
import { StagePill, StagePillGroup } from '@/view/StagePill';
import { recommendationText } from '@sparkforensics/core/finding-names.ts';
import { boardRollup, useFindingSavings, type BoardGroup } from '@/view/interpretation';
import type { InterpretationState } from '@/store/store';
import { RowPagination } from '@/view/RowPagination';
import { selectTriageTarget, selectTriageTargetForFinding, type TriageTarget } from '@/view/triage-target';

const PAGE_SIZE = 10;

// Below `sm` a three-column row leaves the recommendation too little width and
// pushes the right-hand stage/savings column off screen. The row turns into a
// wrapping flex line instead: tag and text share the first line, and the
// trailing column drops onto its own full-width line under them. CSS only, so
// every figure still renders exactly once.
const STACKED_ROW = 'max-sm:flex max-sm:flex-wrap max-sm:items-start';
const STACKED_TAG_CELL = 'max-sm:w-auto max-sm:shrink-0';
const STACKED_TEXT_CELL = 'max-sm:min-w-0 max-sm:flex-1 max-sm:whitespace-normal max-sm:[overflow-wrap:anywhere]';
const STACKED_TRAILING_CELL = 'max-sm:w-full max-sm:basis-full max-sm:pt-0 max-sm:text-left';

/** A short per-row location tag, abbreviated ("St." not "Stage") to fit the
 * compact row's right-aligned monospace figure. Falls back through the location
 * keys a Finding can carry: a per-stage detector sets `stageId`; a sql-scope one
 * sets `stageIds`; a config-scope one sets `property`; app-level findings have
 * no location. */
function locationTag(finding: Finding): string | null {
  const stageIds = findingStageIds(finding);
  const stageLabel = finding.stageId != null
    ? `St.${finding.stageId}`
    : stageIds && stageIds.length > 0
      ? `St.${formatStageIdsLabel(stageIds)}`
      : null;

  // Two distinct duplicate-subtree groups can touch the same stage set with the
  // same root operator name, so stage + root name isn't unique; fold in
  // `duplicateSubtreeIdentity`'s groupIndex+executionId suffix to disambiguate.
  if (finding.type === 'duplicatePlanSubtree' && finding.rootName != null) {
    const identity = duplicateSubtreeIdentity(finding);
    return stageLabel && identity ? `${stageLabel} · ${identity}` : (identity ?? stageLabel);
  }

  if (stageLabel) return stageLabel;
  if (finding.type === 'configAudit') return finding.property;
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
 * pills. A config-scope `property` (or no location) stays `locationTag`'s
 * plain text. */
function LocationBadge({ finding, textClassName }: { finding: Finding; textClassName?: string }) {
  const { stageId } = finding;
  const stageIds = findingStageIds(finding);
  if (stageId != null) return <StagePill stageId={stageId} />;
  if (stageIds && stageIds.length > 0) {
    const identity = duplicateSubtreeIdentity(finding);
    return (
      <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
        <StagePillGroup pills={stageIds.map((id) => ({ id }))} />
        {identity ? (
          <span className={cn('truncate', textClassName)} title={identity}>
            {identity}
          </span>
        ) : null}
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

// Lives in core (shared with the CLI/MCP verdict); re-exported for the view modules and tests
// that import it from here.
export { recommendationText };

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
  const impact = useFindingSavings(finding)?.figure ?? null;
  const text = recommendationText(finding);
  const label = findingActionLabel(finding);
  return (
    <TableRow data-testid="fix-these-first-row" data-finding-type={finding.type} className={STACKED_ROW}>
      <TableCell className={cn('w-px', STACKED_TAG_CELL)}>
        <TagBadge type={finding.type} impactBand={finding.impactBand} docAnchor={finding.docAnchor} />
      </TableCell>
      <TableCell className={cn('whitespace-normal', STACKED_TEXT_CELL)}>
        <button
          type="button"
          data-shortcut-target
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
      <TableCell
        className={cn('w-px text-right font-mono text-xs text-muted-foreground', STACKED_TRAILING_CELL)}
        title={[location, impact].filter(Boolean).join(' · ')}
      >
        <span className="flex items-center justify-end gap-1.5 max-sm:justify-start">
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
  const impact = useFindingSavings(finding)?.figure ?? null;
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
          data-shortcut-target
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
  group: BoardGroup;
  allFindings: Finding[];
  expanded: boolean;
  onToggle: () => void;
  onRoute: (target: TriageTarget) => void;
}) {
  const [page, setPage] = useState(0);
  // Members arrive ranked, representative first.
  const sorted = group.findings;
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
  const contentId = `fix-these-first-group-content-${group.kind}-${group.type}${group.unit ? `-${group.unit}` : ''}`;

  return (
    <>
      <TableRow data-testid="fix-these-first-group-row" data-finding-type={group.type} className={STACKED_ROW}>
        <TableCell className={cn('w-px', STACKED_TAG_CELL)}>
          <TagBadge type={group.type} impactBand={best.impactBand} docAnchor={sharedDocAnchor(group.findings)} />
        </TableCell>
        <TableCell className={cn('whitespace-normal', STACKED_TEXT_CELL)}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={contentId}
            data-shortcut-target
            className="cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={onToggle}
          >
            <span className="block text-sm font-medium">{label}</span>
            {title ? <span className="block text-xs text-muted-foreground">{title}</span> : null}
          </button>
        </TableCell>
        <TableCell className={cn('w-px text-right font-mono text-xs text-muted-foreground', STACKED_TRAILING_CELL)}>
          <span className="inline-flex items-center justify-end gap-1.5" title={group.statTitle}>
            {group.stat}
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

/** The `eligible`/`groups`/`triageTarget` values `ImpactBoard.tsx` renders from: the run's
 * interpretation, recomputed over the filtered findings only while a filter is active (see
 * `boardRollup`). */
export function useFixTheseFirstData(
  catalog: Finding[],
  configFindings: Finding[],
  stages: AppModel['stages'],
  interpretation: InterpretationState | null,
): { eligible: Finding[]; groups: BoardGroup[]; triageTarget: TriageTarget | null } {
  const { eligible, groups } = boardRollup(interpretation, [...catalog, ...configFindings], stages);
  const triageTarget = selectTriageTarget(interpretation, eligible);
  return { eligible, groups, triageTarget };
}
