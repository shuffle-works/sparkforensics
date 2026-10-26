import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/sparkforensics-analyze.mjs';
import { zipSync, strToU8 } from '@sparkforensics/core/vendor/fflate.js';

// Synthetic single-stage log: ten tasks, the last `slowMs` long, finishing at `slowMs`.
function log({ slowMs, appId, appName = 't' }) {
  const task = (id, ms) => JSON.stringify({
    Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
    'Task Info': { 'Task ID': id, 'Launch Time': 0, 'Finish Time': ms, Failed: false, Killed: false, Speculative: false },
    'Task Metrics': { 'Executor Run Time': ms, 'JVM GC Time': ms / 10, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
  });
  const lines = [
    `{"Event":"SparkListenerApplicationStart","App ID":"${appId}","App Name":"${appName}","Timestamp":0}`,
    '{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10}}',
  ];
  for (let i = 0; i < 9; i++) lines.push(task(i, 100));
  lines.push(task(9, slowMs));
  lines.push(`{"Event":"SparkListenerStageCompleted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10,"Completion Time":${slowMs}}}`);
  lines.push(`{"Event":"SparkListenerApplicationEnd","Timestamp":${slowMs}}`);
  return `${lines.join('\n')}\n`;
}

const BASE_ID = 'application_0000000000000_0100';
const FAST_ID = 'application_0000000000000_0101';
const SLOW_ID = 'application_0000000000000_0102';
const SLOWER_ID = 'application_0000000000000_0103';
const MISSING_ID = 'application_0000000000000_0199';
const BASELINE_HOST = 'baseline-history.example.test';
const CANDIDATE_HOST = 'candidate-history.example.test';
const BASELINE_NAME = 'ip-10-20-30-40';

const LOGS = {
  [BASE_ID]: log({ slowMs: 2000, appId: BASE_ID, appName: BASELINE_NAME }),
  [FAST_ID]: log({ slowMs: 2000, appId: FAST_ID }),
  [SLOW_ID]: log({ slowMs: 4000, appId: SLOW_ID }),
  [SLOWER_ID]: log({ slowMs: 6000, appId: SLOWER_ID }),
};

// A fake History Server: serves the log of the application named in /api/v1/applications/<id>[/<attempt>]/logs
// and 404s any other. Every requested URL is recorded.
function fakeShs() {
  const requested = [];
  const fetchImpl = vi.fn(async (url) => {
    requested.push(String(url));
    const appId = new URL(url).pathname.split('/')[4];
    if (!LOGS[appId]) return new Response(null, { status: 404 });
    return new Response(zipSync({ eventlog: strToU8(LOGS[appId]) }), { status: 200 });
  });
  return { fetchImpl, requested };
}

// Created at load time: the it.each tables below build their argument lists while collecting.
const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-shs-baseline-'));
const p = (name) => join(dir, name);
writeFileSync(p('baseline'), LOGS[BASE_ID]);
writeFileSync(p('slow'), LOGS[SLOW_ID]);
writeFileSync(p('garbage'), 'this is not an event log\n');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(argv, options) {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await main(argv, options);
    const stdout = out.mock.calls.map(([c]) => c).join('');
    return {
      status: process.exitCode,
      stdout,
      stderr: err.mock.calls.map(([c]) => c).join(''),
      get lines() { return stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)); },
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = previous;
  }
}

const baselineShs = (appId = BASE_ID, host = BASELINE_HOST) => [
  '--baseline-shs-base-url', `http://${host}:18080`, '--baseline-app-id', appId,
];
const candidateShs = (...appIds) => [
  '--shs-base-url', `http://${CANDIDATE_HOST}:18080`, ...appIds.flatMap((id) => ['--app-id', id]),
];
const wallClock = (comparison) => comparison.metrics.find((m) => m.key === 'wallClock');

