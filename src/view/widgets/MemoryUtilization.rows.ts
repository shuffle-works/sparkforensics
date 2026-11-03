import { formatBytes, formatMetricValue, formatRawWaste, IMPACT_BAND_ORDER, numericValue, isCaveat } from '@sparkforensics/core/view-model';
import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { chartShowsTrend } from './CoreUsageArea.rows';

type MemoryFinding = FindingOf<'memoryUtilization'>;

export interface MemoryRow extends WidgetRow<'memoryUtilization'> {
  finding: MemoryFinding;
  /** Per-executor findings name the executor; the two app-wide variants get a fixed label. */
  label: string;
  /** A finding that says the log had no executor metrics; it has no figure of its own. */
  caveat: boolean;
  /** The line above an evidence panel states the figure. */
  stated: boolean;
  /** The caveat's text, which only the Advanced density shows; null on a measured row. */
  note: string | null;
  /** The variant's figure; null when stated. */
  detail: string | null;
  /** The detector's diagnosis clause behind the figure; null when stated or at the Basic density. */
  diagnosis: string | null;
  /** A stated idle-core row embeds the chart of idle capacity when the run has enough points for a trend,
   * and keeps its measurements otherwise. */
  chart: boolean;
  /** The measurements behind the figure, which the line above does not repeat; null unless stated. */
  evidence: string | null;
}

const memoryTime = (mbSeconds: number) => formatRawWaste({ value: mbSeconds, unit: 'mbSeconds' });

/** Each `memoryUtilization` variant reports a different metric under `value`: idle core-time rate,
 * highest-executor heap ratio, or the app-wide MB-seconds waste model. */
function memoryDetail(f: MemoryFinding): string {
  const value = numericValue(f);
  const pct = formatMetricValue('pct', value);
  if (f.variant === 'idleCores') return `${pct} of available core-time idle`;
  if (f.variant === 'memoryBand') return `${pct} of allocated heap used: over-provisioned`;
  // Same units as the step's savings figure, so the two never disagree in form.
  return `~${formatRawWaste({ value, unit: 'mbSeconds' })} wasted`;
}

// Only the `rule`-discriminated variant (heapOverProvisioned) has a diagnosis clause worth keeping:
// the same figure memoryDetail() shows, in the detector's own words.
function memoryDiagnosis(f: MemoryFinding): string | null {
  if (f.variant !== 'memoryBand' || f.rule == null) return null;
  const recommendation = f.recommendation ?? '';
  const adviceStart = recommendation.indexOf(': ');
  return adviceStart === -1 ? null : ` ${recommendation.slice(0, adviceStart)}.`;
}

function memoryEvidence(f: MemoryFinding): string | null {
  if (f.variant === 'memoryBand') {
    return f.rule === 'heapOverProvisioned' && f.heap != null && f.allocatedBytes != null
      ? `Peak heap ${formatBytes(f.heap)} of ${formatBytes(f.allocatedBytes)} allocated, across ${f.executorCount} sampled executors.`
      : null;
  }
  if (f.allocatedMBSeconds == null) return null;
  const used = f.variant === 'wasteModel' ? `, ${memoryTime(f.allocatedMBSeconds - numericValue(f))} used` : '';
  return `${memoryTime(f.allocatedMBSeconds)} of executor memory-time allocated${used}.`;
}

export function memoryRowLabel(f: MemoryFinding): string {
  if ('executorId' in f && f.executorId != null) return `Executor ${f.executorId}`;
  return f.variant === 'idleCores' ? 'Idle cores' : 'Memory waste';
}

// A card needs a measured row: a caveat alone, that the log had no executor metrics, is not a card.
export const memoryRows: RowsOf<'memoryUtilization', MemoryRow> = ({ findings, stated, density, localityChart }) => {
  const rows = findings.flatMap((finding): MemoryRow[] => {
    const rowStated = isStated(finding, stated);
    const base = { findings: [finding], finding, label: memoryRowLabel(finding), stated: rowStated };
    if (isCaveat(finding)) {
      // The line above states the caveat's text, and the Basic density does not show it.
      if (rowStated || density !== 'advanced' || !finding.recommendation) return [];
      return [{ ...base, caveat: true, note: finding.recommendation, detail: null, diagnosis: null, chart: false, evidence: null }];
    }
    if (!rowStated) {
      return [{
        ...base,
        caveat: false,
        note: null,
        detail: memoryDetail(finding),
        diagnosis: density === 'advanced' ? memoryDiagnosis(finding) : null,
        chart: false,
        evidence: null,
      }];
    }
    const chart = finding.variant === 'idleCores' && localityChart != null && chartShowsTrend(localityChart);
    const evidence = memoryEvidence(finding);
    if (!chart && evidence === null) return [];
    return [{ ...base, caveat: false, note: null, detail: null, diagnosis: null, chart, evidence }];
  });
  if (!rows.some((row) => !row.caveat)) return [];
  return rows.sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand]);
};

export const memoryUtilizationModel: FindingWidgetModel<'memoryUtilization', MemoryRow> = {
  type: 'memoryUtilization',
  rows: memoryRows,
  stageOf: () => null,
  summary: (rows) => ({ value: (rows.find((row) => !row.caveat) ?? rows[0]).label }),
  listClassName: 'space-y-2 text-sm',
};
