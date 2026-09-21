import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { packAndInstall } from '../../../tests/helpers/pack-and-install.js';

const execFileAsync = promisify(execFile);

// Regression test for the published `npx sparkforensics-server` entry: npm's
// `bin` field installs a node_modules/.bin/ symlink, so the target needs a
// shebang and an entry guard robust to argv[1] being that symlink path.
// `node server/index.js` never exercises either; this spawns the real installed
// `.bin` symlink as a child process, like `npx` would.

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(serverDir, 'public');
const vendorCoreDir = join(serverDir, 'vendor-core');
const cleanupDirs = [];

afterAll(() => {
  rmSync(publicDir, { recursive: true, force: true });
  rmSync(vendorCoreDir, { recursive: true, force: true });
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe('published bin entrypoint', () => {
  it(
    'starts and serves the frontend when invoked via the installed .bin symlink',
    async () => {
      const binPath = packAndInstall(serverDir, 'sparkforensics-server', cleanupDirs);

      const port = 20000 + Math.floor(Math.random() * 10000);
      const child = spawn(binPath, ['--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnError = null;
      child.on('error', (err) => { spawnError = err; });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      try {
        const deadline = Date.now() + 10000;
        let res;
        let lastErr;
        while (Date.now() < deadline && !res) {
          if (spawnError || child.exitCode !== null) {
            throw new Error(`bin process failed to start: ${spawnError?.message ?? ''}\n${stderr}`);
          }
          try {
            res = await fetch(`http://127.0.0.1:${port}/`);
          } catch (err) {
            lastErr = err;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        if (!res) throw lastErr ?? new Error('bin process never responded');

        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('<title>SparkForensics</title>');

        // Round-trip the /mcp route too, so a regression in vendored
        // mcp-server-factory.js resolution is caught here, not only manually.
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          'compare_runs', 'diagnose_run', 'evaluate_budgets', 'get_finding_documentation', 'get_finding_evidence', 'get_reference_doc', 'get_run_summary', 'list_runs',
        ]);
        await client.close();
      } finally {
        child.kill();
      }
    },
    30000,
  );

  it(
    'prints usage on --help instead of starting the server',
    async () => {
      const binPath = packAndInstall(serverDir, 'sparkforensics-server', cleanupDirs);
      const port = 20000 + Math.floor(Math.random() * 10000);

      const { stderr } = await execFileAsync(binPath, ['--help', '--port', String(port)]);
      expect(stderr).toMatch(/Usage: sparkforensics-server/);
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    },
    30000,
  );
});
