import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packAndInstall } from '../../../tests/helpers/pack-and-install.js';

const execFileAsync = promisify(execFile);

const packageDir = process.cwd();
const cleanupDirs = [];
let binPath;
let client;

// Packed and installed once for the whole suite, not per test: each pack+install
// redoes a full tarball build and npm install.
beforeAll(() => {
  binPath = packAndInstall(packageDir, 'sparkforensics-mcp', cleanupDirs);
}, 30000);

afterEach(async () => {
  if (client) await client.close();
  client = undefined;
});

afterAll(() => {
  rmSync(join(packageDir, 'vendor-core'), { recursive: true, force: true });
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe('published sparkforensics-mcp stdio bin entrypoint', () => {
  it('starts and lists all 8 tools over stdio via the installed .bin symlink', async () => {
    const transport = new StdioClientTransport({ command: binPath, args: [] });
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compare_runs', 'diagnose_run', 'evaluate_budgets', 'get_finding_documentation', 'get_finding_evidence', 'get_reference_doc', 'get_run_summary', 'list_runs',
    ]);
  }, 30000);

  it('surfaces run-not-found as isError with structuredContent.code', async () => {
    const transport = new StdioClientTransport({ command: binPath, args: [] });
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'diagnose_run', arguments: { runId: 'nonexistent' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('run-not-found');
  }, 30000);

  it('get_finding_documentation returns detection reference doc content for a finding type', async () => {
    const transport = new StdioClientTransport({ command: binPath, args: [] });
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'get_finding_documentation', arguments: { type: 'skew' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.detectionDoc.content.length).toBeGreaterThan(0);
  }, 30000);

  it('get_reference_doc returns chapter markdown by anchor', async () => {
    const transport = new StdioClientTransport({ command: binPath, args: [] });
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'get_reference_doc', arguments: { anchor: '#joins' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.anchor).toBe('joins');
    expect(result.structuredContent.content.length).toBeGreaterThan(0);
  }, 30000);

  it('prints usage on --help instead of starting the stdio server', async () => {
    const { stderr } = await execFileAsync(binPath, ['--help']);
    expect(stderr).toMatch(/Usage: sparkforensics-mcp/);
  }, 10000);

  it('--help lists exactly the tools the server registers', async () => {
    const { stderr } = await execFileAsync(binPath, ['--help']);
    const transport = new StdioClientTransport({ command: binPath, args: [] });
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const listed = stderr.match(/exposes (\d+) tools[^:]*:\s*([^.]+)\./);
    expect(listed).not.toBeNull();
    const helpNames = listed[2].split(',').map((name) => name.trim());
    expect(Number(listed[1])).toBe(tools.length);
    expect(helpNames.sort()).toEqual(tools.map((t) => t.name).sort());
  }, 30000);
});
