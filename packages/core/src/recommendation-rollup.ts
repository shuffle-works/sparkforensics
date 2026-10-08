// Explicit .ts extensions: plain Node's ESM resolver (the runtime CLI/MCP path
// runs under) requires the exact specifier, unlike a bundler.
import { mergeIntervals } from './intervals.ts';
import { formatRawWaste, formatWallClockRange, readsAsZero, worstImpactBand, IMPACT_BAND_ORDER } from './format-utils.ts';
import type { Finding, RawWasteUnit, ImpactBand } from './types.ts';

interface StageInterval {
  submittedAt?: number;
  completedAt?: number;
}

/** Cross-finding grouping: given every stage touched by a group of findings,
 * merge their intervals once across the combined set, instead of summing each
 * finding's own already-clipped wallClock figure (which double-counts
 * concurrent stages across different findings of the same detector type). */
export function computeStageUnionMs(
  stageIds: number[],
  stages: Map<number, StageInterval>,
): number {
  const intervals: [number, number][] = [];
  for (const id of stageIds) {
    const stage = stages.get(id);
    if (!stage) continue;
    // Skip half-open stages rather than defaulting a missing bound to 0: an
    // incomplete/truncated log (the case `incompleteRun` flags) leaves
    // `completedAt` unset, and coercing it to 0 would contribute a hugely
    // negative interval and a nonsense negative recoverable-time figure.
    // Same filter `computeWallClock` (src/wall-clock.ts) already applies.
    if (stage.submittedAt == null || stage.completedAt == null) continue;
    intervals.push([stage.submittedAt, stage.completedAt]);
  }
  return mergeIntervals(intervals).reduce((sum, [a, b]) => sum + (b - a), 0);
}

export type RollupGroup =
  | { kind: 'time'; type: string; findingCount: number; stageCount: number; recoverableMsHigh: number; findings: Finding[] }
  | { kind: 'resource'; type: string; findingCount: number; unit: RawWasteUnit; total: number; findings: Finding[] }
  | { kind: 'count'; type: string; findingCount: number; byImpactBand: Partial<Record<ImpactBand, number>>; findings: Finding[] };

function groupByType(findings: Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = groups.get(finding.type) ?? [];
    group.push(finding);
    groups.set(finding.type, group);
  }
  return groups;
}

function stageIdsOf(finding: Finding): number[] {
  if ('stageIds' in finding) return finding.stageIds;
  if (finding.stageId != null) return [finding.stageId];
  return [];
}

function buildTimeGroup(
  type: string,
  findings: Finding[],
  stages: Map<number, { submittedAt?: number; completedAt?: number }>,
): RollupGroup {
  const stageIds = [...new Set(findings.flatMap(stageIdsOf))];
  const naiveSum = findings.reduce((sum, f) => sum + (f.impactEstimate?.wallClock?.high ?? 0), 0);
  // Only cap to stage union if there are stages to compare; stageless findings use naive sum.
  const recoverableMsHigh = stageIds.length > 0
    ? Math.min(naiveSum, computeStageUnionMs(stageIds, stages))
    : naiveSum;
  return { kind: 'time', type, findingCount: findings.length, stageCount: stageIds.length, recoverableMsHigh, findings };
}

function buildResourceGroup(type: string, findings: Finding[]): RollupGroup {
  const unit = findings[0].impactEstimate!.rawWaste!.unit;
  const total = findings.reduce((sum, f) => sum + (f.impactEstimate?.rawWaste?.value ?? 0), 0);
  return { kind: 'resource', type, findingCount: findings.length, unit, total, findings };
}

function buildCountGroup(type: string, findings: Finding[]): RollupGroup {
  const byImpactBand: Partial<Record<ImpactBand, number>> = {};
  for (const finding of findings) {
    byImpactBand[finding.impactBand] = (byImpactBand[finding.impactBand] ?? 0) + 1;
  }
  return { kind: 'count', type, findingCount: findings.length, byImpactBand, findings };
}

const KIND_ORDER: Record<RollupGroup['kind'], number> = { time: 0, resource: 1, count: 2 };

