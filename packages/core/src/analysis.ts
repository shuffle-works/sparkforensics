// Entry point `@sparkforensics/core/analysis`: the analysis the live app, the CLI and the MCP
// server share. It re-exports and holds no code of its own. The HTML export bundle never reaches
// it (scripts/export-analysis-guard.mjs); what the export shows comes through `view-model` and
// `export`.
export * from './analyzer.ts';
export * from './comparability.ts';
export * from './comparison-output.ts';
export * from './comparison-verdict.ts';
export * from './core-locality-ratio.ts';
export * from './core-time-series.ts';
export * from './core-usage-locality.ts';
export * from './detector-catalog.ts';
export * from './detector-docs.ts';
export * from './detector-listing.ts';
export * from './detectors.ts';
export { hasStageOutsideSql } from './detectors/conf.ts';
export { defineAppDetector, defineConfigDetector, defineSqlDetector, defineStageDetector } from './detectors/define.ts';
export { isExecutionWideStageIds, unionStageIds } from './detectors/plan-attribution.ts';
export {
  computePlanShapes, findCompositeCandidates, findDuplicateSubtrees, normalizeDetail, planOperatorKind, type CompositeCandidate,
} from './detectors/plan-shape.ts';
export { computeSkewRatio } from './detectors/tail.ts';
export type {
  Detector, DetectorConfigTarget, DetectorCtx, DetectorScope, DetectorSqlExec, DetectorStage, DetectorThresholds, DetectResult,
  SkewThresholds,
} from './detectors/types.ts';
export * from './evidence-report.ts';
export * from './html-export.ts';
export * from './impact-format.ts';
export * from './ingest.ts';
export * from './model-assembler.ts';
export * from './rolling-log-reassembly.ts';
export * from './run-comparison.ts';
export * from './run-interpretation.ts';
export * from './run-verdict.ts';
export * from './shs-request.js';
export * from './stage-alignment.ts';
export * from './stage-widget-frequency.ts';
export * from './threshold-overrides.ts';
