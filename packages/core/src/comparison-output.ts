import { buildComparison, type CompareRunsResult } from './run-comparison.ts';
import { comparisonVerdict, type ComparisonVerdictText } from './comparison-verdict.ts';
import { redactComparison } from './redact.ts';
import type { AppModel, Finding } from './types.ts';

export interface ComparisonRunInput { label: string; appModel: AppModel; catalog: Finding[] }

// The comparison a surface reports: the CLI's `comparison` object and the shared part of MCP
// compare_runs. A field added here reaches every surface.
export type ComparisonOutput = { verdict: ComparisonVerdictText }
  & Pick<CompareRunsResult, 'confidence' | 'reason' | 'matchedCoverage' | 'metrics' | 'findings'>;

/** The reported projection of a comparison. Key order is the CLI's JSON order. */
export function comparisonOutput(comparison: CompareRunsResult): ComparisonOutput {
  return {
    verdict: comparisonVerdict(comparison),
    confidence: comparison.confidence,
    reason: comparison.reason,
    matchedCoverage: comparison.matchedCoverage,
    metrics: comparison.metrics,
    findings: comparison.findings,
  };
}

/** Diffs the two runs and applies `redact` here, so no surface can skip it (stage names carry raw
 * Spark text that can embed a host or IP). `comparison` is the (redacted) raw result for budgets
 * and Markdown; `output` is the projection to serialize. */
export function buildComparisonOutput(
  baseline: ComparisonRunInput, candidate: ComparisonRunInput, { redact }: { redact?: boolean } = {},
): { comparison: CompareRunsResult; output: ComparisonOutput } {
  const built = buildComparison(baseline, candidate);
  const comparison = redact ? redactComparison(built) : built;
  return { comparison, output: comparisonOutput(comparison) };
}
