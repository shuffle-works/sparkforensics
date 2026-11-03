// Entry point `@sparkforensics/core/export`: the HTML export data contract, the run payload, the
// run serialization and the vendored gzip codec that decodes it. The export bundle reaches this
// file, so it re-exports only modules on ALLOWED_EXPORT_CORE_MODULES
// (scripts/export-analysis-guard.mjs).
export * from './export-data.ts';
export * from './run-payload.ts';
export * from './run-serialization.ts';
export * from './vendor/fflate.js';
