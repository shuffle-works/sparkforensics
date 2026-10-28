import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDetectorCatalog } from '../src/detector-catalog.js';
import { DETECTORS_USAGE, runDetectorsCommand } from '../src/cli/detectors-command.js';

const types = (result) => JSON.parse(result.stdout).detectors.map((r) => r.type);

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runDetectorsCommand', () => {
  it('returns the whole catalog as JSON by default', () => {
    const result = runDetectorsCommand([]);
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(JSON.stringify({ count: buildDetectorCatalog().length, detectors: buildDetectorCatalog() })));
    expect(result.outPath).toBeUndefined();
  });

  it('filters by type, tag (in any case), family and scope', () => {
    expect(types(runDetectorsCommand(['--type', 'spill']))).toEqual(['spill']);
    expect(types(runDetectorsCommand(['--tag', 'util']))).toEqual(['utilization', 'rightSizing']);
    expect(JSON.parse(runDetectorsCommand(['--family', 'setup', '--scope', 'config']).stdout).count).toBe(1);
  });

  it('prints Markdown with --format md', () => {
    const { stdout } = runDetectorsCommand(['--family', 'cost', '--format', 'md']);
    expect(stdout).toMatch(/^# Detectors \(\d+\)\n\n## Cost\n/);
    expect(stdout).toContain('`--min-efficiency`');
  });

  it('hands --out back to the caller to write', () => {
    expect(runDetectorsCommand(['--type', 'gc', '--out', 'detectors.json']).outPath).toBe('detectors.json');
  });

  it('reports the thresholds of a --thresholds file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-detectors-'));
    dirs.push(dir);
    const file = join(dir, 'thresholds.json');
    writeFileSync(file, JSON.stringify({ skew: { ratioWarn: 4 } }));
    const [record] = JSON.parse(runDetectorsCommand(['--type', 'skew', '--thresholds', file]).stdout).detectors;
    expect(record.detectors[0].thresholds.ratioWarn).toBe(4);
  });

  it('prints its usage for --help with exit code 0', () => {
    expect(runDetectorsCommand(['--help'])).toEqual({ exitCode: 0, stdout: DETECTORS_USAGE, stderr: '' });
    expect(DETECTORS_USAGE).toMatch(/^Usage: sparkforensics-analyze detectors/);
  });

  it.each([
    [['--type', 'nope'], /--type: unknown value "nope"/],
    [['--tag', 'nope'], /--tag: unknown value "NOPE"/],
    [['--family', 'nope'], /--family: unknown value "nope"/],
    [['--scope', 'nope'], /--scope: unknown value "nope"/],
    [['--format', 'xml'], /Invalid value for --format/],
    [['--bogus'], /Unknown option '--bogus'/],
    [['some.log'], /detectors takes no argument, got "some\.log"/],
    [['--thresholds', '/nonexistent/thresholds.json'], /Cannot read thresholds file/],
    [['--thresholds'], /argument missing/i],
  ])('refuses %j with a usage error', (argv, message) => {
    const result = runDetectorsCommand(argv);
    expect(result).toMatchObject({ exitCode: 2, stdout: '' });
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain(DETECTORS_USAGE);
  });
});