export function buildRecommendationRollup(
  findings: Finding[],
  stages: Map<number, { submittedAt?: number; completedAt?: number }>,
): RollupGroup[] {
  const groups: RollupGroup[] = [];
  for (const [type, typeFindings] of groupByType(findings)) {
    const timeFindings = typeFindings.filter((f) => f.impactEstimate?.wallClock != null);
    const resourceFindings = typeFindings.filter(
      (f) => f.impactEstimate?.wallClock == null && f.impactEstimate?.rawWaste != null,
    );
    const countFindings = typeFindings.filter(
      (f) => f.impactEstimate?.wallClock == null && f.impactEstimate?.rawWaste == null,
    );
    if (timeFindings.length > 0) groups.push(buildTimeGroup(type, timeFindings, stages));
    // Group resource findings by (type, unit) to prevent mixing incompatible units.
    if (resourceFindings.length > 0) {
      const byUnit = new Map<RawWasteUnit, Finding[]>();
      for (const finding of resourceFindings) {
        const unit = finding.impactEstimate!.rawWaste!.unit;
        const group = byUnit.get(unit) ?? [];
        group.push(finding);
        byUnit.set(unit, group);
      }
      for (const resourceGroup of byUnit.values()) {
        groups.push(buildResourceGroup(type, resourceGroup));
      }
    }
    if (countFindings.length > 0) groups.push(buildCountGroup(type, countFindings));
  }
  return groups.sort((a, b) => {
    const kindDelta = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (kindDelta !== 0) return kindDelta;
    if (a.kind === 'time' && b.kind === 'time') return b.recoverableMsHigh - a.recoverableMsHigh;
    // resource/count groups carry no shared magnitude to rank by (comparing
    // incompatible units is forbidden); break ties by worst impact band instead.
    const aImpactBand = IMPACT_BAND_ORDER[worstImpactBand(a.findings) ?? 'info'] ?? 9;
    const bImpactBand = IMPACT_BAND_ORDER[worstImpactBand(b.findings) ?? 'info'] ?? 9;
    return aImpactBand - bImpactBand;
  });
}

/** A resource group's summed waste as the board and CLI print it; null when it reads as zero. */
export function resourceGroupTotal(group: { total: number; unit: RawWasteUnit }): string | null {
  const text = formatRawWaste({ value: group.total, unit: group.unit });
  return readsAsZero(text) ? null : text;
}

/** A group's trailing figure on the Findings board, and its tooltip. Every kind leads with the
 * "×N" finding count (the "worth expanding" signal). The row stays terse ("×2 · 476ms
 * recoverable") to fit a dense right-aligned column; the title spells the shorthand out. */
export function rollupGroupStat(group: RollupGroup): { stat: string; statTitle: string } {
  if (group.kind === 'time') {
    const recoverable = formatWallClockRange(group.recoverableMsHigh, group.recoverableMsHigh);
    return {
      stat: `×${group.findingCount} · ${recoverable} recoverable`,
      statTitle: `${group.findingCount} findings of this type; up to ${recoverable} of run time could be recovered by fixing them`,
    };
  }
  if (group.kind === 'resource') {
    const total = resourceGroupTotal(group);
    return {
      stat: total ? `×${group.findingCount} · ${total}` : `×${group.findingCount}`,
      statTitle: `${group.findingCount} findings of this type${total ? `; ${total} in total, a resource cost, not run time` : ''}`,
    };
  }
  // The band heading above the row already names a one-band group's band.
  const bands = Object.entries(group.byImpactBand);
  return {
    stat: bands.length === 1 ? `×${group.findingCount}` : `×${group.findingCount} · ${bands.map(([impactBand, count]) => `${count} ${impactBand}`).join(', ')}`,
    statTitle: `${group.findingCount} findings of this type, by impact`,
  };
}

/** True when a finding is real evidence of an issue, as opposed to a mere
 * evidence-unavailable caveat. Shared by `isEligible` below and by anything
 * else that decides whether a REGISTRY type has "something to show" (an
 * active widget card vs. a Clean-checks line): memoryUtilization's
 * memoryBand/dataUnavailable variant reports a missing-evidence caveat
 * (the log carries no executor heap peaks: Spark before 3.0 or local mode), not an
 * optimization or a clean bill of health; the exact same fact already lives
 * in the Evidence availability ledger's own `executorMetrics` entry
 * (src/evidence-availability.ts), so it belongs there, not as its own card. */
