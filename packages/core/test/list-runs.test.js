import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { listRunsLocal, listRunsShs, listRuns } from '../src/list-runs.js';

// Real multi-attempt fixtures: same appId, disambiguated only by the `_1`/`_2` filename suffix.
// dev/log-corpus is a git submodule (public corpus repo), checked out in CI; tests depending on
// these skip locally until `git submodule update --init dev/log-corpus`.
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dev', 'log-corpus', 'logs', 'external');
const ATTEMPT_FIXTURE_1 = join(FIXTURES_DIR, 'external-local-1430917381535_1.ndjson');
const ATTEMPT_FIXTURE_2 = join(FIXTURES_DIR, 'external-local-1430917381535_2.ndjson');

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop(), { recursive: true, force: true });
});

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-list-runs-'));
  cleanupDirs.push(dir);
  return dir;
}

function writeEventLog(path, { appId, name = 't', timestamp = 0 }) {
  writeFileSync(path,
    `{"Event":"SparkListenerApplicationStart","App ID":"${appId}","App Name":"${name}","Timestamp":${timestamp}}\n`
    + '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n');
}

describe('listRunsLocal', () => {
  it('lists a single-file event log', async () => {
    const dir = tmpDir();
    writeEventLog(join(dir, 'app1.ndjson'), { appId: 'app-1', name: 'First' });
    const result = await listRunsLocal({ dir });
    expect(result.truncated).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ appId: 'app-1', name: 'First', source: { path: join(dir, 'app1.ndjson') } });
  });

  it('skips an unrelated non-log file without failing the listing', async () => {
    const dir = tmpDir();
    writeEventLog(join(dir, 'app1.ndjson'), { appId: 'app-1' });
    writeFileSync(join(dir, 'README.txt'), 'not a spark log\njust some text\n');
    const result = await listRunsLocal({ dir });
    expect(result.runs.map((r) => r.appId)).toEqual(['app-1']);
  });

  it('scans a rolling-log subdirectory by peeking its earliest segment', async () => {
    const dir = tmpDir();
    const rollingDir = join(dir, 'eventlog_v2_app-rolling');
    mkdirSync(rollingDir);
    writeFileSync(join(rollingDir, 'events_1_app-rolling'),
      '{"Event":"SparkListenerApplicationStart","App ID":"app-rolling","App Name":"r","Timestamp":0}\n');
    writeFileSync(join(rollingDir, 'events_2_app-rolling'), '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n');
    const result = await listRunsLocal({ dir });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ appId: 'app-rolling', source: { path: rollingDir } });
  });

  it('does not recurse into a non-rolling subdirectory', async () => {
    const dir = tmpDir();
    writeEventLog(join(dir, 'app1.ndjson'), { appId: 'app-1' });
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    writeEventLog(join(nested, 'app2.ndjson'), { appId: 'app-2' });
    const result = await listRunsLocal({ dir });
    expect(result.runs.map((r) => r.appId)).toEqual(['app-1']);
  });

  it('filters by namePattern case-insensitively', async () => {
    const dir = tmpDir();
    writeEventLog(join(dir, 'a.ndjson'), { appId: 'app-a', name: 'ProdJob' });
    writeEventLog(join(dir, 'b.ndjson'), { appId: 'app-b', name: 'TestJob' });
    const result = await listRunsLocal({ dir, namePattern: 'prod' });
    expect(result.runs.map((r) => r.appId)).toEqual(['app-a']);
  });

  it('filters by minDate/maxDate against startTime', async () => {
    const dir = tmpDir();
    writeEventLog(join(dir, 'old.ndjson'), { appId: 'app-old', timestamp: Date.parse('2020-01-01T00:00:00.000Z') });
    writeEventLog(join(dir, 'new.ndjson'), { appId: 'app-new', timestamp: Date.parse('2026-01-01T00:00:00.000Z') });
    const result = await listRunsLocal({ dir, minDate: '2025-01-01' });
    expect(result.runs.map((r) => r.appId)).toEqual(['app-new']);
  });

  it('caps at maxResults and sets truncated', async () => {
    const dir = tmpDir();
    for (let i = 0; i < 5; i++) writeEventLog(join(dir, `app${i}.ndjson`), { appId: `app-${i}` });
    const result = await listRunsLocal({ dir, maxResults: 2 });
    expect(result.runs).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('returns the newest runs first, so maxResults keeps the most recent', async () => {
    const dir = tmpDir();
    // Written oldest-last so readdir order alone could not produce the expected result.
    writeEventLog(join(dir, 'a-middle.ndjson'), { appId: 'app-middle', timestamp: Date.parse('2023-01-01T00:00:00.000Z') });
    writeEventLog(join(dir, 'b-new.ndjson'), { appId: 'app-new', timestamp: Date.parse('2026-01-01T00:00:00.000Z') });
    writeEventLog(join(dir, 'c-old.ndjson'), { appId: 'app-old', timestamp: Date.parse('2020-01-01T00:00:00.000Z') });
    const result = await listRunsLocal({ dir, maxResults: 2 });
    expect(result.runs.map((r) => r.appId)).toEqual(['app-new', 'app-middle']);
    expect(result.truncated).toBe(true);
  });

  it('throws directory-not-found for a missing directory', async () => {
    await expect(listRunsLocal({ dir: '/definitely/does/not/exist' }))
      .rejects.toMatchObject({ code: 'directory-not-found' });
  });

  it('throws directory-not-found when dir is actually a file', async () => {
    const dir = tmpDir();
    const filePath = join(dir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    await expect(listRunsLocal({ dir: filePath })).rejects.toMatchObject({ code: 'directory-not-found' });
  });

  // Bug: Date.parse of an unparseable minDate/maxDate returns NaN, and every comparison against
  // NaN is false, that used to silently filter out every run rather than surfacing the mistake,
  // indistinguishable from a correctly-filtered "no runs matched" result.
  it('throws invalid-date-filter for an unparseable minDate instead of silently returning zero runs', async () => {
    const dir = tmpDir();
    writeEventLog(join(dir, 'app1.ndjson'), { appId: 'app-1' });
    await expect(listRunsLocal({ dir, minDate: 'not-a-date' }))
      .rejects.toMatchObject({ code: 'invalid-date-filter' });
  });

  it('throws invalid-date-filter for an unparseable maxDate instead of silently returning zero runs', async () => {
    const dir = tmpDir();
    writeEventLog(join(dir, 'app1.ndjson'), { appId: 'app-1' });
    await expect(listRunsLocal({ dir, maxDate: 'not-a-date' }))
      .rejects.toMatchObject({ code: 'invalid-date-filter' });
  });

  // Bug: local mode produced source: { path } with no attempt id, unlike SHS mode's
  // attempts[0]/attemptId, so two attempts of the same Spark app (same appId, different
  // `_<n>` filename suffix) couldn't be told apart.
  it.skipIf(!existsSync(ATTEMPT_FIXTURE_1) || !existsSync(ATTEMPT_FIXTURE_2))(
    'stamps a distinct attemptId per numbered-suffix attempt of the same app',
    async () => {
      const dir = tmpDir();
      copyFileSync(ATTEMPT_FIXTURE_1, join(dir, 'external-local-1430917381535_1.ndjson'));
      copyFileSync(ATTEMPT_FIXTURE_2, join(dir, 'external-local-1430917381535_2.ndjson'));
      const result = await listRunsLocal({ dir });
      expect(result.runs).toHaveLength(2);
      expect(result.runs.every((r) => r.appId === 'local-1430917381535')).toBe(true);
      expect(result.runs.map((r) => r.source.attemptId).sort()).toEqual(['1', '2']);
    },
  );

  it('does not invent an attemptId for an ordinary single-attempt log', async () => {
    const dir = tmpDir();
    writeEventLog(join(dir, 'app1.ndjson'), { appId: 'app-1' });
    const result = await listRunsLocal({ dir });
    expect(result.runs[0].source.attemptId).toBeUndefined();
  });

  it('does not invent an attemptId for a rolling-log directory candidate', async () => {
    const dir = tmpDir();
    const rollingDir = join(dir, 'eventlog_v2_app-rolling_1');
    mkdirSync(rollingDir);
    writeFileSync(join(rollingDir, 'events_1_app-rolling'),
      '{"Event":"SparkListenerApplicationStart","App ID":"app-rolling","App Name":"r","Timestamp":0}\n');
    writeFileSync(join(rollingDir, 'events_2_app-rolling'), '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n');
    const result = await listRunsLocal({ dir });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].source.attemptId).toBeUndefined();
  });

  describe('redact', () => {
    it('strips appId/name/source.path, giving two attempts of the same app the same pseudonym', async () => {
      const dir = tmpDir();
      writeEventLog(join(dir, 'a1.ndjson'), { appId: 'shared-app', name: 'SharedJob', timestamp: 1000 });
      writeEventLog(join(dir, 'a1_2.ndjson'), { appId: 'shared-app', name: 'SharedJob', timestamp: 2000 });
      const result = await listRunsLocal({ dir, redact: true });
      expect(result.runs).toHaveLength(2);
      const pseudonyms = new Set(result.runs.map((r) => r.appId));
      expect(pseudonyms.size).toBe(1); // same underlying appId => same pseudonym
      for (const run of result.runs) {
        expect(run.appId).toMatch(/^app-\d+$/);
        expect(run.name).toBe(run.appId); // name redacted alongside appId
        expect(run.source.path).toBe(run.appId); // path redacted alongside appId
        expect(run.source.path).not.toContain(dir); // raw path no longer leaked
      }
    });

    it('assigns distinct, stable pseudonyms to distinct apps (numeric-aware sorted)', async () => {
      const dir = tmpDir();
      writeEventLog(join(dir, 'a.ndjson'), { appId: 'zeta-app', name: 'Zeta', timestamp: 1000 });
      writeEventLog(join(dir, 'b.ndjson'), { appId: 'alpha-app', name: 'Alpha', timestamp: 2000 });
      const result = await listRunsLocal({ dir, redact: true });
      const byStartTime = Object.fromEntries(result.runs.map((r) => [r.startTime, r]));
      const zetaEntry = byStartTime[new Date(1000).toISOString()];
      const alphaEntry = byStartTime[new Date(2000).toISOString()];
      expect(alphaEntry.appId).toBe('app-1'); // 'alpha-app' sorts before 'zeta-app'
      expect(zetaEntry.appId).toBe('app-2');
    });
  });
});

