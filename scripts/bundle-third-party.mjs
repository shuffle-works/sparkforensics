// Bundles every third-party package that <package-dir>/vendor-core/ imports into
// vendor-core/third-party/, so the published tarball needs no runtime dependencies and
// every release runs the same dependency code. Run at `prepack` after vendor-core.mjs.
//
// Each bare specifier a vendored file imports (zod, an MCP SDK subpath) becomes one entry of a
// single esbuild run with code splitting, so packages share one copy of their common code (the
// SDK's zod and the core's zod are the same module). The vendored files are then rewritten to
// import those bundles by relative path, and THIRD-PARTY-LICENSES.txt in the package directory
// carries the license text of every package that went into a bundle.
//
// Usage: node scripts/bundle-third-party.mjs <package-dir> [vendor-core file to leave out...]
// A package leaves out the vendored files it never loads (the CLI's lazy MCP server factory), so
// their third-party imports are not bundled.
import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const THIRD_PARTY_DIR = 'third-party';
export const LICENSES_FILE = 'THIRD-PARTY-LICENSES.txt';

// Static (`from '...'`) and dynamic (`import('...')`) specifiers that are neither relative nor node: builtins.
const BARE_SPECIFIER = /((?:from\s+|import\(\s*)['"])([^'".][^'"]*)(['"])/g;

/** @param {string} dir @returns {string[]} */
function listJsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === THIRD_PARTY_DIR ? [] : listJsFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

/** @param {string} specifier */
const isBareSpecifier = (specifier) => !specifier.startsWith('node:');

/** Bundle path of a specifier, relative to the third-party directory, without extension. */
const bundleName = (/** @type {string} */ specifier) => specifier.replace(/\.js$/, '');

/** @param {string} code */
function bareSpecifiers(code) {
  return [...code.matchAll(BARE_SPECIFIER)].map((m) => m[2]).filter(isBareSpecifier);
}

/** The package directory (relative to `cwd`) that holds a metafile input path under node_modules. */
function packageDirOf(/** @type {string} */ inputPath) {
  const marker = inputPath.lastIndexOf('node_modules/');
  if (marker === -1) return null;
  const rest = inputPath.slice(marker + 'node_modules/'.length).split('/');
  const nameParts = rest[0].startsWith('@') ? 2 : 1;
  return inputPath.slice(0, marker) + 'node_modules/' + rest.slice(0, nameParts).join('/');
}

/** @param {string} packageDir absolute */
function readLicenseEntry(packageDir) {
  const { name, version, license } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const licenseFile = readdirSync(packageDir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  if (!licenseFile) throw new Error(`bundled package ${name}@${version} has no license file in ${packageDir}`);
  const text = readFileSync(join(packageDir, licenseFile), 'utf8').trim();
  return `${name}@${version} (${license})\n${'-'.repeat(40)}\n${text}\n`;
}

/**
 * @param {string} packageDir
 * @param {string[]} [omitFiles] vendor-core-relative paths removed before bundling
 */
export async function bundleThirdParty(packageDir, omitFiles = []) {
  const pkgDir = resolve(packageDir);
  const vendorDir = join(pkgDir, 'vendor-core');
  const outDir = join(vendorDir, THIRD_PARTY_DIR);
  if (!existsSync(vendorDir)) throw new Error(`${vendorDir} does not exist; run scripts/vendor-core.mjs first`);

  for (const file of omitFiles) rmSync(join(vendorDir, file));
  const files = listJsFiles(vendorDir);
  const specifiers = [...new Set(files.flatMap((f) => bareSpecifiers(readFileSync(f, 'utf8'))))].sort();

  rmSync(outDir, { recursive: true, force: true });
  const result = await build({
    absWorkingDir: pkgDir,
    entryPoints: Object.fromEntries(specifiers.map((s) => [bundleName(s), s])),
    outdir: outDir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    // Some bundled packages are CommonJS and call require() on node builtins.
    banner: { js: "import { createRequire as __sfCreateRequire } from 'node:module'; const require = __sfCreateRequire(import.meta.url);" },
    metafile: true,
    logLevel: 'warning',
  });

  for (const file of files) {
    const rewritten = readFileSync(file, 'utf8').replace(BARE_SPECIFIER, (match, open, specifier, close) => {
      if (!isBareSpecifier(specifier)) return match;
      let target = relative(dirname(file), join(outDir, `${bundleName(specifier)}.js`));
      if (!target.startsWith('.')) target = `./${target}`;
      return `${open}${target}${close}`;
    });
    writeFileSync(file, rewritten);
  }

  const packageDirs = new Set(
    Object.keys(result.metafile.inputs).map(packageDirOf).filter((d) => d !== null),
  );
  const notices = [...packageDirs].sort().map((d) => readLicenseEntry(join(pkgDir, d)));
  writeFileSync(
    join(pkgDir, LICENSES_FILE),
    `This package bundles the following third-party software.\n\n${notices.join('\n')}`,
  );
  return { specifiers, packages: packageDirs.size };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const targetPackageDir = process.argv[2];
  if (!targetPackageDir) {
    console.error('Usage: node scripts/bundle-third-party.mjs <path-to-package-dir>');
    process.exit(1);
  }
  const { specifiers, packages } = await bundleThirdParty(targetPackageDir, process.argv.slice(3));
  console.log(`Bundled ${specifiers.length} entries (${packages} packages) into ${join(targetPackageDir, 'vendor-core', THIRD_PARTY_DIR)}`);
}
