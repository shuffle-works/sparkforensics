import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseRun, compareRuns, resolveOrCreateRun } from '../src/mcp-tools.js';
import { parseThresholdOverrides } from '../src/threshold-overrides.ts';

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

describe('compareRuns result cache', () => {
  const pair = [{ appId: 'app-c-a', slowMs: 100 }, { appId: 'app-c-b', slowMs: 2000 }];

  it('serves an identical repeated call from the cache', async () => {
    await withLogs(pair, async ([a, b]) => {
      const first = await compareRuns(a, b);
      const second = await compareRuns(a, b);
      expect(second.metrics).toBe(first.metrics);
      expect(second).toEqual(first);
    });
  });

  it('does not share a result between opposite orders', async () => {
    await withLogs(pair, async ([a, b]) => {
      const forward = await compareRuns(a, b);
      const backward = await compareRuns(b, a);
      expect(backward.runIdA).toBe(forward.runIdB);
      expect(backward.metrics).not.toBe(forward.metrics);
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
      expect((await compareRuns(a, b, { include: ['stagePairs'] })).stagePairs).toBe(full.stagePairs);
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
    expect(other.stagePairs).not.toBe(plain.stagePairs);
    expect((await compareRuns(a, b, { include: ['stagePairs'], normalizePath: ['\\d+'] })).stagePairs).toBe(normalized.stagePairs);
    expect((await compareRuns(a, b, { include: ['stagePairs'] })).stagePairs).toBe(plain.stagePairs);
  });

  it('computes a fresh comparison under different thresholds', async () => {
    await withLogs([{ appId: 'app-c-t1', slowMs: 100 }, { appId: 'app-c-t2', slowMs: 2000 }], async ([a, b]) => {
      const tuned = parseThresholdOverrides({ skew: { ratioWarn: 2 } });
      const plain = await compareRuns(a, b);
      const withTuned = await compareRuns(a, b, { thresholds: tuned });
      expect(withTuned.metrics).not.toBe(plain.metrics);
      expect(withTuned.tunedThresholds).toBeDefined();
      expect(plain.tunedThresholds).toBeUndefined();
      expect((await compareRuns(a, b, { thresholds: tuned })).metrics).toBe(withTuned.metrics);
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
      const again = await compareRuns(a, b);
      expect(again.runIdA).not.toBe(first.runIdA);
      expect(again.metrics).not.toBe(first.metrics);
      expect(again.metrics).toEqual(first.metrics);
    });
  });
});
