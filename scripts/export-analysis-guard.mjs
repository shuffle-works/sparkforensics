// Build-time guard for the HTML export bundle (vite.export.config.ts): the
// exported dashboard renders the conclusions its payload carries, so its module
// graph must not reach analysis (detectors, verdict, interpretation, report
// builders) or the live app's ingest path. Fails the build naming each
// offending module and one importer chain back to the entry.
import path from 'node:path';

/** Repo-relative paths the export entry must never reach. */
export const FORBIDDEN_EXPORT_MODULES = [
  ...[
    'analyzer', 'detectors', 'evidence-report', 'html-export', 'redact', 'run-interpretation',
    'run-verdict', 'run-outcome', 'check-coverage', 'run-shape', 'scorecard-estimates',
    'impact-format', 'impact-estimator', 'efficiency-model', 'wasted-core-hours', 'wall-clock',
    'etl-phases', 'core-usage-locality', 'core-locality-ratio', 'core-time-series',
    'threshold-summary', 'job-groups', 'parser-worker', 'ingest', 'model-assembler',
    'event-handlers', 'recent-files', 'zstd-worker-client', 'zstd-worker',
  ].map((name) => `packages/core/src/${name}.ts`),
  'src/store/useIngest.ts',
  'src/store/live-interpretation.ts',
  'src/view/useRecentFiles.ts',
  'src/view/EvidenceExport.tsx',
  'src/view/core-usage-histogram-data.ts',
];

function toRepoPath(root, id) {
  return path.relative(root, id.split('?')[0]).split(path.sep).join('/');
}

/**
 * Every forbidden module in a build's graph, each with the shortest importer
 * chain from an entry (a module nothing imports) down to it.
 * `importersOf(id)` returns the ids that import `id`, statically or dynamically.
 */
export function findForbiddenModules(moduleIds, importersOf, root, forbidden = FORBIDDEN_EXPORT_MODULES) {
  const wanted = new Set(forbidden);
  const violations = [];
  for (const id of moduleIds) {
    const module = toRepoPath(root, id);
    if (!wanted.has(module)) continue;
    const parent = new Map([[id, null]]);
    const queue = [id];
    let top = id;
    while (queue.length > 0) {
      const current = queue.shift();
      const importers = importersOf(current);
      if (importers.length === 0) { top = current; break; }
      for (const importer of importers) {
        if (parent.has(importer)) continue;
        parent.set(importer, current);
        queue.push(importer);
      }
    }
    const chain = [];
    for (let at = top; at != null; at = parent.get(at)) chain.push(toRepoPath(root, at));
    violations.push({ module, chain });
  }
  return violations;
}

export function formatViolations(violations) {
  return [
    'The export bundle reaches analysis or live-only modules:',
    ...violations.map(({ module, chain }) => `  ${module}\n    via ${chain.join(' -> ')}`),
  ].join('\n');
}

/** Vite plugin: errors at the end of the build when the graph reaches a forbidden module. */
export function exportAnalysisGuard(root) {
  return {
    name: 'export-analysis-guard',
    apply: 'build',
    buildEnd(error) {
      if (error) return;
      const importersOf = (id) => {
        const info = this.getModuleInfo(id);
        return [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])];
      };
      const violations = findForbiddenModules([...this.getModuleIds()], importersOf, root);
      if (violations.length > 0) this.error(formatViolations(violations));
    },
  };
}
