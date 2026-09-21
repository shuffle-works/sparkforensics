// Plain JS: scripts/vendor-core.mjs copies it byte-for-byte into vendor-core/, so this file exists
// at both vendor-core/load-vendored.js (published) and core/src/load-vendored.js (dev). Each
// package's bin bootstraps by locating this file first, then uses the exports below for every other
// core module, so the resolution logic lives in one place instead of per entry point.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// moduleName is a path relative to core/src without extension, e.g. 'cli/collect-run'. Pass
// srcExt: 'js' for modules already plain JS in core/src (e.g. 'proxy') rather than TypeScript.
export function resolveVendored(pkgDir, moduleName, { srcExt = 'ts' } = {}) {
  const vendored = join(pkgDir, 'vendor-core', `${moduleName}.js`);
  return existsSync(vendored) ? vendored : join(pkgDir, '..', 'core', 'src', `${moduleName}.${srcExt}`);
}

export async function loadVendored(pkgDir, moduleName, opts) {
  return import(pathToFileURL(resolveVendored(pkgDir, moduleName, opts)).href);
}
