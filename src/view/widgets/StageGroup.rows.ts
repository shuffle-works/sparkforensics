import { findingsOfType, IMPACT_BAND_ORDER, worstImpactBand } from '@sparkforensics/core/view-model';
import type { Finding, FindingOf, ImpactBand, StageId } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import { resolvePlanTree } from '@/view/plan-tree';

/** The finding types shown as one row per stage, each row a stage's findings of that type. */
export type StageGroupType = 'skew' | 'stageShape' | 'tinyTask';

export interface StageGroupEntry {
  finding: Finding;
  /** The line above an evidence panel states the label and the savings. */
  stated: boolean;
  label: string;
  /** The confidence marker belongs to the Advanced density. */
  showStatus: boolean;
}

export interface StageGroupRow<T extends StageGroupType> extends WidgetRow<T> {
  stageId: StageId;
  /** The line above an evidence panel states a finding of the stage, and so the stage. */
  stageStated: boolean;
  /** The findings that keep a line: all of them, or the stated ones that carry a status marker. */
  entries: readonly StageGroupEntry[];
  /** The stated sentence gives the median task duration, so the spread leaves out its P50. */
  p50Stated: boolean;
  /** A slow host the stage also has. */
  slowHost: { impactBand: ImpactBand; host: string | undefined; ratio: FindingOf<'slowHost'>['value']; taskSharePct: number } | null;
  /** Stragglers the stage also has, as the sentence after "Stragglers:". */
  straggler: { impactBand: ImpactBand; detail: string } | null;
  showPlanExplorer: boolean;
  /** Prefix of the stage's task-detail disclosure id. */
  idPrefix: string;
}

interface StageGroupConfig<T extends StageGroupType> {
  findingLabel: (finding: FindingOf<T>) => string;
  idPrefix: string;
  /** Whether a stated finding's sentence gives the median task duration. */
  statesP50?: boolean;
}

// The first finding of each stage, so a lookup per stage is one Map read, not a scan of the list.
function firstByStage<F extends { stageId?: StageId | null }>(findings: readonly F[]): Map<StageId, F> {
  const byStage = new Map<StageId, F>();
  for (const finding of findings) if (finding.stageId != null && !byStage.has(finding.stageId)) byStage.set(finding.stageId, finding);
  return byStage;
}

/** The rows of a widget that flags every stage carrying one finding type, never just the worst: one
 * row per stage, with the stage's slow-host and straggler findings as callouts. */
export function stageGroupRows<T extends StageGroupType>({ findingLabel, idPrefix, statesP50 = false }: StageGroupConfig<T>): RowsOf<T, StageGroupRow<T>> {
  return ({ findings, stated, density, appModel, catalog = [] }) => {
    const groups = new Map<StageId, FindingOf<T>[]>();
    for (const finding of findings) {
      const { stageId } = finding as Finding;
      if (stageId == null) continue;
      const group = groups.get(stageId);
      if (group) group.push(finding);
      else groups.set(stageId, [finding]);
    }
    const slowHostByStage = firstByStage(findingsOfType(catalog, 'slowHost'));
    const stragglerByStage = firstByStage(findingsOfType(catalog, 'straggler'));
    const advanced = density === 'advanced';

    return [...groups]
      .map(([stageId, group]) => ({ stageId, group, band: worstImpactBand(group) ?? 'info' }))
      .sort((a, b) => IMPACT_BAND_ORDER[a.band] - IMPACT_BAND_ORDER[b.band] || a.stageId - b.stageId)
      .map(({ stageId, group }): StageGroupRow<T> => {
        const statedFlags = group.map((finding) => isStated(finding, stated));
        const slowHost = slowHostByStage.get(stageId);
        const straggler = stragglerByStage.get(stageId);
        const speculativeTasks = straggler?.speculativeTasks ?? 0;
        return {
          findings: group,
          stageId,
          stageStated: statedFlags.some(Boolean),
          entries: group
            .map((finding, i): StageGroupEntry => ({ finding, stated: statedFlags[i], label: findingLabel(finding), showStatus: advanced }))
            .filter(({ finding, stated: entryStated }) => !entryStated || (advanced && Boolean(finding.confidence) && finding.confidence !== 'high')),
          p50Stated: statesP50 && statedFlags.some(Boolean),
          // A per-executor (multiDim) finding names no host.
          slowHost: slowHost
            ? {
              impactBand: slowHost.impactBand,
              host: slowHost.variant === 'multiDim' ? undefined : slowHost.host,
              ratio: slowHost.value,
              taskSharePct: slowHost.variant === 'multiDim' ? 0 : Math.round(slowHost.hostTaskShare * 100),
            }
            : null,
          straggler: straggler
            ? {
              impactBand: straggler.impactBand,
              detail: speculativeTasks > 0
                ? `${speculativeTasks} speculative task${speculativeTasks === 1 ? '' : 's'}`
                : `${straggler.value}% of tasks > 4× P50`,
            }
            : null,
          showPlanExplorer: advanced && resolvePlanTree(stageId, appModel) !== null,
          idPrefix,
        };
      });
  };
}

/** The card's lead metric: how many stages are flagged. */
export const stageGroupSummary = (rows: readonly { stageId: StageId }[]) => ({
  value: `${rows.length} stage${rows.length === 1 ? '' : 's'}`,
});
