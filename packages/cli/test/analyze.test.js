import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { collectRun } from '@sparkforensics/core/cli/collect-run.ts';
import { deriveEvidenceAvailability } from '@sparkforensics/core/evidence-availability.ts';
import { buildEvidenceReport } from '@sparkforensics/core/evidence-report.ts';
import { main } from '../bin/sparkforensics-analyze.mjs';
// tests/helpers/ stays at the repo root because packages/core/test/mcp-tools.test.js
// shares this same fixture helper.
import { shsZipFetch, historyServerZip } from '../../../tests/helpers/shs-fixtures.js';
import { packAndInstall } from '../../../tests/helpers/pack-and-install.js';

// Regression coverage for the published `sparkforensics-analyze` bin, not just
// in-process `main()`: packs the real packages/cli tarball (running prepack ->
// vendor-core.mjs) and installs it once for the suite. This exercises
// vendor-core/ and the `files` allowlist; a direct `node bin/...mjs` spawn
// wouldn't catch a broken standalone install.
const packageDir = process.cwd();
const cleanupDirs = [];
let binPath;

beforeAll(() => {
  binPath = packAndInstall(packageDir, 'sparkforensics-analyze', cleanupDirs);
}, 30000);

afterAll(() => {
  rmSync(join(packageDir, 'vendor-core'), { recursive: true, force: true });
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function runCli(args) {
  const { stdout, stderr, status } = spawnSync(binPath, args, { encoding: 'utf8' });
  return { stdout, stderr, status };
}

function ndjsonWithSkew() {
  // One stage with 10 tasks: 9 fast (100ms) + 1 slow (2000ms) => P95/median skew.
  const lines = [
    '{"Event":"SparkListenerApplicationStart","App ID":"app-parity","App Name":"t","Timestamp":0}',
    '{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10}}',
  ];
  for (let i = 0; i < 9; i++) {
    lines.push(JSON.stringify({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      // Real Spark TaskInfo JSON always serializes Failed and Killed together,
      // so include both to validate against SparkEventSchema like a real log.
      'Task Info': { 'Task ID': i, 'Launch Time': 0, 'Finish Time': 100, Failed: false, Killed: false, Speculative: false },
      'Task Metrics': { 'Executor Run Time': 100, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
    }));
  }
  lines.push(JSON.stringify({
    Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
    'Task Info': { 'Task ID': 9, 'Launch Time': 0, 'Finish Time': 2000, Failed: false, Killed: false, Speculative: false },
    'Task Metrics': { 'Executor Run Time': 2000, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
  }));
  lines.push('{"Event":"SparkListenerStageCompleted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10,"Completion Time":2000}}');
  lines.push('{"Event":"SparkListenerApplicationEnd","Timestamp":2000}');
  return `${lines.join('\n')}\n`;
}

// Captures a `main()` in-process run: mocks stdout/stderr and restores
// process.exitCode so it doesn't leak into the vitest process. Imports `main`
// directly (for in-process fetchImpl mocking), not through the packed tarball.
async function runMainInProcess(argv, mainOpts) {
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await main(argv, mainOpts);
    const status = process.exitCode;
    const stdout = stdoutSpy.mock.calls.map(([chunk]) => chunk).join('');
    const stderr = stderrSpy.mock.calls.map(([chunk]) => chunk).join('');
    return { status, stdout, stderr };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = previousExitCode;
  }
}

describe('sparkforensics-analyze CLI', () => {
  it('produces the same normalized findings as the in-process buildEvidenceReport path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { stdout, status } = runCli([path]);
      expect(status).toBe(0);
      const cliJson = JSON.parse(stdout);

      const { appModel, skippedLines } = await collectRun(path);
      appModel.evidenceAvailability = deriveEvidenceAvailability(appModel, { skippedLines });
      const { json: directJson } = buildEvidenceReport(appModel);

      expect(cliJson.findings).toEqual(directJson.findings);
      expect(cliJson.schemaVersion).toBe(directJson.schemaVersion);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A History Server download (deflated zip, data descriptors): single-entry, and a rolling
  // log whose parts sit under eventlog_v2_<appId>/ and split mid-line.
  it('analyzes a single-entry or rolling History Server zip like the plain log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-zip-'));
    const appId = 'application_0000000000000_0001';
    const ndjson = Buffer.from(ndjsonWithSkew());
    const half = Math.floor(ndjson.length / 2);
    const zstd = (bytes) => new Uint8Array(zstdCompressSync(bytes));
    const logPath = join(dir, 'eventlog');
    const singlePath = join(dir, 'single.zip');
    const rollingPath = join(dir, 'rolling.zip');
    writeFileSync(logPath, ndjson);
    writeFileSync(singlePath, historyServerZip({ [`${appId}.zstd`]: zstd(ndjson) }));
    writeFileSync(rollingPath, historyServerZip({
      [`eventlog_v2_${appId}/`]: new Uint8Array(0),
      [`eventlog_v2_${appId}/appstatus_${appId}`]: new Uint8Array(0),
      [`eventlog_v2_${appId}/events_1_${appId}.zstd`]: zstd(ndjson.subarray(0, half)),
      [`eventlog_v2_${appId}/events_2_${appId}.zstd`]: zstd(ndjson.subarray(half)),
    }));
    try {
      const plain = runCli([logPath]);
      expect(plain.status).toBe(0);
      for (const path of [singlePath, rollingPath]) {
        const { stdout, stderr, status } = runCli([path]);
        expect(stderr).toBe('');
        expect(status).toBe(0);
        expect(JSON.parse(stdout)).toEqual(JSON.parse(plain.stdout));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on a malformed (non-Spark) input file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-bad-'));
    const path = join(dir, 'garbage.txt');
    writeFileSync(path, 'this is not an event log\n');
    try {
      const { status, stderr } = runCli([path]);
      expect(status).toBe(2);
      expect(stderr).toMatch(/Not a Spark event log/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on an unsupported (non-rolling) directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-dir-'));
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    try {
      const { status, stderr } = runCli([dir]);
      expect(status).toBe(2);
      expect(stderr).toMatch(/rolling event-log directory/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when a budget is violated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-budget-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { status, stderr } = runCli([path, '--max-skew', '1.5']);
      expect(status).toBe(1);
      expect(stderr).toMatch(/\[violation\] max-skew/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 3 with a stderr warning for an inconclusive-only run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-inconclusive-'));
    const path = join(dir, 'eventlog');
    // No ApplicationEnd => untrustworthy run => efficiency is inconclusive.
    writeFileSync(path, '{"Event":"SparkListenerApplicationStart","App ID":"app-i","App Name":"t","Timestamp":0}\n');
    try {
      const { status, stderr } = runCli([path, '--min-efficiency', '90']);
      expect(status).toBe(3);
      expect(stderr).toMatch(/\[inconclusive\] min-efficiency/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when a run has both a violation and an inconclusive budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-mixed-'));
    const path = join(dir, 'eventlog');
    // No ApplicationEnd => efficiency inconclusive; the skew budget still violates.
    writeFileSync(path, ndjsonWithSkew().replace('{"Event":"SparkListenerApplicationEnd","Timestamp":2000}\n', ''));
    try {
      const { status, stderr } = runCli([path, '--max-skew', '1.5', '--min-efficiency', '90']);
      expect(status).toBe(1);
      expect(stderr).toMatch(/\[violation\] max-skew/);
      expect(stderr).toMatch(/\[inconclusive\] min-efficiency/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--format md prints the same markdown as buildEvidenceReport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-md-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { stdout, status } = runCli([path, '--format', 'md']);
      expect(status).toBe(0);
      expect(stdout).toMatch(/^# Spark run evidence report/);

      const { appModel, skippedLines } = await collectRun(path);
      appModel.evidenceAvailability = deriveEvidenceAvailability(appModel, { skippedLines });
      const { markdown } = buildEvidenceReport(appModel);

      expect(stdout).toBe(`${markdown}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to JSON when --format is omitted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-default-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { stdout, status } = runCli([path]);
      expect(status).toBe(0);
      expect(() => JSON.parse(stdout)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on an unrecognized --format value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-badformat-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { status, stderr } = runCli([path, '--format', 'xml']);
      expect(status).toBe(2);
      expect(stderr).toMatch(/--format/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 3 by default (no budget flags) when the run has no ApplicationEnd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-incomplete-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, '{"Event":"SparkListenerApplicationStart","App ID":"app-i","App Name":"t","Timestamp":0}\n');
    try {
      const { status, stderr } = runCli([path]);
      expect(status).toBe(3);
      expect(stderr).toMatch(/\[inconclusive\] run-complete/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when a budget is violated with --format md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-md-budget-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { status, stdout, stderr } = runCli([path, '--format', 'md', '--max-skew', '1.5']);
      expect(status).toBe(1);
      expect(stderr).toMatch(/\[violation\] max-skew/);
      expect(stdout).toMatch(/^# Spark run evidence report/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes impactEstimate on findings in the default JSON output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { stdout, status } = runCli([path]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      const findingWithEstimate = parsed.findings.find((f) => f.impactEstimate != null);
      expect(findingWithEstimate).toBeDefined();
      expect(findingWithEstimate.impactEstimate).toHaveProperty('basis');
      expect(findingWithEstimate.impactEstimate).toHaveProperty('estimateMethod');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: recommendations/cleanChecks are EvidenceReportJson keys this
  // CLI dumps verbatim; the parity test above only compares findings/
  // schemaVersion, so it wouldn't catch a build that dropped these to stdout.
  it('carries the recommendations rollup and cleanChecks list through to the CLI JSON output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { stdout, status } = runCli([path]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed.recommendations)).toBe(true);
      expect(Array.isArray(parsed.cleanChecks)).toBe(true);
      expect(Array.isArray(parsed.notRunChecks)).toBe(true);
      expect(typeof parsed.summary.clean).toBe('boolean');
      expect(typeof parsed.summary.actionableFindingCount).toBe('number');
      expect(typeof parsed.verdict.title).toBe('string');
      expect(parsed.verdict.steps.length).toBeGreaterThan(0);
      expect(Object.keys(parsed.summary.outcome).sort()).toEqual(['failedJobs', 'failureReason', 'failureReasonStageId', 'totalJobs']);
      expect(parsed.recommendations.length).toBeGreaterThan(0);
      expect(parsed.cleanChecks.length).toBeGreaterThan(0);
      expect(parsed.findings.every((f) => typeof f.actionLabel === 'string')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when both a positional path and --shs-base-url are given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-shs-both-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { status, stderr } = runCli([path, '--shs-base-url', 'http://shs:18080', '--app-id', 'application_1_1']);
      expect(status).toBe(2);
      expect(stderr).toMatch(/Pass either <event-log-file\|rolling-log-dir> or --shs-base-url, not both/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when neither a positional path nor --shs-base-url is given', () => {
    const { status, stderr } = runCli([]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/Usage: sparkforensics-analyze/);
  });

  it('exits 2 when --shs-base-url is given without --app-id', () => {
    const { status, stderr } = runCli(['--shs-base-url', 'http://shs:18080']);
    expect(status).toBe(2);
    expect(stderr).toMatch(/--shs-base-url requires --app-id/);
  });

  it('exits 2 when --app-id is given without --shs-base-url', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-appid-only-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { status, stderr } = runCli([path, '--app-id', 'application_1_1']);
      expect(status).toBe(2);
      expect(stderr).toMatch(/--app-id\/--attempt-id require --shs-base-url/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when --attempt-id is given without --shs-base-url', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-attemptid-only-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { status, stderr } = runCli([path, '--attempt-id', '1']);
      expect(status).toBe(2);
      expect(stderr).toMatch(/--app-id\/--attempt-id require --shs-base-url/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when --max-regression-pct is given without --baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-noBaseline-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { status, stderr } = runCli([path, '--max-regression-pct', '10']);
      expect(status).toBe(2);
      expect(stderr).toMatch(/require --baseline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when --fail-on-introduced is given without --baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-noBaseline2-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { status, stderr } = runCli([path, '--fail-on-introduced', 'critical']);
      expect(status).toBe(2);
      expect(stderr).toMatch(/require --baseline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when --regression-metric is given without --baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-noBaseline3-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { status, stderr } = runCli([path, '--regression-metric', 'executorRunTime']);
      expect(status).toBe(2);
      expect(stderr).toMatch(/require --baseline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 with usage on an unknown flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-unknownflag-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjsonWithSkew());
    try {
      const { status, stderr } = runCli([path, '--max-skw', '3']);
      expect(status).toBe(2);
      expect(stderr).toMatch(/--max-skw/);
      expect(stderr).toMatch(/^Usage: sparkforensics-analyze/m);
      expect(stderr).not.toMatch(/at .*\.mjs:\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 with usage when a flag is missing its value', async () => {
    // Rejected during argument parsing, before the input path is read.
    const { status, stderr } = await runMainInProcess(['eventlog', '--max-skew']);
    expect(status).toBe(2);
    expect(stderr).toMatch(/--max-skew/);
    expect(stderr).toMatch(/^Usage: sparkforensics-analyze/m);
  });

  describe('--baseline comparison mode', () => {
    // Baseline: 9 fast + 1 slow (skewed). Candidate: same shape, single-task
    // runtime longer (2000 -> 4000), a real wallClock regression.
    function ndjsonCandidate() {
      const lines = [
        '{"Event":"SparkListenerApplicationStart","App ID":"app-cand","App Name":"t","Timestamp":0}',
        '{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10}}',
      ];
      for (let i = 0; i < 9; i++) {
        lines.push(JSON.stringify({
          Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
          'Task Info': { 'Task ID': i, 'Launch Time': 0, 'Finish Time': 100, Failed: false, Killed: false, Speculative: false },
          'Task Metrics': { 'Executor Run Time': 100, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
        }));
      }
      lines.push(JSON.stringify({
        Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
        'Task Info': { 'Task ID': 9, 'Launch Time': 0, 'Finish Time': 4000, Failed: false, Killed: false, Speculative: false },
        'Task Metrics': { 'Executor Run Time': 4000, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
      }));
      lines.push('{"Event":"SparkListenerStageCompleted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10,"Completion Time":4000}}');
      lines.push('{"Event":"SparkListenerApplicationEnd","Timestamp":4000}');
      return `${lines.join('\n')}\n`;
    }

    function withBaselineAndCandidate(fn) {
      const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-baseline-'));
      const baselinePath = join(dir, 'baseline');
      const candidatePath = join(dir, 'candidate');
      writeFileSync(baselinePath, ndjsonWithSkew());
      writeFileSync(candidatePath, ndjsonCandidate());
      try {
        return fn({ baselinePath, candidatePath });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('wraps JSON output in a { candidate, comparison } shape', () => {
      withBaselineAndCandidate(({ baselinePath, candidatePath }) => {
        const { stdout, status } = runCli([candidatePath, '--baseline', baselinePath]);
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.candidate).toBeDefined();
        expect(Array.isArray(parsed.candidate.findings)).toBe(true);
        expect(parsed.comparison).toMatchObject({ confidence: expect.any(String) });
        expect(Array.isArray(parsed.comparison.metrics)).toBe(true);
        expect(parsed.comparison.findings).toHaveProperty('introduced');
        expect(parsed.comparison.findings).toHaveProperty('resolved');
        expect(parsed.comparison).not.toHaveProperty('baselineLabel');
        expect(parsed.comparison).not.toHaveProperty('candidateLabel');
        expect(parsed.comparison).not.toHaveProperty('stageSkew');
        expect(parsed.comparison).not.toHaveProperty('baseStages');
        expect(parsed.comparison).not.toHaveProperty('candStages');
      });
    });

    it('appends a Comparison to baseline section to the markdown output', () => {
      withBaselineAndCandidate(({ baselinePath, candidatePath }) => {
        const { stdout, status } = runCli([candidatePath, '--baseline', baselinePath, '--format', 'md']);
        expect(status).toBe(0);
        expect(stdout).toMatch(/^# Spark run evidence report/);
        expect(stdout).toMatch(/## Comparison to baseline/);
      });
    });

    it('leaves output unchanged (no candidate/comparison wrapper) when --baseline is omitted', () => {
      withBaselineAndCandidate(({ candidatePath }) => {
        const { stdout, status } = runCli([candidatePath]);
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.candidate).toBeUndefined();
        expect(parsed.comparison).toBeUndefined();
        expect(Array.isArray(parsed.findings)).toBe(true);
      });
    });

    it('exits 1 with a max-regression violation when the candidate regressed beyond budget', () => {
      withBaselineAndCandidate(({ baselinePath, candidatePath }) => {
        const { status, stderr } = runCli([candidatePath, '--baseline', baselinePath, '--max-regression-pct', '10']);
        expect(status).toBe(1);
        expect(stderr).toMatch(/\[violation\] max-regression/);
      });
    });

    it('passes max-regression when the regression is within budget', () => {
      withBaselineAndCandidate(({ baselinePath, candidatePath }) => {
        const { status, stderr } = runCli([candidatePath, '--baseline', baselinePath, '--max-regression-pct', '150']);
        expect(status).toBe(0);
        expect(stderr).not.toMatch(/\[violation\] max-regression/);
      });
    });

    it('respects --regression-metric to check a non-default metric key', () => {
      withBaselineAndCandidate(({ baselinePath, candidatePath }) => {
        const { status, stderr } = runCli([
          candidatePath, '--baseline', baselinePath,
          '--max-regression-pct', '1', '--regression-metric', 'executorRunTime',
        ]);
        expect(status).toBe(1);
        expect(stderr).toMatch(/\[violation\] max-regression/);
      });
    });

    it('exits 2 with usage when checking a metric key that is not a known comparison metric', async () => {
      // Rejected during flag validation, before either run is read.
      const { status, stderr } = await runMainInProcess([
        'candidate', '--baseline', 'baseline',
        '--max-regression-pct', '1', '--regression-metric', 'notARealMetric',
      ]);
      expect(status).toBe(2);
      expect(stderr).toMatch(/Unknown --regression-metric "notARealMetric"/);
      expect(stderr).toMatch(/^Usage: sparkforensics-analyze/m);
    });

    it('exits 2 when --regression-metric is given with --baseline but without --max-regression-pct', () => {
      withBaselineAndCandidate(({ baselinePath, candidatePath }) => {
        const { status, stderr } = runCli([
          candidatePath, '--baseline', baselinePath, '--regression-metric', 'executorRunTime',
        ]);
        expect(status).toBe(2);
        expect(stderr).toMatch(/--regression-metric requires --max-regression-pct/);
      });
    });

    it('exits 0 with --fail-on-introduced when no finding band was introduced', () => {
      withBaselineAndCandidate(({ baselinePath, candidatePath }) => {
        const { status, stderr } = runCli([candidatePath, '--baseline', baselinePath, '--fail-on-introduced', 'critical']);
        expect(status).toBe(0);
        expect(stderr).not.toMatch(/\[violation\] fail-on-introduced/);
      });
    });

    it('is inconclusive when --fail-on-introduced is given an unrecognized impact band', () => {
      withBaselineAndCandidate(({ baselinePath, candidatePath }) => {
        const { status, stderr } = runCli([candidatePath, '--baseline', baselinePath, '--fail-on-introduced', 'criticall']);
        expect(status).toBe(3);
        expect(stderr).toMatch(/\[inconclusive\] fail-on-introduced/);
        expect(stderr).not.toMatch(/\[pass\] fail-on-introduced/);
      });
    });
  });

  describe('--redact', () => {
    // App Name is free text the redactor's host/IP scan reaches; an
    // ip-10-20-30-40-shaped name exercises host pseudonymization without a
    // full slowHost fixture.
    function ndjsonWithHostName(appId) {
      const lines = [
        `{"Event":"SparkListenerApplicationStart","App ID":"${appId}","App Name":"ip-10-20-30-40","Timestamp":0}`,
        '{"Event":"SparkListenerApplicationEnd","Timestamp":100}',
      ];
      return `${lines.join('\n')}\n`;
    }

    it('pseudonymizes the app id and host tokens in single-run JSON output', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-redact-'));
      const path = join(dir, 'eventlog');
      writeFileSync(path, ndjsonWithHostName('app-redact-test'));
      try {
        const plain = JSON.parse(runCli([path]).stdout);
        expect(plain.summary.app.id).toBe('app-redact-test');
        expect(plain.summary.app.name).toBe('ip-10-20-30-40');

        const redacted = JSON.parse(runCli([path, '--redact']).stdout);
        expect(redacted.summary.app.id).toBe('app-1');
        expect(redacted.summary.app.name).toMatch(/^host-\d+$/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('pseudonymizes the candidate report in --baseline comparison mode too', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-redact-baseline-'));
      const baselinePath = join(dir, 'baseline');
      const candidatePath = join(dir, 'candidate');
      writeFileSync(baselinePath, ndjsonWithSkew());
      writeFileSync(candidatePath, ndjsonWithHostName('app-redact-cand'));
      try {
        const { stdout, status } = runCli([candidatePath, '--baseline', baselinePath, '--redact']);
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.candidate.summary.app.id).toBe('app-1');
        expect(parsed.candidate.summary.app.name).toMatch(/^host-\d+$/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('--impact/--type/--stage findings filter', () => {
    // ndjsonWithSkew() produces exactly 3 findings: memoryUtilization (info,
    // no stage), plus skew and straggler (both critical, stage 1: its one
    // 2000ms task gates the whole 2000ms stage).
    it('narrows findings by --type, leaving recommendations/cleanChecks/summary full', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-filter-'));
      const path = join(dir, 'eventlog');
      writeFileSync(path, ndjsonWithSkew());
      try {
        const full = JSON.parse(runCli([path]).stdout);
        const { stdout, status } = runCli([path, '--type', 'straggler']);
        expect(status).toBe(0);
        const filtered = JSON.parse(stdout);
        expect(filtered.findings).toHaveLength(1);
        expect(filtered.findings[0].type).toBe('straggler');
        expect(filtered.recommendations).toEqual(full.recommendations);
        expect(filtered.cleanChecks).toEqual(full.cleanChecks);
        expect(filtered.summary.findingCount).toBe(full.summary.findingCount);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('narrows findings by --stage', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-filter-'));
      const path = join(dir, 'eventlog');
      writeFileSync(path, ndjsonWithSkew());
      try {
        const { stdout, status } = runCli([path, '--stage', '1']);
        expect(status).toBe(0);
        const { findings } = JSON.parse(stdout);
        expect(findings.map((f) => f.type).sort()).toEqual(['skew', 'straggler']);
        expect(findings.every((f) => f.stageId === 1)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('narrows findings by --impact, allowing it to filter out every finding', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-filter-'));
      const path = join(dir, 'eventlog');
      writeFileSync(path, ndjsonWithSkew());
      try {
        const { stdout, status } = runCli([path, '--impact', 'warning']);
        expect(status).toBe(0);
        const { findings } = JSON.parse(stdout);
        expect(findings).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('accepts a comma-separated --impact/--type list and combines dimensions as AND', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-filter-'));
      const path = join(dir, 'eventlog');
      writeFileSync(path, ndjsonWithSkew());
      try {
        const { stdout, status } = runCli([path, '--impact', 'info,critical', '--type', 'straggler', '--stage', '1']);
        expect(status).toBe(0);
        const { findings } = JSON.parse(stdout);
        expect(findings).toHaveLength(1);
        expect(findings[0].type).toBe('straggler');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exits 2 on a non-integer --stage value', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-filter-'));
      const path = join(dir, 'eventlog');
      writeFileSync(path, ndjsonWithSkew());
      try {
        const { status, stderr } = runCli([path, '--stage', 'not-a-number']);
        expect(status).toBe(2);
        expect(stderr).toMatch(/Invalid integer value for --stage/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('filters only the candidate\'s findings in --baseline comparison mode', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-filter-baseline-'));
      const baselinePath = join(dir, 'baseline');
      const candidatePath = join(dir, 'candidate');
      writeFileSync(baselinePath, ndjsonWithSkew());
      writeFileSync(candidatePath, ndjsonWithSkew());
      try {
        const full = JSON.parse(runCli([candidatePath, '--baseline', baselinePath]).stdout);
        const { stdout, status } = runCli([candidatePath, '--baseline', baselinePath, '--type', 'straggler']);
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.candidate.findings.every((f) => f.type === 'straggler')).toBe(true);
        expect(parsed.candidate.findings.length).toBeGreaterThan(0);
        expect(parsed.candidate.recommendations).toEqual(full.candidate.recommendations);
        expect(parsed.candidate.cleanChecks).toEqual(full.candidate.cleanChecks);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('produces the same normalized findings as the file-based path for an equivalent SHS run', async () => {
    const ndjson = ndjsonWithSkew();

    const { stdout, status } = await runMainInProcess(
      ['--shs-base-url', 'http://shs:18080', '--app-id', 'application_1_1'],
      { fetchImpl: shsZipFetch(ndjson) },
    );
    expect(status).toBe(0);
    const cliJson = JSON.parse(stdout);

    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-e2e-shs-parity-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, ndjson);
    try {
      const { appModel, skippedLines } = await collectRun(path);
      appModel.evidenceAvailability = deriveEvidenceAvailability(appModel, { skippedLines });
      const { json: directJson } = buildEvidenceReport(appModel);

      expect(cliJson.findings).toEqual(directJson.findings);
      expect(cliJson.schemaVersion).toBe(directJson.schemaVersion);
      expect(Array.isArray(cliJson.recommendations)).toBe(true);
      expect(Array.isArray(cliJson.cleanChecks)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
