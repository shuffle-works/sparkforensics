// Build-time guard for the HTML export bundle (vite.export.config.ts): the
// exported dashboard renders the conclusions its payload carries, so its module
// graph may reach only an allowlist of core modules, and none of the live app's
// ingest or export modules. Fails the build naming each offending module, why,
// and one importer chain back to the entry.
import path from 'node:path';

/** The core modules the export entry may reach: presentation helpers, the payload contract and
 * decoder, the plan views, the Findings board rollup it recomputes under a filter, and the
 * Scaling Simulator's viewer-driven what-if. Any other packages/core module fails the build, so a
 * new analysis import forces a decision: move its result into interpretRun, or add it here as
 * something that only responds to what the viewer does. */
export const ALLOWED_EXPORT_CORE_MODULES = [
  ...[
    'core-count', 'docs-config', 'docs-site-config', 'evidence-availability', 'export-data',
    'finding-action-label', 'finding-filter-predicate', 'finding-generic-recommendation', 'finding-names',
    'finding-tag-help', 'format-utils', 'intervals', 'plan-dot', 'plan-duration-attribution',
    'plan-graph-model', 'plan-node-detail', 'plan-summary', 'plan-tree-walk', 'recommendation-rollup',
    'run-payload', 'scaling-sim', 'session-snapshot', 'sql-stages', 'task-failure',
  ].map((name) => `packages/core/src/${name}.ts`),
  'packages/core/src/vendor/fflate.js',
];

/** Live app modules the export build swaps for stubs (vite.export.config.ts) or never imports. */
export const LIVE_ONLY_MODULES = [
  'src/store/useIngest.ts',
  'src/store/live-interpretation.ts',
  'src/view/useRecentFiles.ts',
  'src/view/EvidenceExport.tsx',
  'src/view/core-usage-histogram-data.ts',
];

const CORE_PREFIX = 'packages/core/';

/** Why `module` may not be in the export graph, or null when it may. */
export function exportModuleViolation(module) {
  if (LIVE_ONLY_MODULES.includes(module)) return 'live-only module';
  if (module.startsWith(CORE_PREFIX) && !ALLOWED_EXPORT_CORE_MODULES.includes(module)) return 'core module not on the export allowlist';
  return null;
}

function toRepoPath(root, id) {
  return path.relative(root, id.split('?')[0]).split(path.sep).join('/');
}

/**
 * Every module in a build's graph the export may not reach, each with why and the shortest
 * importer chain from an entry (a module nothing imports) down to it.
 * `importersOf(id)` returns the ids that import `id`, statically or dynamically.
 */
export function findForbiddenModules(moduleIds, importersOf, root) {
  const violations = [];
  for (const id of moduleIds) {
    const module = toRepoPath(root, id);
    const reason = exportModuleViolation(module);
    if (reason == null) continue;
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
    violations.push({ module, reason, chain });
  }
  return violations;
}

export function formatViolations(violations) {
  return [
    'The export bundle reaches modules it may not (see scripts/export-analysis-guard.mjs):',
    ...violations.map(({ module, reason, chain }) => `  ${module} (${reason})\n    via ${chain.join(' -> ')}`),
  ].join('\n');
}

/** Vite plugin: errors at the end of the build when the graph reaches a module it may not. */
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
