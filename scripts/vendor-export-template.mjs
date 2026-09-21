// Builds the export-html template (vite.export.config.ts) and copies its
// output into packages/cli/export-template/, so a published sparkforensics-
// analyze tarball ships a pre-built export template. Mirrors packages/server/
// scripts/copy-frontend.js's frontend-vendoring pattern; see vendor-core.mjs
// for the sibling core-vendoring step also run at packages/cli's prepack.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const templateDir = join(repoRoot, 'packages', 'cli', 'export-template');

execSync('npm run build:export', { cwd: repoRoot, stdio: 'inherit' });

rmSync(templateDir, { recursive: true, force: true });
mkdirSync(templateDir, { recursive: true });
cpSync(join(repoRoot, 'dist-export'), templateDir, { recursive: true });

console.log('Copied dist-export/ into packages/cli/export-template/');
