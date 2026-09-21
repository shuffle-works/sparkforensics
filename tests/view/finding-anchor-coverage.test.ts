// Contract test: any REGISTRY-listed widget with a paginated / reveal-more
// control must also wire `useFindingAnchor`, or triage routing to anything
// behind that control silently degrades to scroll-to-title. Blunt literal-text
// scan over each widget's source file, not a runtime or AST test.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { orderedWidgets } from '../../src/view/detector-registry';

// jsdom's URL shim mis-resolves `new URL('.', import.meta.url)`; derive the dir from this file's path.
const widgetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/view/widgets');

const PAGINATION_MARKERS = ['usePagedRows', 'RowPagination'];

// CoreUsageArea.tsx paginates derived per-stage stats, not catalog findings,
// so it has nothing for useFindingAnchor to anchor onto and is never routable.
const EXEMPT_WIDGETS = new Set(['CoreUsageArea.tsx']);

describe('finding-anchor coverage (source scan)', () => {
  test('every widget file paginating/revealing findings also wires useFindingAnchor', () => {
    const widgets = orderedWidgets();
    // Guard the premise: an empty/broken registry would make every assertion below vacuously pass.
    expect(widgets.length).toBeGreaterThan(0);

    const missingFile: string[] = [];
    const uncovered: string[] = [];

    for (const { component } of widgets) {
      // React.memo-wrapped widgets have no function `.name`; they carry it on `.displayName`.
      const name = (component as { displayName?: string }).displayName ?? component.name;
      const filePath = resolve(widgetsDir, `${name}.tsx`);
      if (!existsSync(filePath)) {
        missingFile.push(`${name} -> ${filePath}`);
        continue;
      }

      // A widget file may be a thin wrapper delegating its row/pagination
      // scaffold to a shared sibling module (e.g. Skew.tsx/StageShape.tsx/
      // TinyTask.tsx -> StageFindingGroup.tsx): follow one level of local
      // relative imports so the scan still sees the real wiring instead of
      // silently reporting "no pagination" for every such wrapper.
      let source = readFileSync(filePath, 'utf8');
      for (const [, relativeImport] of source.matchAll(/from ['"](\.\/[^'"]+)['"]/g)) {
        const sharedPath = resolve(widgetsDir, `${relativeImport}.tsx`);
        if (existsSync(sharedPath)) source += '\n' + readFileSync(sharedPath, 'utf8');
      }

      const hasPagination = PAGINATION_MARKERS.some((marker) => source.includes(marker));
      // useAnchoredRow wraps useFindingAnchor, so wiring it satisfies this contract too.
      const wiresAnchor = source.includes('useFindingAnchor') || source.includes('useAnchoredRow');
      if (hasPagination && !wiresAnchor && !EXEMPT_WIDGETS.has(`${name}.tsx`)) {
        uncovered.push(`${name}.tsx`);
      }
    }

    expect(missingFile, `component.name -> file mapping broke for: ${missingFile.join(', ')}`).toEqual([]);
    expect(
      uncovered,
      `widget file(s) use pagination/reveal-more but never wire useFindingAnchor: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });
});
