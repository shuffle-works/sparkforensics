import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { collectRun } from '../src/cli/collect-run.js';
import {
  collectRunPair, collectRunInWorker, estimatedParseBytes, MIN_OFFLOAD_PARSE_BYTES,
} from '../src/cli/collect-run-pair.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const AQE_SKEW = join(FIXTURES, 'aqe-skew-spark-3.5.ndjson');
const CACHE = join(FIXTURES, 'cache-block-updates.ndjson');

const dirs = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-pair-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('estimatedParseBytes', () => {
  it('is the size on disk for a plain-text log', () => {
    expect(estimatedParseBytes(AQE_SKEW)).toBe(readFileSync(AQE_SKEW).length);
  });

  it('weighs a compressed log by how much event text it holds', () => {
    const dir = tmpDir();
    const path = join(dir, 'log.zstd');
    writeFileSync(path, zstdCompressSync(readFileSync(AQE_SKEW)));
    const onDisk = readFileSync(path).length;
    expect(estimatedParseBytes(path)).toBeGreaterThan(onDisk);
  });

  it('sums the parts of a rolling-log directory', () => {
    const dir = tmpDir();
    const a = join(dir, 'events_1_app'), b = join(dir, 'events_2_app');
    writeFileSync(a, 'x'.repeat(10));
    writeFileSync(b, 'y'.repeat(32));
    expect(estimatedParseBytes(dir)).toBe(42);
  });

  it('is 0 for a path that cannot be read, so the parse reports it', () => {
    expect(estimatedParseBytes(join(tmpDir(), 'missing'))).toBe(0);
  });
});

describe('collectRunPair', () => {
  it('parses both logs in this thread when the smaller one is below the threshold', async () => {
    const { baseline, candidate } = await collectRunPair(CACHE, AQE_SKEW);
    expect(baseline.status).toBe('fulfilled');
    expect(candidate.status).toBe('fulfilled');
    expect(readFileSync(CACHE).length).toBeLessThan(MIN_OFFLOAD_PARSE_BYTES);
    expect(baseline.value.appModel.app.id).toBe((await collectRun(CACHE)).appModel.app.id);
  });

  it('returns the same models from a worker thread as from this one, whichever log it parses', async () => {
    const own = { baseline: await collectRun(CACHE), candidate: await collectRun(AQE_SKEW) };
    const { baseline, candidate } = await collectRunPair(CACHE, AQE_SKEW, { minOffloadBytes: 0 });
    expect(baseline.value).toEqual(own.baseline);
    expect(candidate.value).toEqual(own.candidate);

    const swapped = await collectRunPair(AQE_SKEW, CACHE, { minOffloadBytes: 0 });
    expect(swapped.baseline.value).toEqual(own.candidate);
    expect(swapped.candidate.value).toEqual(own.baseline);
  });

  it('keeps the model\'s Maps and numbers as they are after the worker\'s structured clone', async () => {
    const { baseline } = await collectRunPair(AQE_SKEW, CACHE, { minOffloadBytes: 0 });
    const own = await collectRun(AQE_SKEW);
    expect(baseline.value.appModel.stages).toBeInstanceOf(Map);
    expect([...baseline.value.appModel.stages.keys()]).toEqual([...own.appModel.stages.keys()]);
    expect(baseline.value.skippedLines).toBe(own.skippedLines);
  });

  it('does not read the candidate when the baseline cannot be parsed in this thread', async () => {
    const dir = tmpDir();
    const bad = join(dir, 'bad');
    writeFileSync(bad, 'not an event log\n');
    const { baseline, candidate } = await collectRunPair(bad, AQE_SKEW);
    expect(baseline.status).toBe('rejected');
    expect(baseline.reason.message).toMatch(/Not a Spark event log/);
    expect(candidate).toBeUndefined();
  });

  it('settles both sides when one log fails on the worker thread', async () => {
    const dir = tmpDir();
    const bad = join(dir, 'bad');
    writeFileSync(bad, 'not an event log\n');
    const { baseline, candidate } = await collectRunPair(AQE_SKEW, bad, { minOffloadBytes: 0 });
    expect(baseline.status).toBe('fulfilled');
    expect(candidate.status).toBe('rejected');
    expect(candidate.reason.message).toMatch(/Not a Spark event log/);
  });

  it('reports a missing log with the message and code the parse in this thread gives', async () => {
    const missing = join(tmpDir(), 'missing');
    const own = await collectRun(missing).catch((e) => e);
    const { baseline } = await collectRunPair(missing, AQE_SKEW, { minOffloadBytes: 0 });
    expect(baseline.status).toBe('rejected');
    expect(baseline.reason.message).toBe(own.message);
    expect(baseline.reason.code).toBe(own.code);
  });
});

describe('collectRunInWorker', () => {
  it('parses a rolling-log directory like collectRun does', async () => {
    const dir = tmpDir();
    const logDir = join(dir, 'eventlog_v2_app-1');
    mkdirSync(logDir);
    const lines = readFileSync(AQE_SKEW, 'utf8').split('\n').filter(Boolean);
    writeFileSync(join(logDir, 'events_1_app-1'), `${lines.slice(0, 5).join('\n')}\n`);
    writeFileSync(join(logDir, 'events_2_app-1'), `${lines.slice(5).join('\n')}\n`);
    expect(await collectRunInWorker(logDir)).toEqual(await collectRun(logDir));
  });
});
