// Contract test: a REGISTRY widget maps 1:1 to a finding type, so its
// TagBadge (the ALL-CAPS tag pill) is always the same for every row it
// shows, it belongs once, in the WidgetCard header (`badges=`), not
// repeated per row. Per-row severity still needs flagging (CLAUDE.md: "flag
// every affected stage, never just the worst"), but that's ImpactDot's job
// (the plain colored-dot half of TagBadge), not a second TagBadge. Blunt
// literal-text scan over each widget's source file, not a runtime or AST test.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { orderedWidgets } from '../../src/view/detector-registry';

// jsdom's URL shim mis-resolves `new URL('.', import.meta.url)`; derive the dir from this file's path.
const widgetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/view/widgets');

// Finds every `badges={...}` prop value's [start, end) character range in
// `source`, matching braces by hand rather than regex, since the value is
// arbitrary JSX (fragments, ternaries, nested braces) that a lazy regex
// can't bound correctly.
function findBadgesPropRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const marker = 'badges={';
  let searchFrom = 0;
  for (;;) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) break;
    let depth = 1;
    let i = start + marker.length;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    ranges.push([start, i]);
    searchFrom = i;
  }
  return ranges;
}

describe('single tag per widget (source scan)', () => {
  test('every REGISTRY widget renders exactly one TagBadge', () => {
    const widgets = orderedWidgets();
    // Guard the premise: an empty/broken registry would make every assertion below vacuously pass.
    expect(widgets.length).toBeGreaterThan(0);

    const missingFile: string[] = [];
    const wrongCount: string[] = [];
    const notInHeader: string[] = [];

    for (const { component } of widgets) {
      // React.memo-wrapped widgets have no function `.name`; they carry it on `.displayName`.
      const name = (component as { displayName?: string }).displayName ?? component.name;
      const filePath = resolve(widgetsDir, `${name}.tsx`);
      if (!existsSync(filePath)) {
        missingFile.push(`${name} -> ${filePath}`);
        continue;
      }

      let source = readFileSync(filePath, 'utf8');
      // A widget file may be a thin wrapper with no WidgetCard of its own,
      // delegating its whole body to a shared sibling module (e.g.
      // Skew.tsx/StageShape.tsx/TinyTask.tsx -> StageFindingGroup.tsx): follow
      // one level of local relative imports in that case so the scan sees the
      // real tag. A file that already renders its own <WidgetCard> (e.g.
      // Spill.tsx, PartitionSizing.tsx, ShuffleIO.tsx importing PlanView.tsx
      // for an unrelated plan-explorer utility) must NOT also pull in a
      // sibling's TagBadge count this way.
      if (!source.includes('<WidgetCard')) {
        for (const [, relativeImport] of source.matchAll(/from ['"](\.\/[^'"]+)['"]/g)) {
          const sharedPath = resolve(widgetsDir, `${relativeImport}.tsx`);
          if (existsSync(sharedPath)) source += '\n' + readFileSync(sharedPath, 'utf8');
        }
      }

      const tagIndices: number[] = [];
      let searchFrom = 0;
      for (;;) {
        const idx = source.indexOf('<TagBadge', searchFrom);
        if (idx === -1) break;
        tagIndices.push(idx);
        searchFrom = idx + 1;
      }

      if (tagIndices.length !== 1) {
        wrongCount.push(`${name}.tsx (found ${tagIndices.length})`);
        continue;
      }

      const badgesRanges = findBadgesPropRanges(source);
      const [tagIndex] = tagIndices;
      const inHeader = badgesRanges.some(([start, end]) => tagIndex >= start && tagIndex < end);
      if (!inHeader) {
        notInHeader.push(`${name}.tsx`);
      }
    }

    expect(missingFile, `component.name -> file mapping broke for: ${missingFile.join(', ')}`).toEqual([]);

    const violations = [
      ...wrongCount.map((w) => `${w}, doesn't render exactly one TagBadge (0 = missing entirely, 2+ = duplicated per row)`),
      ...notInHeader.map((w) => `${w}, its one TagBadge sits outside the WidgetCard "badges" prop, so it never shows while collapsed`),
    ];
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
