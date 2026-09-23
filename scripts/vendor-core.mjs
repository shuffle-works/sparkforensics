// Vendors packages/core/src/ into <target-package-dir>/vendor-core/, pre-
// stripping TypeScript to plain .js. Run at `prepack` by cli/mcp/server so each
// published tarball is self-contained (no git access or build at install time).
// The generated tuning reference under docs-content/ is made to match its pin
// first (strict: no stale cache, no unpinned override), so a pack can never
// silently ship without docs or with the wrong ones.
//
// Node refuses to type-strip .ts under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and a published vendor-core/
// lands there, so pre-strip each .ts with stripTypeScriptTypes and ship .js,
// rewriting its `.ts` import specifiers to `.js` to match.
import { stripTypeScriptTypes } from 'node:module';
import { rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DieError, DOCS_CONTENT_DIR, LOCAL_ONLY_ENTRIES, ensureTuningDocs } from './fetch-tuning-docs.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);
const coreSrcDir = join(repoRoot, 'packages', 'core', 'src');

const targetPackageDir = process.argv[2];
if (!targetPackageDir) {
  console.error('Usage: node scripts/vendor-core.mjs <path-to-package-dir>');
  process.exitCode = 1;
  process.exit();
}
const vendorDir = join(targetPackageDir, 'vendor-core');

// Top-level core/src/ entries that only make sense in a real browser
// (indexedDB) and that no cli/mcp/server entry point imports; excluded from
// published tarballs. Everything else is genuinely shared, even things that
// look browser-only: parser-worker.ts and ingest.ts's routeMessage are both
// reachable from cli/collect-run.ts.
const BROWSER_ONLY_TOP_LEVEL_ENTRIES = new Set([
  'recent-files.ts', // IndexedDB recent-files list
]);

function rewriteImportSpecifiers(code) {
  return code.replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2');
}

function copyTree(srcNode, destNode) {
  for (const entry of readdirSync(srcNode, { withFileTypes: true })) {
    if (srcNode === coreSrcDir && BROWSER_ONLY_TOP_LEVEL_ENTRIES.has(entry.name)) continue;
    // The generated docs' stamp and fetch leftovers describe this checkout's
    // cache, not the docs.
    if (srcNode === DOCS_CONTENT_DIR && LOCAL_ONLY_ENTRIES.has(entry.name)) continue;
    const srcPath = join(srcNode, entry.name);
    const destPath = join(destNode, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyTree(srcPath, destPath);
    } else if (entry.name.endsWith('.ts')) {
      const source = readFileSync(srcPath, 'utf8');
      const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
      const jsPath = destPath.replace(/\.ts$/, '.js');
      writeFileSync(jsPath, rewriteImportSpecifiers(stripped));
    } else {
      // Already-plain-JS vendored file (vendor/fflate.js, vendor/fzstd.js).
      writeFileSync(destPath, rewriteImportSpecifiers(readFileSync(srcPath, 'utf8')));
    }
  }
}

try {
  ensureTuningDocs({ strict: true });
} catch (err) {
  if (!(err instanceof DieError)) throw err;
  console.error(`vendor-core: fetch-tuning-docs: ${err.message}`);
  process.exit(1);
}

rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });
copyTree(coreSrcDir, vendorDir);

console.log(`Vendored packages/core/src/ into ${vendorDir}, stripped TS types to .js`);