function applicationsPayload(apps) {
  return async () => new Response(JSON.stringify(apps), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('listRunsShs', () => {
  it('lists applications, mapping the most recent attempt', async () => {
    const fetchImpl = applicationsPayload([
      {
        id: 'application_1_1', name: 'JobOne',
        attempts: [{ attemptId: '2', startTime: '2026-01-01T00:00:00.000GMT', duration: 5000, appSparkVersion: '3.5.0' }],
      },
    ]);
    const result = await listRunsShs({ shsBaseUrl: 'http://shs:18080' }, { fetchImpl });
    expect(result.truncated).toBe(false);
    expect(result.runs).toEqual([{
      appId: 'application_1_1', name: 'JobOne', sparkVersion: '3.5.0',
      startTime: '2026-01-01T00:00:00.000Z', durationMs: 5000,
      source: { shsBaseUrl: 'http://shs:18080/', appId: 'application_1_1', attemptId: '2' },
    }]);
  });

  it('skips an application with no attempts', async () => {
    const fetchImpl = applicationsPayload([{ id: 'application_1_2', name: 'NoAttempts', attempts: [] }]);
    const result = await listRunsShs({ shsBaseUrl: 'http://shs:18080' }, { fetchImpl });
    expect(result.runs).toHaveLength(0);
  });

  it('filters by namePattern', async () => {
    const fetchImpl = applicationsPayload([
      { id: 'application_1_3', name: 'ProdJob', attempts: [{ startTime: '2026-01-01T00:00:00.000GMT', duration: 1 }] },
      { id: 'application_1_4', name: 'TestJob', attempts: [{ startTime: '2026-01-01T00:00:00.000GMT', duration: 1 }] },
    ]);
    const result = await listRunsShs({ shsBaseUrl: 'http://shs:18080', namePattern: 'prod' }, { fetchImpl });
    expect(result.runs.map((r) => r.appId)).toEqual(['application_1_3']);
  });

  it('filters by minDate/maxDate against startTime', async () => {
    // SHS's own "...GMT"-suffixed format: Date.parse rejects it verbatim, so the filter only works
    // if listRunsShs normalizes the timestamp first.
    const fetchImpl = applicationsPayload([
      { id: 'application_1_old', name: 'old', attempts: [{ startTime: '2020-01-01T00:00:00.000GMT', duration: 1 }] },
      { id: 'application_1_new', name: 'new', attempts: [{ startTime: '2026-01-01T00:00:00.000GMT', duration: 1 }] },
    ]);
    const result = await listRunsShs({ shsBaseUrl: 'http://shs:18080', minDate: '2025-01-01' }, { fetchImpl });
    expect(result.runs.map((r) => r.appId)).toEqual(['application_1_new']);
  });

  it('throws invalid-date-filter for an unparseable minDate instead of silently returning zero runs', async () => {
    const fetchImpl = applicationsPayload([
      { id: 'application_1_10', name: 'x', attempts: [{ startTime: '2026-01-01T00:00:00.000GMT', duration: 1 }] },
    ]);
    await expect(listRunsShs({ shsBaseUrl: 'http://shs:18080', minDate: 'not-a-date' }, { fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid-date-filter' });
  });

  it('throws invalid-date-filter for an unparseable maxDate instead of silently returning zero runs', async () => {
    const fetchImpl = applicationsPayload([
      { id: 'application_1_10', name: 'x', attempts: [{ startTime: '2026-01-01T00:00:00.000GMT', duration: 1 }] },
    ]);
    await expect(listRunsShs({ shsBaseUrl: 'http://shs:18080', maxDate: 'not-a-date' }, { fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid-date-filter' });
  });

  it('redacts appId/name/source.appId, leaving attemptId (not identity-bearing) intact', async () => {
    const fetchImpl = applicationsPayload([
      {
        id: 'application_1_1', name: 'JobOne',
        attempts: [{ attemptId: '2', startTime: '2026-01-01T00:00:00.000GMT', duration: 5000, appSparkVersion: '3.5.0' }],
      },
    ]);
    const result = await listRunsShs({ shsBaseUrl: 'http://shs:18080', redact: true }, { fetchImpl });
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.appId).toBe('app-1');
    expect(run.name).toBe('app-1');
    expect(run.source.appId).toBe('app-1');
    expect(run.source.attemptId).toBe('2');
  });

  it('passes a timeout AbortSignal to the fetch', async () => {
    let seenSignal;
    const fetchImpl = async (_url, init) => {
      seenSignal = init?.signal;
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await listRunsShs({ shsBaseUrl: 'http://shs:18080' }, { fetchImpl });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it('throws access-or-upstream-failure when content-length exceeds the byte cap', async () => {
    const fetchImpl = async () => new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024 * 1024) },
    });
    await expect(listRunsShs({ shsBaseUrl: 'http://shs:18080' }, { fetchImpl }))
      .rejects.toMatchObject({ code: 'access-or-upstream-failure' });
  });

  it('throws invalid-shs-base-url for a malformed base URL', async () => {
    await expect(listRunsShs({ shsBaseUrl: 'not a url' }, { fetchImpl: applicationsPayload([]) }))
      .rejects.toMatchObject({ code: 'invalid-shs-base-url' });
  });

  it('throws access-or-upstream-failure on a connection error', async () => {
    const fetchImpl = async () => { throw new Error('refused'); };
    await expect(listRunsShs({ shsBaseUrl: 'http://shs:18080' }, { fetchImpl }))
      .rejects.toMatchObject({ code: 'access-or-upstream-failure' });
  });

  it('throws access-or-upstream-failure on a non-ok response', async () => {
    const fetchImpl = async () => new Response('nope', { status: 500 });
    await expect(listRunsShs({ shsBaseUrl: 'http://shs:18080' }, { fetchImpl }))
      .rejects.toMatchObject({ code: 'access-or-upstream-failure' });
  });

  it('skips null and non-object entries in the response array', async () => {
    const fetchImpl = applicationsPayload([
      null,
      { id: 'application_1_5', name: 'ValidApp', attempts: [{ startTime: '2026-01-01T00:00:00.000GMT', duration: 1 }] },
      undefined,
      42,
      'string-entry',
      { id: 'application_1_6', name: 'AnotherApp', attempts: [{ startTime: '2026-01-01T00:00:00.000GMT', duration: 1 }] },
    ]);
    const result = await listRunsShs({ shsBaseUrl: 'http://shs:18080' }, { fetchImpl });
    expect(result.runs).toHaveLength(2);
    expect(result.runs.map((r) => r.appId)).toEqual(['application_1_5', 'application_1_6']);
  });
});

describe('listRuns (dispatcher)', () => {
  it('dispatches to local mode when dir is given', async () => {
    const dir = tmpDir();
    writeEventLog(join(dir, 'app1.ndjson'), { appId: 'app-1' });
    const result = await listRuns({ dir });
    expect(result.runs.map((r) => r.appId)).toEqual(['app-1']);
  });

  it('dispatches to SHS mode when shsBaseUrl is given', async () => {
    const fetchImpl = applicationsPayload([{ id: 'application_1_9', name: 'x', attempts: [{ startTime: 't', duration: 1 }] }]);
    const result = await listRuns({ shsBaseUrl: 'http://shs:18080' }, { fetchImpl });
    expect(result.runs.map((r) => r.appId)).toEqual(['application_1_9']);
  });

  it('throws access-or-upstream-failure when neither dir nor shsBaseUrl is given', async () => {
    await expect(listRuns({})).rejects.toMatchObject({ code: 'access-or-upstream-failure' });
  });
});
