import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Wraps the real renameSync (default: passthrough) so the rename-failure test below can force it to
// throw for exactly one call via mockImplementationOnce. Every other test either never reaches the
// rename (argument-validation failures) or runs the packed bin in a separate process (spawnSync,
// unaffected by an in-process mock either way), so this default passthrough leaves them unchanged.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { collectRun } from '@sparkforensics/core/cli/collect-run.ts';
import { auditConfig } from '@sparkforensics/core/analyzer.ts';
import { main } from '../bin/sparkforensics-analyze.mjs';
import { packAndInstall } from '../../../tests/helpers/pack-and-install.js';
// tests/helpers/ stays at the repo root: shared with analyze.test.js/mcp-tools.test.js.
import { shsZipFetch } from '../../../tests/helpers/shs-fixtures.js';

// data.js now holds `window.__SPARKFORENSICS_RUN_GZ__ = "<base64>";` (see
// writeHtmlExport): base64-decode + gunzip + JSON.parse to get the run data
// back. Node's own zlib is fine here — the test doesn't need to exercise
// fflate, only prove the CLI's write side round-trips.
function parseRunPayload(dataJs) {
  const match = dataJs.match(/window\.__SPARKFORENSICS_RUN_GZ__ = "([^"]+)";/);
  if (!match) throw new Error(`data.js didn't contain the expected __SPARKFORENSICS_RUN_GZ__ assignment:\n${dataJs}`);
  const compressed = Buffer.from(match[1], 'base64');
  return JSON.parse(gunzipSync(compressed).toString('utf8'));
}

// Mirrors analyze.test.js's runMainInProcess: fast, no pack/install, used for
// argument-validation behavior that doesn't depend on the vendored template.
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

