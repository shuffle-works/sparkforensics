// Invoked by changesets/action's `publish` step after `changeset version` bumps
// the changed packages. Dry-runs each first (catches a broken files/vendor-core
// setup before shipping), then publishes. Auth via Trusted Publishing (OIDC).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Keep in sync with the publishable-path regex in scripts/check-changeset.sh
// and the mcp-package-name check in .github/workflows/release.yml: a 4th
// package would need updating in all three places.
const PACKAGES = ['cli', 'mcp', 'server'];

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

const results = { published: [], skipped: [], failed: [] };

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

    console.log(`Dry-run publishing ${name}@${version}...`);
    execFileSync('npm', ['publish', '--dry-run', '--provenance'], { cwd: dir, stdio: 'inherit' });

    console.log(`Publishing ${name}@${version}...`);
    execFileSync('npm', ['publish', '--provenance'], { cwd: dir, stdio: 'inherit' });

    // changesets/action scrapes stdout for this exact sentinel to populate its
    // published outputs and know which git tags/Releases to create.
    console.log(`New tag: ${name}@${version}`);
    results.published.push(`${name}@${version}`);
  } catch (err) {
    // One package's failure must not abort the loop; the others are
    // independent. Record it and move on; the summary below still exits non-zero.
    console.error(`Failed to publish ${name}@${version}:`, err.message);
    results.failed.push(`${name}@${version}`);
  }
}

console.log('\nPublish summary:');
console.log(`  Published: ${results.published.join(', ') || '(none)'}`);
console.log(`  Skipped (already published): ${results.skipped.join(', ') || '(none)'}`);
console.log(`  Failed: ${results.failed.join(', ') || '(none)'}`);

if (results.failed.length > 0) {
  process.exit(1);
}
