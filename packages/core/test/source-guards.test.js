import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The site (/src) reaches core through named entry points only; rules/core-entry-points-only.yml
// rejects any other core specifier. `cli`, `mcp` and `node` are Node-only entry points.
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ENTRY_POINTS = ['analysis', 'browser', 'export', 'types', 'view-model'];

describe('core entry points', () => {
  it('the exports map names explicit entry points, each a file, and no wildcard', () => {
    const { exports } = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    for (const [name, target] of Object.entries(exports)) {
      expect(name).not.toContain('*');
      expect(existsSync(path.resolve(packageDir, target)), `${name} -> ${target}`).toBe(true);
    }
    expect(Object.keys(exports)).toEqual(expect.arrayContaining(SITE_ENTRY_POINTS.map((name) => `./${name}`)));
  });
});
