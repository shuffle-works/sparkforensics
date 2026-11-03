import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Structural guards over the core sources: each fails on a shape that hides a type error or couples
// modules the architecture keeps apart.

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir = srcDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|js)$/.test(entry.name) ? [full] : [];
  });
}

describe('type escape hatches', () => {
  // The count may fall, never rise: a new `as unknown as` bridges two shapes the compiler cannot
  // relate, and each one is a place a renamed field compiles and goes quiet.
  const MAX_UNKNOWN_CASTS = 13;

  it('does not add `as unknown as` casts to core sources', () => {
    const hits = sourceFiles().flatMap((file) => {
      const count = (readFileSync(file, 'utf8').match(/\bas unknown as\b/g) ?? []).length;
      return count > 0 ? [`${path.relative(srcDir, file)}: ${count}`] : [];
    });
    const total = hits.reduce((sum, hit) => sum + Number(hit.split(': ')[1]), 0);
    expect(total, `casts through unknown:\n${hits.join('\n')}`).toBeLessThanOrEqual(MAX_UNKNOWN_CASTS);
  });
});