describe('--baseline-shs-base-url argument validation', () => {
  it.each([
    [
      'a path baseline and a History Server baseline together',
      [p('slow'), '--baseline', p('baseline'), ...baselineShs()],
      /Pass either --baseline <path> or --baseline-shs-base-url, not both/,
    ],
    [
      '--baseline-shs-base-url without --baseline-app-id',
      [p('slow'), '--baseline-shs-base-url', 'http://shs:18080'],
      /--baseline-shs-base-url requires --baseline-app-id/,
    ],
    [
      '--baseline-attempt-id without an app id',
      [p('slow'), '--baseline-shs-base-url', 'http://shs:18080', '--baseline-attempt-id', '1'],
      /--baseline-shs-base-url requires --baseline-app-id/,
    ],
    [
      '--baseline-app-id without --baseline-shs-base-url',
      [p('slow'), '--baseline-app-id', BASE_ID],
      /--baseline-app-id\/--baseline-attempt-id require --baseline-shs-base-url/,
    ],
    [
      '--baseline-attempt-id without --baseline-shs-base-url',
      [p('slow'), '--baseline', p('baseline'), '--baseline-attempt-id', '1'],
      /--baseline-app-id\/--baseline-attempt-id require --baseline-shs-base-url/,
    ],
    [
      'a non-HTTP --baseline-shs-base-url',
      [p('slow'), '--baseline-shs-base-url', 'ftp://shs', '--baseline-app-id', BASE_ID],
      /Invalid --baseline-shs-base-url/,
    ],
    [
      'an unsupported --baseline-app-id',
      [p('slow'), '--baseline-shs-base-url', 'http://shs:18080', '--baseline-app-id', 'myapp'],
      /Invalid --baseline-app-id/,
    ],
    [
      'a path-unsafe --baseline-attempt-id',
      [p('slow'), ...baselineShs(), '--baseline-attempt-id', '../x'],
      /Invalid --baseline-attempt-id/,
    ],
  ])('exits 2 before any fetch for %s', async (_, argv, message) => {
    const { fetchImpl } = fakeShs();
    const { status, stdout, stderr } = await run(argv, { fetchImpl });
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(message);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['--max-regression-pct', '10'],
    ['--regression-budget', 'wallClock:10'],
    ['--stage-regression-budget', 'executorRunTime:10'],
    ['--fail-on-introduced', 'all'],
    ['--normalize-path', 'x'],
    ['--ignore-conf', 'x'],
    ['--noise-band-pct', '5'],
    ['--executor-ratio', '2'],
    ['--unmatched-stages-pct', '30'],
    ['--task-count-change-pct', '30'],
  ])('accepts %s with a History Server baseline and still refuses it without any baseline', async (flag, value) => {
    const { fetchImpl } = fakeShs();
    const withBaseline = await run([p('slow'), ...baselineShs(), flag, value], { fetchImpl });
    expect(withBaseline.status).not.toBe(2);
    const without = await run([p('slow'), flag, value], { fetchImpl });
    expect(without.status).toBe(2);
    expect(without.stderr).toMatch(/require --baseline or --baseline-shs-base-url/);
  });
});

