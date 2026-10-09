import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseRun, compareRuns, resolveOrCreateRun, comparisonCacheSize } from '../src/mcp-tools.js';
import { collectRun } from '../src/cli/collect-run.ts';
import { parseThresholdOverrides } from '../src/threshold-overrides.ts';
import { buildComparisonOutput } from '../src/comparison-output.ts';

// Counts the comparisons built, so a cache hit shows as a build that did not happen.
vi.mock('../src/cli/collect-run.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, collectRun: vi.fn(actual.collectRun) };
});
vi.mock('../src/comparison-output.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildComparisonOutput: vi.fn(actual.buildComparisonOutput) };
});

const CORPUS = join(import.meta.dirname, '..', '..', '..', 'dev', 'log-corpus', 'logs');

// One stage of `taskCount` tasks; the last one runs `slowMs`, the rest 100ms. The app name and
// stage name are parameters so a test can plant text that redaction or normalization acts on.
function tmpLog({ appId, appName = 't', stageName = 's1', taskCount = 10, slowMs = 100 }) {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-cache-'));
  const path = join(dir, 'eventlog');
  const lines = [
    JSON.stringify({ Event: 'SparkListenerApplicationStart', 'App ID': appId, 'App Name': appName, Timestamp: 0 }),
    JSON.stringify({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Stage Name': stageName, 'Number of Tasks': taskCount } }),
  ];
  for (let i = 0; i < taskCount; i++) {
    const ms = i === taskCount - 1 ? slowMs : 100;
    lines.push(JSON.stringify({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Task ID': i, 'Launch Time': 0, 'Finish Time': ms, Failed: false, Killed: false, Speculative: false },
      'Task Metrics': { 'Executor Run Time': ms, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
    }));
  }
  lines.push(JSON.stringify({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Stage Name': stageName, 'Number of Tasks': taskCount, 'Completion Time': slowMs } }));
  lines.push(JSON.stringify({ Event: 'SparkListenerApplicationEnd', Timestamp: slowMs }));
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { dir, path };
}

async function withLogs(specs, fn) {
  const logs = specs.map(tmpLog);
  try {
    return await fn(logs.map((l) => ({ source: { path: l.path } })));
  } finally {
    for (const l of logs) rmSync(l.dir, { recursive: true, force: true });
  }
}

// A cache hit hands back the stored block itself, a rebuild a new one.
describe('diagnoseRun metrics cache', () => {
  it('serves a repeated call from the cache and keeps the result equal', async () => {
    await withLogs([{ appId: 'app-d1' }], async ([ref]) => {
      const { runId } = await resolveOrCreateRun(ref);
      const first = diagnoseRun(runId);
      const second = diagnoseRun(runId);
      expect(second.metrics).toBe(first.metrics);
      expect(second).toEqual(first);
    });
  });

  it('computes fresh metrics under different thresholds', async () => {
    await withLogs([{ appId: 'app-d2', taskCount: 25, slowMs: 1000 }], async ([ref]) => {
      const { runId } = await resolveOrCreateRun(ref);
      const tuned = parseThresholdOverrides({ skew: { minTasksForP95: 30 } });
      const plain = diagnoseRun(runId);
      const withTuned = diagnoseRun(runId, { thresholds: tuned });
      expect(withTuned.metrics).not.toBe(plain.metrics);
      expect(withTuned.metrics).not.toEqual(plain.metrics);
      // Each option set keeps its own entry.
      expect(diagnoseRun(runId, { thresholds: tuned }).metrics).toBe(withTuned.metrics);
      expect(diagnoseRun(runId).metrics).toBe(plain.metrics);
      // An equal but distinct overrides object is a different key: results stay correct, no sharing.
      const again = parseThresholdOverrides({ skew: { minTasksForP95: 30 } });
      expect(diagnoseRun(runId, { thresholds: again }).metrics).toEqual(withTuned.metrics);
    });
  });

  it('computes redacted blocks apart from plain ones', async () => {
    await withLogs([{ appId: 'app-d3', appName: 'job-ip-10-1-2-3.ec2.internal' }], async ([ref]) => {
      const { runId } = await resolveOrCreateRun(ref);
      const plain = diagnoseRun(runId);
      const redacted = diagnoseRun(runId, { redact: true });
      expect(redacted.metrics).not.toBe(plain.metrics);
      expect(diagnoseRun(runId, { redact: true }).metrics).toBe(redacted.metrics);
      expect(diagnoseRun(runId).metrics).toBe(plain.metrics);
      expect(JSON.stringify(redacted.effectiveConf)).not.toContain('ip-10-1-2-3.ec2.internal');
    });
  });

  it('gives each run its own metrics', async () => {
    await withLogs([{ appId: 'app-d4a' }, { appId: 'app-d4b', slowMs: 5000 }], async ([a, b]) => {
      const { runId: idA } = await resolveOrCreateRun(a);
      const { runId: idB } = await resolveOrCreateRun(b);
      expect(diagnoseRun(idB).metrics).not.toBe(diagnoseRun(idA).metrics);
      expect(diagnoseRun(idB).metrics).not.toEqual(diagnoseRun(idA).metrics);
    });
  });
});

describe('rolling event-log directory cache key', () => {
  it('notices a file inside the directory growing, which leaves the directory\'s own mtime alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-rolling-'));
    try {
      const part = join(dir, 'events_1_app-roll');
      writeFileSync(part, `${JSON.stringify({ Event: 'SparkListenerApplicationStart', 'App ID': 'app-roll', 'App Name': 't', Timestamp: 1 })}\n`);
      const first = await resolveOrCreateRun({ source: { path: dir } });
      expect((await resolveOrCreateRun({ source: { path: dir } })).runId).toBe(first.runId);
      // The live part is appended to in place: the directory's own mtime, ctime and size stay as they were.
      appendFileSync(part, `${JSON.stringify({ Event: 'SparkListenerApplicationEnd', Timestamp: 5 })}\n`);
      const second = await resolveOrCreateRun({ source: { path: dir } });
      expect(second.runId).not.toBe(first.runId);
      expect(second.appModel.app.endTime).toBe(5);
      expect(first.appModel.app.endTime ?? null).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compareRuns result cache', () => {
  const pair = [{ appId: 'app-c-a', slowMs: 100 }, { appId: 'app-c-b', slowMs: 2000 }];
  const builds = () => vi.mocked(buildComparisonOutput).mock.calls.length;
  beforeEach(() => { vi.mocked(buildComparisonOutput).mockClear(); });

  it('serves an identical repeated call from the cache', async () => {
    await withLogs(pair, async ([a, b]) => {
      const first = await compareRuns(a, b);
      expect(builds()).toBe(1);
      const second = await compareRuns(a, b);
      expect(builds()).toBe(1);
      expect(second).toEqual(first);
    });
  });

  it('hands each caller its own copy, so changing a result cannot change the next one served', async () => {
    await withLogs(pair, async ([a, b]) => {
      const first = await compareRuns(a, b);
      const expected = structuredClone(first);
      first.metrics.length = 0;
      first.findings.introduced.push({ forged: true });
      first.verdict = null;
      const second = await compareRuns(a, b);
      expect(builds()).toBe(1);
      expect(second).toEqual(expected);
      expect(second.metrics).not.toBe(first.metrics);
    });
  });

  it('does not keep a comparison whose run left the run cache while it was being built', async () => {
    const actual = await vi.importActual('../src/cli/collect-run.ts');
    await withLogs(pair, async ([a, b]) => {
      await resolveOrCreateRun(a);
      // The second run's parse waits on a gate, so the first can be evicted while the comparison is mid-request.
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      vi.mocked(collectRun).mockImplementation(async (path) => {
        if (path === b.source.path) await gate;
        return actual.collectRun(path);
      });
      try {
        const racing = compareRuns(a, b);
        // 8 other sources push the first run out of the 8-run cache.
        await withLogs(Array.from({ length: 8 }, (_, i) => ({ appId: `app-c-m${i}` })), async (refs) => {
          for (const ref of refs) await resolveOrCreateRun(ref);
        });
        const before = comparisonCacheSize();
        release();
        const result = await racing;
        expect(result.runIdA).toBeTruthy();
        expect(comparisonCacheSize()).toBe(before);
      } finally {
        vi.mocked(collectRun).mockImplementation(actual.collectRun);
      }
    });
  });

  it('does not share a result between opposite orders', async () => {
    await withLogs(pair, async ([a, b]) => {
      const forward = await compareRuns(a, b);
      const backward = await compareRuns(b, a);
      expect(backward.runIdA).toBe(forward.runIdB);
      expect(builds()).toBe(2);
      const wall = (r) => r.metrics.find((m) => m.key === 'wallClock');
      expect(wall(backward).baseline).toBe(wall(forward).candidate);
    });
  });

  it('adds stagePairs only to the full view, and keeps both views cached', async () => {
    await withLogs(pair, async ([a, b]) => {
      const summary = await compareRuns(a, b);
      const full = await compareRuns(a, b, { include: ['stagePairs'] });
      expect(summary).not.toHaveProperty('stagePairs');
      expect(full.stagePairs.length).toBeGreaterThan(0);
      expect(await compareRuns(a, b)).not.toHaveProperty('stagePairs');
      expect((await compareRuns(a, b, { include: ['stagePairs'] })).stagePairs).toEqual(full.stagePairs);
      expect(builds()).toBe(2);
    });
  });

  it('computes a redacted comparison apart from the plain one', async () => {
    const host = 'collect at ip-10-1-2-3.ec2.internal.scala:42';
    await withLogs([{ appId: 'app-c-r1', stageName: 's1' }, { appId: 'app-c-r2', stageName: host, slowMs: 2000 }], async ([a, b]) => {
      const plain = await compareRuns(a, b);
      const redacted = await compareRuns(a, b, { redact: true });
      const stages = (r) => r.findings.introduced.flatMap((f) => f.stages).join('|');
      expect(stages(plain)).toContain('ip-10-1-2-3.ec2.internal');
      expect(stages(redacted)).not.toContain('ip-10-1-2-3.ec2.internal');
      expect(stages(await compareRuns(a, b))).toContain('ip-10-1-2-3.ec2.internal');
      expect(stages(await compareRuns(a, b, { redact: true }))).not.toContain('ip-10-1-2-3.ec2.internal');
    });
  });

  it('computes a fresh comparison for a different normalizePath', async () => {
    // Public corpus pair whose stage pairing moves when digits are masked.
    const sources = ['pairwise-01', 'pairwise-02'].map((n) => ({ source: { path: join(CORPUS, `${n}.ndjson`) } }));
    const [a, b] = sources;
    const plain = await compareRuns(a, b, { include: ['stagePairs'] });
    const normalized = await compareRuns(a, b, { include: ['stagePairs'], normalizePath: ['\\d+'] });
    expect(normalized.stagePairs).not.toEqual(plain.stagePairs);
    // A different pattern list is a different key, an equal one the same entry.
    const other = await compareRuns(a, b, { include: ['stagePairs'], normalizePath: ['unused-[0-9]+'] });
    expect(other.stagePairs).toEqual(plain.stagePairs);
    expect(builds()).toBe(3);
    expect((await compareRuns(a, b, { include: ['stagePairs'], normalizePath: ['\\d+'] })).stagePairs).toEqual(normalized.stagePairs);
    expect((await compareRuns(a, b, { include: ['stagePairs'] })).stagePairs).toEqual(plain.stagePairs);
    expect(builds()).toBe(3);
  });

  it('computes a fresh comparison under different thresholds', async () => {
    await withLogs([{ appId: 'app-c-t1', slowMs: 100 }, { appId: 'app-c-t2', slowMs: 2000 }], async ([a, b]) => {
      const tuned = parseThresholdOverrides({ skew: { ratioWarn: 2 } });
      const plain = await compareRuns(a, b);
      const withTuned = await compareRuns(a, b, { thresholds: tuned });
      expect(builds()).toBe(2);
      expect(withTuned.tunedThresholds).toBeDefined();
      expect(plain.tunedThresholds).toBeUndefined();
      expect((await compareRuns(a, b, { thresholds: tuned })).metrics).toEqual(withTuned.metrics);
      expect(builds()).toBe(2);
    });
  });

  it('renders markdown per call on top of a cached comparison', async () => {
    await withLogs(pair, async ([a, b]) => {
      const bare = await compareRuns(a, b);
      const withMd = await compareRuns(a, b, { markdown: true });
      expect(bare).not.toHaveProperty('markdown');
      expect(withMd.markdown).toContain('#');
      expect(await compareRuns(a, b)).not.toHaveProperty('markdown');
    });
  });

  it('recomputes after a run leaves the run cache', async () => {
    await withLogs(pair, async ([a, b]) => {
      const first = await compareRuns(a, b);
      // Resolving 8 more distinct sources evicts both runs (cap 8), and their comparison with them.
      await withLogs(Array.from({ length: 8 }, (_, i) => ({ appId: `app-c-e${i}` })), async (refs) => {
        for (const ref of refs) await resolveOrCreateRun(ref);
      });
      expect(builds()).toBe(1);
      const again = await compareRuns(a, b);
      expect(again.runIdA).not.toBe(first.runIdA);
      expect(builds()).toBe(2);
      expect(again.metrics).toEqual(first.metrics);
    });
  });
});
