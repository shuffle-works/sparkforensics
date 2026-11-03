// Plain JS: scripts/vendor-core.mjs copies it into vendor-core/ with the rest of core/src, so it
// exists at both vendor-core/load-node-core.js (published) and core/src/load-node-core.js (dev).
// The CLI and MCP bins locate this file (the core/src copy when it exists, else vendor-core/), call
// loadNodeCore once, and read every core export from the one module it returns.
import { coreBuildId, loadVendored } from './load-vendored.js';

/**
 * Loads node.ts (vendor-core/node.js or core/src/node.ts, see load-vendored.js) for the package at
 * `pkgDir`, with the build id of the core it resolved to.
 * @param {string} pkgDir
 * @returns {Promise<{ core: typeof import('./node.ts'), buildId: string }>}
 */
export async function loadNodeCore(pkgDir) {
  const core = await loadVendored(pkgDir, 'node');
  return { core, buildId: coreBuildId(pkgDir) };
}