export function minimalNdjson() {
  const lines = [
    '{"Event":"SparkListenerApplicationStart","App ID":"app-export-1","App Name":"t","Timestamp":0}',
    '{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":1}}',
    JSON.stringify({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Task ID': 0, 'Launch Time': 0, 'Finish Time': 100, Failed: false, Killed: false, Speculative: false },
      'Task Metrics': { 'Executor Run Time': 100, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
    }),
    '{"Event":"SparkListenerStageCompleted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":1,"Completion Time":100}}',
    '{"Event":"SparkListenerApplicationEnd","Timestamp":100}',
  ];
  return `${lines.join('\n')}\n`;
}

describe('--export-html argument handling', () => {
  it('refuses to run when the destination directory already exists and is not empty', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-log-'));
    const logPath = join(logDir, 'eventlog');
    writeFileSync(logPath, minimalNdjson());
    const destDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-dest-'));
    writeFileSync(join(destDir, 'stale-file.txt'), 'leftover from a previous export');
    try {
      const { status, stderr } = await runMainInProcess([logPath, '--export-html', destDir]);
      expect(status).toBe(2);
      expect(stderr).toContain('already exists and is not empty');
      // No overwrite, no merge: the stale file must survive untouched.
      expect(existsSync(join(destDir, 'stale-file.txt'))).toBe(true);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
      rmSync(destDir, { recursive: true, force: true });
    }
  });

  it('refuses to run cleanly when the destination path is an existing regular file, not a directory', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-log-'));
    const logPath = join(logDir, 'eventlog');
    writeFileSync(logPath, minimalNdjson());
    const destParent = mkdtempSync(join(tmpdir(), 'sparkforensics-export-dest-'));
    // A plausible accident: reusing a report path (a plain file) as the
    // export target instead of a directory.
    const destPath = join(destParent, 'report.html');
    writeFileSync(destPath, 'not a directory');
    try {
      const { status, stderr } = await runMainInProcess([logPath, '--export-html', destPath]);
      expect(status).toBe(2);
      expect(stderr).toContain('not a directory');
      // The offending file must survive untouched, same as the non-empty-dir case.
      expect(existsSync(destPath)).toBe(true);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
      rmSync(destParent, { recursive: true, force: true });
    }
  });

  it('exports the real skippedLines count for a --shs-base-url run, not a hardcoded 0 (fix 175: resolveFromShs was dropping it)', async () => {
    // "SparkListenerJobEnd" is a known Event type, but missing "Job ID" fails its own schema and
    // counts as a skipped line (see parser-worker's dispatchLine contract / packages/core's
    // parser-worker.test.js). Spliced right before ApplicationEnd so the run still completes.
    const ndjson = minimalNdjson().replace(
      '{"Event":"SparkListenerApplicationEnd","Timestamp":100}',
      '{"Event":"SparkListenerJobEnd"}\n{"Event":"SparkListenerApplicationEnd","Timestamp":100}',
    );
    const parentDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-out-'));
    const destDir = join(parentDir, 'export-out');
    try {
      const { status, stderr } = await runMainInProcess(
        ['--shs-base-url', 'http://shs:18080', '--app-id', 'application_1_1', '--export-html', destDir],
        { fetchImpl: shsZipFetch(ndjson) },
      );
      expect(status).toBe(0);
      expect(stderr).toBe('');
      const dataJs = readFileSync(join(destDir, 'data.js'), 'utf8');
      const parsed = parseRunPayload(dataJs);
      // Before the fix, main()'s SHS branch never reassigned `skippedLines` (it stayed at its
      // `let skippedLines = 0` initializer), so this would be 0 here despite the real parse
      // skipping a line.
      expect(parsed.skippedLines).toBe(1);
      // evidenceAvailability was already derived correctly inside resolveFromShs before this fix
      // (it has its own internal skippedLines value); this proves the two numbers in the same
      // payload now agree instead of contradicting each other.
      const executorMetricsEntry = parsed.evidenceAvailability.entries.find((e) => e.key === 'executorMetrics');
      expect(executorMetricsEntry.reasonCode).toBe('parseIncomplete');
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('reports a clear, actionable error - not a raw exception - when the final rename into place fails', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-log-'));
    const logPath = join(logDir, 'eventlog');
    writeFileSync(logPath, minimalNdjson());
    const parentDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-out-'));
    const destDir = join(parentDir, 'export-out');
    renameSync.mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy or locked, rename');
    });
    try {
      const { status, stderr } = await runMainInProcess([logPath, '--export-html', destDir]);
      expect(status).toBe(2);
      // The old, unguarded rename produced a bare "--export-html failed: EBUSY: ..." with no
      // guidance; the fix wraps it the same way a write failure already is, naming the temp dir
      // and telling the caller to remove it manually.
      expect(stderr).toMatch(/^--export-html failed: EBUSY: resource busy or locked, rename \(export left at .*; remove it manually\)\n$/);
      // The rename never happened: destDir must not exist, and no output was produced through it.
      expect(existsSync(destDir)).toBe(false);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});

// Regression coverage for the published `sparkforensics-analyze` bin, not just
// in-process `main()`: packs the real packages/cli tarball (running prepack ->
// vendor-core.mjs + vendor-export-template.mjs) and installs it once for the
// suite. This is the only way to exercise export-template/'s `files`
// allowlist and prove writeHtmlExport finds its template from a real install.
const packageDir = process.cwd();
const cleanupDirs = [];
let binPath;

beforeAll(() => {
  binPath = packAndInstall(packageDir, 'sparkforensics-analyze', cleanupDirs);
}, 30000);

afterAll(() => {
  rmSync(join(packageDir, 'vendor-core'), { recursive: true, force: true });
  rmSync(join(packageDir, 'export-template'), { recursive: true, force: true });
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function runCli(args) {
  const { stdout, stderr, status } = spawnSync(binPath, args, { encoding: 'utf8' });
  return { stdout, stderr, status };
}

describe('--export-html (published bin)', () => {
  it('writes a self-contained export folder with index.html, data.js, and the app id embedded', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-log-'));
    const logPath = join(logDir, 'eventlog');
    writeFileSync(logPath, minimalNdjson());
    const parentDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-out-'));
    const destDir = join(parentDir, 'export-out');
    try {
      const { status, stderr } = runCli([logPath, '--export-html', destDir]);
      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(existsSync(join(destDir, 'index.html'))).toBe(true);
      expect(existsSync(join(destDir, 'data.js'))).toBe(true);
      expect(existsSync(join(destDir, 'docs'))).toBe(true);
      const dataJs = readFileSync(join(destDir, 'data.js'), 'utf8');
      expect(dataJs).toContain('window.__SPARKFORENSICS_RUN_GZ__');
      expect(parseRunPayload(dataJs).app.id).toBe('app-export-1');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('redacts the app id in data.js when --redact is passed', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-log-'));
    const logPath = join(logDir, 'eventlog');
    writeFileSync(logPath, minimalNdjson());
    const parentDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-out-'));
    const destDir = join(parentDir, 'export-out');
    try {
      const { status } = runCli([logPath, '--export-html', destDir, '--redact']);
      expect(status).toBe(0);
      const dataJs = readFileSync(join(destDir, 'data.js'), 'utf8');
      expect(dataJs).not.toContain('app-export-1');
      const parsed = parseRunPayload(dataJs);
      expect(parsed.app.id).toMatch(/^app-\d+$/);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('cannot break out of the <script> tag with a literal script-closing sequence in log-derived text, and still round-trips it byte-for-byte', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-log-'));
    const logPath = join(logDir, 'eventlog');
    // A stage name is free text under the app's control (a query/method
    // name in the user's own Spark job); nothing upstream rejects "</script>"
    // inside it. writeHtmlExport must still produce a data.js that can't
    // break out of its <script> block, and decoding it must still recover
    // the exact original stage name.
    const ndjson = minimalNdjson().replace(
      '"Stage Name":"s1"',
      '"Stage Name":"s1 </script><script>window.pwned=true</script>"',
    );
    writeFileSync(logPath, ndjson);
    const parentDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-out-'));
    const destDir = join(parentDir, 'export-out');
    try {
      const { status, stderr } = runCli([logPath, '--export-html', destDir]);
      expect(status).toBe(0);
      expect(stderr).toBe('');
      const dataJs = readFileSync(join(destDir, 'data.js'), 'utf8');
      // base64's alphabet (A-Za-z0-9+/=) structurally cannot contain "<": a
      // stronger guarantee than escaping, and true of the whole file, not
      // just the payload.
      expect(dataJs).not.toContain('<');
      expect(parseRunPayload(dataJs).stages[0].name)
        .toBe('s1 </script><script>window.pwned=true</script>');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('exports configFindings matching a direct auditConfig() call for the same run (fix 175: memoizing auditConfig must not change its result)', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-log-'));
    const logPath = join(logDir, 'eventlog');
    // A non-empty config with no serializer set triggers auditConfig's
    // "non-Kryo / missing serializer" info finding, so configFindings isn't
    // vacuously empty (minimalNdjson() alone carries no Spark config at all).
    const ndjson = minimalNdjson().replace(
      '{"Event":"SparkListenerApplicationStart","App ID":"app-export-1","App Name":"t","Timestamp":0}',
      '{"Event":"SparkListenerApplicationStart","App ID":"app-export-1","App Name":"t","Timestamp":0}\n'
      + '{"Event":"SparkListenerEnvironmentUpdate","Spark Properties":{"spark.executor.memory":"4g"}}',
    );
    writeFileSync(logPath, ndjson);
    const parentDir = mkdtempSync(join(tmpdir(), 'sparkforensics-export-out-'));
    const destDir = join(parentDir, 'export-out');
    try {
      const { status, stderr } = runCli([logPath, '--export-html', destDir]);
      expect(status).toBe(0);
      expect(stderr).toBe('');
      const dataJs = readFileSync(join(destDir, 'data.js'), 'utf8');
      const exportedConfigFindings = parseRunPayload(dataJs).configFindings;
      expect(exportedConfigFindings.length).toBeGreaterThan(0);

      const { appModel } = await collectRun(logPath);
      const directConfigFindings = auditConfig(appModel.app);
      expect(exportedConfigFindings).toEqual(directConfigFindings);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});
