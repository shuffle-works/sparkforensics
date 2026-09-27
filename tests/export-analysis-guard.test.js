import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { build } from 'vite';
import { exportModuleViolation, findForbiddenModules, formatViolations } from '../scripts/export-analysis-guard.mjs';

const root = path.resolve(import.meta.dirname, '..');
const toRepoPath = (id) => path.relative(root, id.split('?')[0]).split(path.sep).join('/');

describe('export analysis guard', () => {
  it('the real export build reaches only allowed core modules and no live-only module', async () => {
    let moduleIds = [];
    // The same build `npm run build` runs for the export template, bundled in
    // memory (`--mode guard`); exportAnalysisGuard would fail it on a violation.
    await build({
      root,
      configFile: path.join(root, 'vite.export.config.ts'),
      mode: 'guard',
      logLevel: 'silent',
      build: { write: false },
      plugins: [{ name: 'record-module-ids', buildEnd() { moduleIds = [...this.getModuleIds()].map(toRepoPath); } }],
    });

    expect(moduleIds).toContain('src/export/main-export.tsx');
    expect(moduleIds).toContain('src/view/Dashboard.tsx');
    // Core ids must normalize to packages/core/src too, or the allowlist would match nothing.
    expect(moduleIds).toContain('packages/core/src/format-utils.ts');
    expect(moduleIds.filter((id) => exportModuleViolation(id) != null)).toEqual([]);
  }, 180_000);

  it('names each forbidden module with an importer chain back to the entry', () => {
    const abs = (repoPath) => path.join(root, repoPath);
    const importers = {
      [abs('src/export/main-export.tsx')]: [],
      [abs('src/view/Widget.tsx')]: [abs('src/export/main-export.tsx')],
      [abs('packages/core/src/analyzer.ts')]: [abs('src/view/Widget.tsx')],
      [abs('packages/core/src/format-utils.ts')]: [abs('src/view/Widget.tsx')],
    };
    const violations = findForbiddenModules(Object.keys(importers), (id) => importers[id], root);

    expect(violations).toEqual([{
      module: 'packages/core/src/analyzer.ts',
      reason: 'core module not on the export allowlist',
      chain: ['src/export/main-export.tsx', 'src/view/Widget.tsx', 'packages/core/src/analyzer.ts'],
    }]);
    expect(formatViolations(violations)).toContain(
      'packages/core/src/analyzer.ts (core module not on the export allowlist)\n'
      + '    via src/export/main-export.tsx -> src/view/Widget.tsx -> packages/core/src/analyzer.ts',
    );
  });

  it('flags any core module off the allowlist, not only known analysis, and every live-only module', () => {
    expect(exportModuleViolation('packages/core/src/occupancy.ts')).toBe('core module not on the export allowlist');
    expect(exportModuleViolation('packages/core/src/stage-quantiles.ts')).toBe('core module not on the export allowlist');
    expect(exportModuleViolation('src/store/useIngest.ts')).toBe('live-only module');
    expect(exportModuleViolation('packages/core/src/format-utils.ts')).toBeNull();
    expect(exportModuleViolation('src/view/Dashboard.tsx')).toBeNull();
  });
});
