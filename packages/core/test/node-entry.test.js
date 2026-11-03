import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The CLI and MCP bins load core through node.ts and read every core name from that one module.
// Each bin must start from the source tree and print its usage.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BINS = [
  { bin: 'packages/cli/bin/sparkforensics-analyze.mjs', usage: 'Usage: sparkforensics-analyze' },
  { bin: 'packages/mcp/bin/sparkforensics-mcp.mjs', usage: 'Usage: sparkforensics-mcp' },
];

describe('the CLI and MCP bins', () => {
  it.each(BINS)('$bin starts and prints its usage', ({ bin, usage }) => {
    const result = spawnSync(process.execPath, [path.join(root, bin), '--help'], { encoding: 'utf8', timeout: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(usage);
  }, 60_000);
});
