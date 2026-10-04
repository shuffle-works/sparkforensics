import { buildComparison, type CompareOptions, type CompareRunsResult } from './run-comparison.ts';
import { comparisonVerdict, type ComparisonVerdictText } from './comparison-verdict.ts';
import { redactComparison } from './redact.ts';
import type { AppModel, Finding } from './types.ts';

export interface ComparisonRunInput { label: string; appModel: AppModel; catalog: Finding[] }

// The comparison a surface reports: the CLI's `comparison` object and the shared part of MCP
// compare_runs. A field added here reaches every surface.
// `stagePairs` is the one large field (a row per paired stage), so the `summary` view leaves it out.
export type ComparisonOutput = { verdict: ComparisonVerdictText }
  & Pick<CompareRunsResult,
    'confidence' | 'reason' | 'matchedCoverage' | 'runtimeCoverage' | 'metrics' | 'findings'
    | 'comparisonSchemaVersion' | 'unmatched' | 'replanned' | 'bookkeepingStageIds' | 'executionAlignment'>
  & Partial<Pick<CompareRunsResult, 'stagePairs'>>;

/** `full` carries every field (the CLI); `summary` leaves out `stagePairs` (MCP, which returns them
 * only when asked). */
export type ComparisonView = 'full' | 'summary';

/** The reported projection of a comparison. Key order is the CLI's JSON order. */
export function comparisonOutput(comparison: CompareRunsResult, view: ComparisonView = 'full'): ComparisonOutput {
  return {
    verdict: comparisonVerdict(comparison),
    confidence: comparison.confidence,
    reason: comparison.reason,
    matchedCoverage: comparison.matchedCoverage,
    runtimeCoverage: comparison.runtimeCoverage,
    metrics: comparison.metrics,
    findings: comparison.findings,
    comparisonSchemaVersion: comparison.comparisonSchemaVersion,
    ...(view === 'full' ? { stagePairs: comparison.stagePairs } : {}),
    unmatched: comparison.unmatched,
    replanned: comparison.replanned,
    bookkeepingStageIds: comparison.bookkeepingStageIds,
    executionAlignment: comparison.executionAlignment,
  };
}

/** Diffs the two runs and applies `redact` here, so no surface can skip it (stage names carry raw
 * Spark text that can embed a host or IP). `comparison` is the (redacted) raw result for budgets
 * and Markdown; `output` is the projection to serialize. */
export function buildComparisonOutput(
  baseline: ComparisonRunInput, candidate: ComparisonRunInput,
  { redact, normalizePath, view }: { redact?: boolean; view?: ComparisonView } & CompareOptions = {},
): { comparison: CompareRunsResult; output: ComparisonOutput } {
  const built = buildComparison(baseline, candidate, { normalizePath });
  const comparison = redact ? redactComparison(built) : built;
  return { comparison, output: comparisonOutput(comparison, view) };
}