describe('a History Server baseline', () => {
  it('compares a local candidate against it, the same as against the local copy of that log', async () => {
    const { fetchImpl, requested } = fakeShs();
    const viaShs = await run([p('slow'), ...baselineShs()], { fetchImpl });
    const viaPath = await run([p('slow'), '--baseline', p('baseline')]);
    expect(viaShs.status).toBe(0);
    expect(requested).toEqual([`http://${BASELINE_HOST}:18080/api/v1/applications/${BASE_ID}/logs`]);
    const { comparison } = JSON.parse(viaShs.stdout);
    expect(wallClock(comparison)).toMatchObject({ delta: 2000 });
    // Only the baseline's own app id differs between the two sources' outputs: none appears in the comparison.
    expect(JSON.parse(viaShs.stdout)).toEqual(JSON.parse(viaPath.stdout));
  });

  it('requests the baseline attempt', async () => {
    const { fetchImpl, requested } = fakeShs();
    const { status } = await run([p('slow'), ...baselineShs(), '--baseline-attempt-id', '2'], { fetchImpl });
    expect(status).toBe(0);
    expect(requested).toEqual([`http://${BASELINE_HOST}:18080/api/v1/applications/${BASE_ID}/2/logs`]);
  });

  it('compares a History Server candidate against a History Server baseline on another server', async () => {
    const { fetchImpl, requested } = fakeShs();
    const { status, stdout } = await run([...candidateShs(SLOW_ID), ...baselineShs()], { fetchImpl });
    expect(status).toBe(0);
    expect(requested.sort()).toEqual([
      `http://${BASELINE_HOST}:18080/api/v1/applications/${BASE_ID}/logs`,
      `http://${CANDIDATE_HOST}:18080/api/v1/applications/${SLOW_ID}/logs`,
    ]);
    expect(wallClock(JSON.parse(stdout).comparison)).toMatchObject({ delta: 2000 });
  });

  it('compares a History Server candidate against a local baseline as before', async () => {
    const { fetchImpl } = fakeShs();
    const { status, stdout } = await run([...candidateShs(SLOW_ID), '--baseline', p('baseline')], { fetchImpl });
    expect(status).toBe(0);
    expect(wallClock(JSON.parse(stdout).comparison)).toMatchObject({ delta: 2000 });
  });

  it('renders the Markdown comparison section', async () => {
    const { fetchImpl } = fakeShs();
    const { status, stdout } = await run([p('slow'), ...baselineShs(), '--format', 'md'], { fetchImpl });
    expect(status).toBe(0);
    expect(stdout).toMatch(/wall/i);
  });

  it('applies --max-regression-pct and --regression-budget: exit 1 on a regression, 0 within budget', async () => {
    const { fetchImpl } = fakeShs();
    const over = await run([p('slow'), ...baselineShs(), '--max-regression-pct', '10'], { fetchImpl });
    expect(over.status).toBe(1);
    expect(over.stderr).toMatch(/\[violation\]/);
    const budget = await run([p('slow'), ...baselineShs(), '--regression-budget', 'wallClock:10'], { fetchImpl });
    expect(budget.status).toBe(1);
    const within = await run([p('slow'), ...baselineShs(), '--max-regression-pct', '150'], { fetchImpl });
    expect(within.status).toBe(0);
  });

  it('applies --budgets from a file', async () => {
    const { fetchImpl } = fakeShs();
    writeFileSync(p('budgets.json'), JSON.stringify({ regression: { wallClock: 10 } }));
    expect((await run([p('slow'), ...baselineShs(), '--budgets', p('budgets.json')], { fetchImpl })).status).toBe(1);
  });

  it('applies --stage-regression-budget to the stages it pairs', async () => {
    const { fetchImpl } = fakeShs();
    const { status, stderr } = await run([p('slow'), ...baselineShs(), '--stage-regression-budget', 'executorRunTime:10'], { fetchImpl });
    expect(status).toBe(1);
    expect(stderr).toMatch(/\[violation\]/);
  });

  it('applies --fail-on-introduced exactly as it does with a path baseline', async () => {
    const { fetchImpl } = fakeShs();
    const flags = ['--fail-on-introduced', 'all'];
    const viaShs = await run([p('slow'), ...baselineShs(), ...flags], { fetchImpl });
    const viaPath = await run([p('slow'), '--baseline', p('baseline'), ...flags]);
    expect(viaShs.status).toBe(viaPath.status);
    expect(viaShs.stderr).toBe(viaPath.stderr);
    expect(JSON.parse(viaShs.stdout)).toEqual(JSON.parse(viaPath.stdout));
  });

  it('exits 5 when the baseline fetch fails, even when the candidate fails too', async () => {
    const missing = fakeShs();
    expect((await run([p('slow'), ...baselineShs(MISSING_ID)], { fetchImpl: missing.fetchImpl })).status).toBe(5);
    expect((await run([p('garbage'), ...baselineShs(MISSING_ID)], { fetchImpl: missing.fetchImpl })).status).toBe(5);
    expect((await run([p('garbage'), ...baselineShs()], { fetchImpl: fakeShs().fetchImpl })).status).toBe(4);
  });
});

