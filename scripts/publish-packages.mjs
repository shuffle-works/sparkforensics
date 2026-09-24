// Invoked by changesets/action's `publish` step after `changeset version` bumps
// the changed packages. Dry-runs each first (catches a broken files/vendor-core
// setup before shipping), then publishes. Auth via Trusted Publishing (OIDC).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep in sync with the publishable-path regex in scripts/check-changeset.sh
// and the mcp-package-name check in .github/workflows/release.yml: a new
// package would need updating in all three places. analyze and sparkforensics
// are aliases that depend on sparkforensics-cli, so they come after cli.
const PACKAGES = ['cli', 'analyze', 'sparkforensics', 'mcp', 'server'];

function publishedVersion(name) {
  try {
    return execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    // Only a specific E404 means "never published". Registry/network/auth
    // hiccups also throw here; treating those as "not published yet" would let
    // the publish below run over an already-live version. Rethrow anything else.
    const stderr = err.stderr?.toString() ?? '';
    const isNotFound = stderr.includes('E404') || stderr.includes('is not in this registry');
    if (isNotFound) {
      return null;
    }
    throw err;
  }
}

// changesets/action@v2 sets CHANGESETS_OUTPUT to an NDJSON file path and, after
// this script exits, reads one `git-tag` record per published package from it
// to push tags, create GitHub Releases and fill its `publishedPackages` output.
// Same record shape the Changesets CLI writes (packages/cli/src/utils/output.ts
// in changesets/changesets). Unset outside the action: then write nothing.
export function recordPublishedTag(outputPath, name, version) {
  if (!outputPath) return;
  const record = { type: 'git-tag', tag: `${name}@${version}`, packageName: name };
  appendFileSync(outputPath, `${JSON.stringify(record)}\n`);
}

// A package whose dependency failed to publish in this run would point at a
// version missing from the registry, so it must not be published either.
export function failedDependency(manifest, failedNames) {
  return Object.keys(manifest.dependencies ?? {}).find((dep) => failedNames.has(dep));
}

function main() {
  const outputPath = process.env.CHANGESETS_OUTPUT;
  // Create the file up front, like the Changesets CLI does, so a run that
  // publishes nothing leaves an empty report instead of a "failed to read" warning.
  if (outputPath) appendFileSync(outputPath, '');

  const results = { published: [], skipped: [], failed: [] };
  const failedNames = new Set();

  for (const pkg of PACKAGES) {
    const dir = join('packages', pkg);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const { name, version } = manifest;

    try {
      if (publishedVersion(name) === version) {
        console.log(`${name}@${version} already published, skipping.`);
        results.skipped.push(`${name}@${version}`);
        continue;
      }

      const blockedBy = failedDependency(manifest, failedNames);
      if (blockedBy) {
        throw new Error(`dependency ${blockedBy} failed to publish in this run`);
      }

      console.log(`Dry-run publishing ${name}@${version}...`);
      execFileSync('npm', ['publish', '--dry-run', '--provenance'], { cwd: dir, stdio: 'inherit' });

      console.log(`Publishing ${name}@${version}...`);
      execFileSync('npm', ['publish', '--provenance'], { cwd: dir, stdio: 'inherit' });

      // Log line only: changesets/action v1 scraped stdout for it, v2 reads the
      // CHANGESETS_OUTPUT record written here instead.
      console.log(`New tag: ${name}@${version}`);
      recordPublishedTag(outputPath, name, version);
      results.published.push(`${name}@${version}`);
    } catch (err) {
      // One package's failure must not abort the loop: packages that don't
      // depend on it still publish. Record it and move on; the summary below
      // still exits non-zero.
      console.error(`Failed to publish ${name}@${version}:`, err.message);
      results.failed.push(`${name}@${version}`);
      failedNames.add(name);
    }
  }

  console.log('\nPublish summary:');
  console.log(`  Published: ${results.published.join(', ') || '(none)'}`);
  console.log(`  Skipped (already published): ${results.skipped.join(', ') || '(none)'}`);
  console.log(`  Failed: ${results.failed.join(', ') || '(none)'}`);

  if (results.failed.length > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) main();
