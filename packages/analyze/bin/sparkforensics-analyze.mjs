#!/usr/bin/env node
// Alias bin: runs sparkforensics-cli's sparkforensics-analyze with the same
// arguments and stdio, and exits with its exit code (or re-raises its signal).
// packages/analyze and packages/sparkforensics ship this same file.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const cliManifestPath = require.resolve('sparkforensics-cli/package.json');
const cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8'));
const cliBin = join(dirname(cliManifestPath), cliManifest.bin['sparkforensics-analyze']);

const child = spawn(process.execPath, [cliBin, ...process.argv.slice(2)], { stdio: 'inherit' });

// Ctrl-C already reaches the child through the terminal's process group; a
// signal sent to this process alone is passed on. Either way this process
// stays alive until the child exits, so it can report the child's status.
const forward = (signal) => child.kill(signal);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, forward);

child.on('error', (err) => {
  process.stderr.write(`sparkforensics-analyze: could not start sparkforensics-cli: ${err.message}\n`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.removeListener(signal, forward);
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code;
});
