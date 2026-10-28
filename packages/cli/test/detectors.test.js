import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDetectorCatalog } from '@sparkforensics/core/detector-catalog.ts';
import { main } from '../bin/sparkforensics-analyze.mjs';

// `sparkforensics-analyze detectors`, run in process: the bin's wiring (stdout, exit code, --out, the usage text).
// The argument parsing is covered in packages/core/test/detectors-command.test.js.
async function run(argv) {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await main(argv);
    return { status: process.exitCode, stdout: out.mock.calls.map(([c]) => c).join(''), stderr: err.mock.calls.map(([c]) => c).join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = previous;
  }
}

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-detectors-'));
  dirs.push(dir);
  return dir;
};

describe('sparkforensics-analyze detectors', () => {
  it('prints the whole catalog as JSON by default', async () => {
    const { status, stdout, stderr } = await run(['detectors']);
    expect(status).toBe(0);
    expect(stderr).toBe('');
    const result = JSON.parse(stdout);
    expect(result.count).toBe(buildDetectorCatalog().length);
    expect(result.detectors.map((r) => r.type)).toEqual(buildDetectorCatalog().map((r) => r.type));
  });

  it('writes to --out instead of stdout', async () => {
    const out = join(tmp(), 'detectors.json');
    const { status, stdout } = await run(['detectors', '--type', 'gc', '--out', out]);
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(JSON.parse(readFileSync(out, 'utf8')).detectors[0].type).toBe('gc');
  });

  it('exits 2 with the usage text for a bad flag value', async () => {
    const { status, stdout, stderr } = await run(['detectors', '--type', 'nope']);
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/--type: unknown value "nope"[\s\S]*Usage: sparkforensics-analyze detectors/);
  });

  it('refuses an --out folder that does not exist', async () => {
    const { status, stderr } = await run(['detectors', '--out', join(tmp(), 'missing', 'out.json')]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/--out: .* does not exist/);
  });

  it('names the budget flags the catalog reports in the analyze usage text', async () => {
    const { stderr } = await run(['--help']);
    expect(stderr).toContain('sparkforensics-analyze detectors [options]');
    for (const { gate } of buildDetectorCatalog()) {
      if (gate) expect(stderr, gate.cliFlag).toContain(gate.cliFlag);
    }
  });
});
