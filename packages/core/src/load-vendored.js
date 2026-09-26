// Plain JS: scripts/vendor-core.mjs copies it byte-for-byte into vendor-core/, so this file exists
// at both vendor-core/load-vendored.js (published) and core/src/load-vendored.js (dev). Each
// package's bin bootstraps by locating this file first (the core/src copy when it exists, so the
// staleness check below is always current code), then uses the exports below for every other core
// module, so the resolution logic lives in one place instead of per entry point.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Written into vendor-core/ by scripts/vendor-core.mjs: the coreSourceHash of the core/src it was
// built from, so a monorepo run can tell a leftover vendored copy from a current one.
export const SOURCE_HASH_FILE = 'core-source-hash.txt';

// docs-content/ is generated from a pinned upstream commit, not analysis code.
const UNHASHED_TOP_LEVEL = new Set(['docs-content']);

/** A content hash of every analysis source file under core/src (paths and bytes, sorted). */
export function coreSourceHash(coreSrcDir) {
  const hash = createHash('sha256');
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (dir === coreSrcDir && UNHASHED_TOP_LEVEL.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(`${relative(coreSrcDir, path)}\0`).update(readFileSync(path)).update('\0');
    }
  };
  walk(coreSrcDir);
  return hash.digest('hex');
}

// One decision per package per process, so the hash runs and the warning prints once.
const useVendoredByPkg = new Map();

// A published install has only vendor-core/. In the monorepo, vendor-core/ is a leftover from a
// local `npm pack` (it is rebuilt only at prepack), so it is used only while it still matches
// core/src; otherwise the run says so on stderr and loads core/src, rather than silently running
// outdated detectors.
function useVendored(pkgDir) {
  if (useVendoredByPkg.has(pkgDir)) return useVendoredByPkg.get(pkgDir);
  const vendorDir = join(pkgDir, 'vendor-core');
  const srcDir = join(pkgDir, '..', 'core', 'src');
  let use = existsSync(vendorDir);
  if (use && existsSync(join(srcDir, 'load-vendored.js'))) {
    const stampPath = join(vendorDir, SOURCE_HASH_FILE);
    const stamp = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : null;
    if (stamp !== coreSourceHash(srcDir)) {
      process.stderr.write(
        `sparkforensics: ${vendorDir} was built from older packages/core sources, so it would run outdated analysis. `
        + `Using packages/core/src instead; rebuild it with \`node scripts/vendor-core.mjs ${pkgDir}\` or delete it.\n`,
      );
      use = false;
    }
  }
  useVendoredByPkg.set(pkgDir, use);
  return use;
}

// moduleName is a path relative to core/src without extension, e.g. 'cli/collect-run'. Pass
// srcExt: 'js' for modules already plain JS in core/src (e.g. 'proxy') rather than TypeScript.
export function resolveVendored(pkgDir, moduleName, { srcExt = 'ts' } = {}) {
  const vendored = join(pkgDir, 'vendor-core', `${moduleName}.js`);
  return useVendored(pkgDir) && existsSync(vendored) ? vendored : join(pkgDir, '..', 'core', 'src', `${moduleName}.${srcExt}`);
}

export async function loadVendored(pkgDir, moduleName, opts) {
  return import(pathToFileURL(resolveVendored(pkgDir, moduleName, opts)).href);
}
