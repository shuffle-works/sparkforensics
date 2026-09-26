import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coreSourceHash, resolveVendored, SOURCE_HASH_FILE } from '../src/load-vendored.js';

// A monorepo-shaped tree: <root>/core/src next to <root>/<pkg>/vendor-core.
function tree(stamp, { monorepo = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sparkforensics-vendored-'));
  const srcDir = join(root, 'core', 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'analyzer.ts'), 'export const v = 2;\n');
  if (monorepo) writeFileSync(join(srcDir, 'load-vendored.js'), '');
  const pkgDir = join(root, 'pkg');
  mkdirSync(join(pkgDir, 'vendor-core'), { recursive: true });
  writeFileSync(join(pkgDir, 'vendor-core', 'analyzer.js'), 'export const v = 1;\n');
  if (stamp !== undefined) writeFileSync(join(pkgDir, 'vendor-core', SOURCE_HASH_FILE), `${stamp ?? coreSourceHash(srcDir)}\n`);
  return { root, srcDir, pkgDir };
}

describe('resolveVendored in a monorepo checkout', () => {
  const dirs = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('uses a vendor-core built from the current core/src, silently', () => {
    const { root, pkgDir } = tree(null);
    dirs.push(root);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(resolveVendored(pkgDir, 'analyzer')).toBe(join(pkgDir, 'vendor-core', 'analyzer.js'));
    expect(stderr).not.toHaveBeenCalled();
  });

  it('says so and loads core/src when vendor-core is stale or unstamped', () => {
    for (const stamp of ['0000', undefined]) {
      const { root, srcDir, pkgDir } = tree(stamp);
      dirs.push(root);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(resolveVendored(pkgDir, 'analyzer')).toBe(join(srcDir, 'analyzer.ts'));
      expect(resolveVendored(pkgDir, 'analyzer')).toBe(join(srcDir, 'analyzer.ts'));
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0][0])).toMatch(/built from older packages\/core sources/);
      vi.restoreAllMocks();
    }
  });

  it('uses vendor-core, silently, when the sibling core/src belongs to an unrelated package', () => {
    const { root, pkgDir } = tree(undefined, { monorepo: false });
    dirs.push(root);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(resolveVendored(pkgDir, 'analyzer')).toBe(join(pkgDir, 'vendor-core', 'analyzer.js'));
    expect(stderr).not.toHaveBeenCalled();
  });
});
