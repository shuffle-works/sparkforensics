// Builds the Vite frontend and copies dist/ into server/public/ so the
// published package is self-contained. Run at prepack (covers both npm pack
// and publish, unlike prepublishOnly).
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(serverDir, '..', '..');
const publicDir = join(serverDir, 'public');

execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });

rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });
cpSync(join(repoRoot, 'dist'), publicDir, { recursive: true });

console.log('Copied dist/ into server/public/');
