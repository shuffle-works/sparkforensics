import { describe, it, expect } from 'vitest';
import { buildDetectorCatalog } from '../src/detector-catalog.js';
import { DETECTORS_USAGE, runDetectorsCommand } from '../src/cli/detectors-command.js';

const types = (result) => JSON.parse(result.stdout).detectors.map((r) => r.type);

describe('runDetectorsCommand', () => {
  it('returns the whole catalog as JSON by default', () => {
    const result = runDetectorsCommand([]);
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(JSON.stringify({ count: buildDetectorCatalog().length, detectors: buildDetectorCatalog() })));
  });

  it('keeps only the --type record', () => {
    expect(types(runDetectorsCommand(['--type', 'spill']))).toEqual(['spill']);
  });

  it('prints Markdown with --format md', () => {
    const { stdout } = runDetectorsCommand(['--type', 'utilization', '--format', 'md']);
    expect(stdout).toMatch(/^# Detectors \(1\)\n\n## Cost\n/);
    expect(stdout).toContain('`--min-efficiency`');
  });

  it('prints its usage for --help with exit code 0', () => {
    expect(runDetectorsCommand(['--help'])).toEqual({ exitCode: 0, stdout: DETECTORS_USAGE, stderr: '' });
    expect(DETECTORS_USAGE).toMatch(/^Usage: sparkforensics-analyze detectors/);
  });

  it.each([
    [['--type', 'nope'], /--type: unknown value "nope"/],
    [['--format', 'xml'], /Invalid value for --format/],
    [['--bogus'], /Unknown option '--bogus'/],
    [['some.log'], /detectors takes no argument, got "some\.log"/],
    [['--type'], /argument missing/i],
    [['--out', 'detectors.json'], /Unknown option '--out'/],
  ])('refuses %j with a usage error', (argv, message) => {
    const result = runDetectorsCommand(argv);
    expect(result).toMatchObject({ exitCode: 2, stdout: '' });
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain(DETECTORS_USAGE);
  });
});
