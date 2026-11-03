import { formatBytes } from '@sparkforensics/core/view-model';
import type { ExchangeWidth } from '@sparkforensics/core/types';

const DEFAULT_MAX_STAGE_IDS_SHOWN = 8;

// Caps a stage-id list's printed length: a sql-scope finding's stageIds can run into the hundreds,
// and joined raw that length balloons an auto-layout table's column width. Shared by FixTheseFirst
// and PlanFindings.
export function formatStageIdsLabel(stageIds: number[], maxShown: number = DEFAULT_MAX_STAGE_IDS_SHOWN): string {
  if (stageIds.length <= maxShown) return stageIds.join(', ');
  return `${stageIds.slice(0, maxShown).join(', ')}, +${stageIds.length - maxShown} more`;
}

/** An exchange's row width as "128 columns · 410 B/row", leaving out what is unknown. */
export function formatRowWidth({ columns, bytesPerRow }: ExchangeWidth): string {
  return [
    columns !== undefined ? `${columns} column${columns === 1 ? '' : 's'}` : null,
    bytesPerRow !== undefined ? `${bytesPerRow < 1000 ? `${bytesPerRow} B` : formatBytes(bytesPerRow)}/row` : null,
  ].filter(Boolean).join(' · ');
}