describe('--redact with a History Server baseline', () => {
  const leaks = (text) => [BASE_ID, BASELINE_NAME, BASELINE_HOST, CANDIDATE_HOST, SLOW_ID]
    .filter((token) => text.includes(token));

  it('writes no baseline app id, app name or server host to JSON, Markdown or a file', async () => {
    const { fetchImpl } = fakeShs();
    const json = await run([p('slow'), ...baselineShs(), '--redact'], { fetchImpl });
    expect(json.status).toBe(0);
    expect(leaks(json.stdout + json.stderr)).toEqual([]);
    expect(json.stdout).toContain('app-1');

    const md = await run([p('slow'), ...baselineShs(), '--redact', '--format', 'md'], { fetchImpl });
    expect(leaks(md.stdout + md.stderr).filter((t) => t !== SLOW_ID)).toEqual([]);

    const out = p('redacted.json');
    await run([p('slow'), ...baselineShs(), '--redact', '--out', out], { fetchImpl });
    expect(leaks(readFileSync(out, 'utf8'))).toEqual([]);
  });

  it('matches the output a path baseline gives under --redact', async () => {
    const { fetchImpl } = fakeShs();
    const viaShs = await run([p('slow'), ...baselineShs(), '--redact'], { fetchImpl });
    const viaPath = await run([p('slow'), '--baseline', p('baseline'), '--redact']);
    expect(JSON.parse(viaShs.stdout)).toEqual(JSON.parse(viaPath.stdout));
  });

  it('writes no baseline app id or host when both runs come from a History Server', async () => {
    const { fetchImpl } = fakeShs();
    const { status, stdout, stderr } = await run([...candidateShs(SLOW_ID), ...baselineShs(), '--redact'], { fetchImpl });
    expect(status).toBe(0);
    expect(leaks(stdout + stderr)).toEqual([]);
  });

  it('names the role, not the server or app id, of a failed baseline fetch', async () => {
    const { fetchImpl } = fakeShs();
    const { status, stdout, stderr } = await run([p('slow'), ...baselineShs(MISSING_ID), '--redact'], { fetchImpl });
    expect(status).toBe(5);
    expect(stdout).toBe('');
    expect(stderr).toBe('The baseline could not be read or parsed.\n');
  });

  it('writes no baseline identity for several candidates either', async () => {
    const { fetchImpl } = fakeShs();
    const { status, stdout, stderr } = await run([...candidateShs(SLOW_ID, SLOWER_ID), ...baselineShs(), '--redact'], { fetchImpl });
    expect(status).toBe(0);
    expect(leaks(stdout + stderr)).toEqual([]);
  });
});