export function isRealFinding(finding: Finding): boolean {
  if (finding.type === 'memoryUtilization' && finding.variant === 'memoryBand' && finding.dataUnavailable) return false;
  return true;
}

/** True when a finding is a candidate for the "fix these first" ranking.
 * Shared by evidence-report.ts (CLI/MCP path) and FixTheseFirst.tsx (the
 * dashboard widget) so these hardcoded exclusions can't drift between the two
 * surfaces. Doesn't check `REGISTRY[finding.type] != null`: `REGISTRY` lives
 * in a `.tsx` file, not importable from this core module, so FixTheseFirst.tsx
 * layers that extra check on top of this one. */
export function isEligible(finding: Finding): boolean {
  // incompleteRun is a pipeline-completeness signal, not an addressable fix:
  // hardcoded here by type, not read from Detector.fixEffort. Unlike
  // `isRealFinding`, this exclusion doesn't apply beyond the rollup: an
  // incompleteRun finding still backs its own ordinary active widget card.
  if (finding.type === 'incompleteRun') return false;
  // A missing-evidence caveat (memoryUtilization's is already excluded by isRealFinding;
  // cacheUtilization's storageUnobserved keeps its widget card, so a run with no block updates
  // never lists Cache Storage as a passed check) is never a fix to rank.
  if ('dataUnavailable' in finding && finding.dataUnavailable) return false;
  return isRealFinding(finding);
}

/** Ranking tier for a single finding: time-based findings (a real `wallClock`
 * claim) are the only ones whose magnitudes share a unit, so they are the
 * only ones ranked numerically. `resourceOnly` findings carry `rawWaste` in
 * whatever unit their detector emitted, which the spec (section 5) forbids
 * comparing against a time figure or against another resourceOnly finding's
 * own raw magnitude; they rank by impact band instead, below every time-based
 * finding. Informational findings (no magnitude at all) rank last, also by
 * impact band. */
const TIER_TIME = 0;
const TIER_RESOURCE = 1;
const TIER_INFORMATIONAL = 2;

function tierOf(finding: Finding): number {
  const estimate = finding.impactEstimate;
  if (estimate?.wallClock) return TIER_TIME;
  if (estimate?.rawWaste) return TIER_RESOURCE;
  return TIER_INFORMATIONAL;
}

/** Ranks a group's members so the "representative" finding (the one whose
 * action label/tag donate to the group's row) is always the highest-impact
 * one, not just the first one `buildRecommendationRollup` happened to
 * collect. Used to pick each type-group's own highest-impact member and to
 * order that group's expanded list; cross-group ordering is
 * `buildRecommendationRollup`'s own job, not this function's. */
export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const tierDelta = tierOf(a) - tierOf(b);
    if (tierDelta !== 0) return tierDelta;
    if (tierOf(a) === TIER_TIME) {
      // Same unit (ms) on both sides. Rank on .high, matching deriveImpactBand
      // and triage-target.ts, so ordering, badge color, and the "click to
      // investigate" target all agree on the same figure.
      return b.impactEstimate!.wallClock!.high - a.impactEstimate!.wallClock!.high;
    }
    return (IMPACT_BAND_ORDER[a.impactBand] ?? 9) - (IMPACT_BAND_ORDER[b.impactBand] ?? 9);
  });
}

/** A board group ready to render: members ranked representative first, the representative's
 * band (the heading the group sits under) and the group's trailing figure. */
export interface RankedRollupGroup {
  kind: RollupGroup['kind'];
  type: string;
  unit: RawWasteUnit | null;
  band: ImpactBand;
  members: Finding[];
  stat: string;
  statTitle: string;
}

/** The Findings board's groups over `eligible`, in fix-first order. The run's interpretation
 * carries this for every eligible finding; the board recomputes it only over a filtered subset. */
export function rankedRollup(
  eligible: Finding[],
  stages: Map<number, { submittedAt?: number; completedAt?: number }>,
): RankedRollupGroup[] {
  return buildRecommendationRollup(eligible, stages).map((group) => {
    const members = rankFindings(group.findings);
    return {
      kind: group.kind,
      type: group.type,
      unit: group.kind === 'resource' ? group.unit : null,
      band: members[0].impactBand,
      members,
      ...rollupGroupStat(group),
    };
  });
}
