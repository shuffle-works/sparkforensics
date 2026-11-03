// Entry point `@sparkforensics/core/node`: every core export the CLI and MCP bins use, loaded as one
// module by load-node-core.js. A bin reads these names from the typed object it gets back, so
// a name this file does not export fails `tsc` for the bin, and a moved function stays one edit here.
//
// The MCP server factory is a lazy import: it pulls in the MCP SDK, which the CLI package does not
// install, and only the MCP bin builds a server.
export { collectRun } from './cli/collect-run.ts';
export { collectRunPair } from './cli/collect-run-pair.ts';
export { evaluateBudgets } from './cli/budgets.ts';
export { runDetectorsCommand } from './cli/detectors-command.ts';
export { parseNonNegativeNumber, parseStageId, parseImpactBands, parseFindingTypes, parseFailOnIntroduced } from './cli/flag-values.ts';
export {
  parseRegressionBudgetFlag, loadBudgetsFile, combineRegressionBudgets, parseStageRegressionBudgetFlag, parseStageQualities,
} from './cli/regression-budgets.ts';
export { loadThresholdOverrides } from './cli/threshold-config.ts';
export { resolveFromShs } from './shs-load.ts';
export { validateShsRequest } from './shs-request.js';
export { deriveEvidenceAvailability } from './evidence-availability.ts';
export { buildEvidenceReport, runFindings, toFindingsFilter } from './evidence-report.ts';
export { renderComparisonMarkdown, COMPARISON_METRIC_KEYS, DEFAULT_NOISE_BAND } from './run-comparison.ts';
export { buildComparisonOutput } from './comparison-output.ts';
export { compileNormalizePatterns, MAX_NORMALIZE_PATTERN_LENGTH, MAX_NORMALIZE_PATTERNS } from './stage-alignment.ts';
export { compileConfIgnorePatterns } from './comparability.ts';
export { buildHtmlExportData, encodeRunPayload } from './html-export.ts';
export { runPayloadScript } from './run-payload.ts';
export { tunedDetectors } from './threshold-overrides.ts';
export { runOutputBlocks } from './run-output.ts';
export { buildEffectiveConf } from './effective-conf.ts';

export const loadMcpServerFactory = () => import('./mcp-server-factory.ts');
