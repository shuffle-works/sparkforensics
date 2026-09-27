import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { build } from 'vite';
import {
  FORBIDDEN_EXPORT_MODULES, findForbiddenModules, formatViolations,
} from '../scripts/export-analysis-guard.mjs';

const root = path.resolve(import.meta.dirname, '..');
const toRepoPath = (id) => path.relative(root, id.split('?')[0]).split(path.sep).join('/');

describe('export analysis guard', () => {
  it('the real export build reaches no analysis or live-only module', async () => {
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
    expect(moduleIds.filter((id) => FORBIDDEN_EXPORT_MODULES.includes(id))).toEqual([]);
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
      chain: ['src/export/main-export.tsx', 'src/view/Widget.tsx', 'packages/core/src/analyzer.ts'],
    }]);
    expect(formatViolations(violations)).toContain(
      'packages/core/src/analyzer.ts\n    via src/export/main-export.tsx -> src/view/Widget.tsx -> packages/core/src/analyzer.ts',
    );
  });
});
