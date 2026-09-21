import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Packs and installs a package's real published tarball into a scratch dir,
// the only way to exercise its `files` allowlist, `prepack` vendoring, and the
// installed `.bin` symlink like `npx` would. `cleanupDirs` is the caller's
// afterAll-drained array.
export function packAndInstall(packageDir, binName, cleanupDirs) {
  const packOutDir = mkdtempSync(join(tmpdir(), `${binName}-pack-`));
  cleanupDirs.push(packOutDir);
  const packOutput = execFileSync(
    'npm', ['pack', '--json', '--pack-destination', packOutDir], { cwd: packageDir },
  ).toString();
  // `npm pack` runs prepack first, whose console output lands on stdout ahead
  // of npm's --json payload. Slice from the line that is exactly `[` (not the
  // first `[` char: build output has bracket-bearing text like `[plugin:...]`).
  const packLines = packOutput.split('\n');
  const jsonStart = packLines.findIndex((line) => line.trim() === '[');
  const packMetadata = JSON.parse(packLines.slice(jsonStart).join('\n'));
  const [{ filename }] = Array.isArray(packMetadata) ? packMetadata : Object.values(packMetadata);
  const tarballPath = join(packOutDir, filename);

  const installDir = mkdtempSync(join(tmpdir(), `${binName}-install-`));
  cleanupDirs.push(installDir);
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: `${binName}-test-host`, private: true }));
  execFileSync('npm', ['install', tarballPath], { cwd: installDir });

  const binPath = join(installDir, 'node_modules', '.bin', binName);
  if (!existsSync(binPath)) {
    throw new Error(`expected installed bin at ${binPath} after npm pack + npm install`);
  }
  return binPath;
}