describe('several History Server candidates', () => {
  it('writes one NDJSON line per --app-id, in argument order, each fetched from the one server', async () => {
    const { fetchImpl, requested } = fakeShs();
    const { status, lines } = await run([...candidateShs(FAST_ID, SLOW_ID, SLOWER_ID), '--baseline', p('baseline')], { fetchImpl });
    expect(status).toBe(0);
    expect(lines.map((l) => l.log)).toEqual([FAST_ID, SLOW_ID, SLOWER_ID]);
    expect(lines.map((l) => wallClock(l.comparison).delta)).toEqual([0, 2000, 4000]);
    expect(lines.every((l) => l.status === 'pass' && l.exitCode === 0 && l.error === null)).toBe(true);
    expect(requested.map((u) => new URL(u).host)).toEqual(Array(3).fill(`${CANDIDATE_HOST}:18080`));
  });

  it('gives each candidate the same line a single History Server candidate gets', async () => {
    const { fetchImpl } = fakeShs();
    const [line] = (await run([...candidateShs(SLOW_ID, SLOWER_ID), '--baseline', p('baseline')], { fetchImpl })).lines;
    const single = JSON.parse((await run([...candidateShs(SLOW_ID), '--baseline', p('baseline')], { fetchImpl })).stdout);
    expect(line.candidate).toEqual(single.candidate);
    expect(line.comparison).toEqual(single.comparison);
  });

  it('works against a History Server baseline, and applies the budgets to every candidate', async () => {
    const { fetchImpl, requested } = fakeShs();
    const { status, lines } = await run([
      ...candidateShs(FAST_ID, SLOW_ID), ...baselineShs(), '--regression-budget', 'wallClock:10',
    ], { fetchImpl });
    expect(status).toBe(1);
    expect(lines.map((l) => l.status)).toEqual(['pass', 'violation']);
    // The baseline is fetched once, whatever the number of candidates.
    expect(requested.filter((u) => u.includes(BASE_ID))).toHaveLength(1);
  });

  it('names an attempt with <id>:<attempt>, per application', async () => {
    const { fetchImpl, requested } = fakeShs();
    const { status, lines } = await run([...candidateShs(FAST_ID, `${SLOW_ID}:2`), '--baseline', p('baseline')], { fetchImpl });
    expect(status).toBe(0);
    expect(lines.map((l) => l.log)).toEqual([FAST_ID, `${SLOW_ID}:2`]);
    expect(requested.map((u) => new URL(u).pathname)).toEqual([
      `/api/v1/applications/${FAST_ID}/logs`,
      `/api/v1/applications/${SLOW_ID}/2/logs`,
    ]);
  });

  it('writes an error line for a candidate that cannot be fetched and still runs the rest', async () => {
    const { fetchImpl } = fakeShs();
    const { status, lines, stderr } = await run([...candidateShs(MISSING_ID, SLOW_ID), '--baseline', p('baseline')], { fetchImpl });
    expect(status).toBe(4);
    expect(lines.map((l) => [l.log, l.status, l.exitCode])).toEqual([[MISSING_ID, 'error', 4], [SLOW_ID, 'pass', 0]]);
    expect(stderr).toMatch(new RegExp(`${MISSING_ID}: \\[error\\]`));
  });

  it('exits 5 and writes no line when the baseline cannot be fetched', async () => {
    const { fetchImpl } = fakeShs();
    const { status, stdout } = await run([...candidateShs(FAST_ID, SLOW_ID), ...baselineShs(MISSING_ID)], { fetchImpl });
    expect(status).toBe(5);
    expect(stdout).toBe('');
  });

  it('names a candidate by position under --redact', async () => {
    const { fetchImpl } = fakeShs();
    const { lines, stderr } = await run([
      ...candidateShs(MISSING_ID, SLOW_ID), '--baseline', p('baseline'), '--redact',
    ], { fetchImpl });
    expect(lines.map((l) => l.log)).toEqual(['candidate-1', 'candidate-2']);
    expect(lines[0].error).toBe('Candidate 1 could not be read or parsed.');
    expect(stderr).not.toContain(MISSING_ID);
    expect(stderr).not.toContain(CANDIDATE_HOST);
  });

  it('writes the lines to --out', async () => {
    const { fetchImpl } = fakeShs();
    const out = p('lines.ndjson');
    const { stdout } = await run([...candidateShs(FAST_ID, SLOW_ID), '--baseline', p('baseline'), '--out', out], { fetchImpl });
    expect(stdout).toBe('');
    expect(readFileSync(out, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  });

  it.each([
    [
      'several --app-id values without a baseline',
      candidateShs(FAST_ID, SLOW_ID),
      /Several --app-id values require --baseline or --baseline-shs-base-url/,
    ],
    [
      '--attempt-id with several --app-id values',
      [...candidateShs(FAST_ID, SLOW_ID), '--attempt-id', '1', '--baseline', 'x'],
      /--attempt-id applies to a single --app-id/,
    ],
    [
      '--attempt-id with an <id>:<attempt> value',
      [...candidateShs(`${FAST_ID}:1`), '--attempt-id', '1'],
      /--attempt-id applies to a single --app-id/,
    ],
    [
      'an empty attempt after the colon',
      [...candidateShs(`${FAST_ID}:`), '--baseline', 'x'],
      /Invalid --app-id: an attempt must follow ":"/,
    ],
    [
      'a path-unsafe attempt in --app-id',
      [...candidateShs(`${FAST_ID}:../x`), '--baseline', 'x'],
      /Invalid --attempt-id/,
    ],
    [
      'one invalid --app-id among valid ones',
      [...candidateShs(FAST_ID, 'myapp'), '--baseline', 'x'],
      /Invalid --app-id/,
    ],
    [
      'a positional log mixed with --app-id values',
      [p('slow'), ...candidateShs(FAST_ID, SLOW_ID), '--baseline', 'x'],
      /Pass either <event-log-file\|rolling-log-dir> or --shs-base-url, not both/,
    ],
    [
      '--format json with several candidates',
      [...candidateShs(FAST_ID, SLOW_ID), '--baseline', 'x', '--format', 'json'],
      /Several candidates write NDJSON/,
    ],
    [
      '--export-html with several candidates',
      [...candidateShs(FAST_ID, SLOW_ID), '--baseline', 'x', '--export-html', p('export')],
      /--export-html writes one dashboard/,
    ],
    [
      '--format ndjson with a single History Server candidate',
      [...candidateShs(FAST_ID), '--baseline', 'x', '--format', 'ndjson'],
      /^--format ndjson requires --baseline and a local candidate log\./,
    ],
  ])('exits 2 before any fetch for %s', async (_, argv, message) => {
    const { fetchImpl } = fakeShs();
    const { status, stdout, stderr } = await run(argv, { fetchImpl });
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(message);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a single History Server candidate', () => {
  it('keeps --attempt-id for its attempt', async () => {
    const { fetchImpl, requested } = fakeShs();
    const { status } = await run([...candidateShs(SLOW_ID), '--attempt-id', '3', '--baseline', p('baseline')], { fetchImpl });
    expect(status).toBe(0);
    expect(requested).toEqual([`http://${CANDIDATE_HOST}:18080/api/v1/applications/${SLOW_ID}/3/logs`]);
  });
});

describe('SPARKFORENSICS_SHS_BASE_URL', () => {
  afterEach(() => vi.unstubAllEnvs());
  const envUrl = `http://${CANDIDATE_HOST}:18080`;

  it('is the History Server for --app-id and --baseline-app-id, and a flag wins over it', async () => {
    vi.stubEnv('SPARKFORENSICS_SHS_BASE_URL', envUrl);
    const { fetchImpl, requested } = fakeShs();
    const { status } = await run(['--app-id', SLOW_ID, '--baseline-app-id', BASE_ID, '--baseline-shs-base-url', `http://${BASELINE_HOST}:18080`], { fetchImpl });
    expect(status).toBe(0);
    expect(requested.sort()).toEqual([
      `http://${BASELINE_HOST}:18080/api/v1/applications/${BASE_ID}/logs`,
      `${envUrl}/api/v1/applications/${SLOW_ID}/logs`,
    ]);
  });

  it('does not turn a local log into a History Server run', async () => {
    vi.stubEnv('SPARKFORENSICS_SHS_BASE_URL', envUrl);
    const { fetchImpl } = fakeShs();
    const { status } = await run([p('slow')], { fetchImpl });
    expect(status).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is named in the error for an --app-id with no History Server', async () => {
    vi.stubEnv('SPARKFORENSICS_SHS_BASE_URL', '');
    const { fetchImpl } = fakeShs();
    const { status, stderr } = await run(['--app-id', SLOW_ID], { fetchImpl });
    expect(status).toBe(2);
    expect(stderr).toMatch(/--app-id\/--attempt-id require --shs-base-url or SPARKFORENSICS_SHS_BASE_URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
