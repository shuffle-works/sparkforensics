import { TagBadge } from '@/view/ImpactBadge';
import { StageEntryButton } from '@/view/plan-graph/stage-selection';
import { formatFindingChipDetail } from '@sparkforensics/core/format-utils.ts';
import type { Finding } from '@sparkforensics/core/types.ts';

/** One finding chip on a plan-graph group box: the ALL-CAPS tag pill (via
 * TagBadge) followed by the finding's compact magnitude and recoverable time
 * (e.g. "SPILL  4.2 GB · ~38.0s"). The detail half is monospace muted text and
 * is omitted entirely when the finding carries neither a formattable magnitude
 * nor a wall-clock claim, leaving the bare tag exactly as before. The whole
 * chip opens the findings panel of `stageId`; the docs link is on the tag in
 * that panel. */
export function PlanGraphFindingChip({ finding, stageId, className }: { finding: Finding; stageId: number; className?: string }) {
  const detail = formatFindingChipDetail(finding);
  return (
    <StageEntryButton stageId={stageId} title={`Show the findings for stage ${stageId}`} className="inline-flex items-center gap-1">
      <TagBadge type={finding.type} impactBand={finding.impactBand} className={className} plainBadge />
      {detail ? (
        <span className="font-mono text-[10px] leading-none whitespace-nowrap text-muted-foreground">{detail}</span>
      ) : null}
    </StageEntryButton>
  );
}
