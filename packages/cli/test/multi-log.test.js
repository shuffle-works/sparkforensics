import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/sparkforensics-analyze.mjs';
import { shsZipFetch } from '../../../tests/helpers/shs-fixtures.js';

// The bin loads core from vendor-core/ when a fresh copy exists, else from core/src/: fail the
// comparison of one sentinel app in either, to reach the per-candidate internal-error path.
const { FAILING_APP_ID, failComparisonFor } = vi.hoisted(() => {
  const failingAppId = 'application_0000000000000_0666';
  return {
    FAILING_APP_ID: failingAppId,
    failComparisonFor: async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        buildComparison: (baseline, candidate) => {
          if (candidate.appModel.app.id === failingAppId) throw new Error('comparison failed');
          return actual.buildComparison(baseline, candidate);
        },
      };
    },
  };
});
vi.mock('../../core/src/run-comparison.ts', failComparisonFor);
vi.mock('../vendor-core/run-comparison.js', failComparisonFor);

// Synthetic single-stage log: ten tasks, the last `slowMs` long, finishing at `slowMs`.
function log({ slowMs }) {
  const task = (id, ms) => JSON.stringify({
    Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
    'Task Info': { 'Task ID': id, 'Launch Time': 0, 'Finish Time': ms, Failed: false, Killed: false, Speculative: false },
    'Task Metrics': { 'Executor Run Time': ms, 'JVM GC Time': ms / 10, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
  });
  const lines = [
    '{"Event":"SparkListenerApplicationStart","App ID":"application_0000000000000_0001","App Name":"t","Timestamp":0}',
    '{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10}}',
  ];
  for (let i = 0; i < 9; i++) lines.push(task(i, 100));
  lines.push(task(9, slowMs));
  lines.push(`{"Event":"SparkListenerStageCompleted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10,"Completion Time":${slowMs}}}`);
  lines.push(`{"Event":"SparkListenerApplicationEnd","Timestamp":${slowMs}}`);
  return `${lines.join('\n')}\n`;
}

// A log cut off before any task ended: no task records, no ApplicationEnd.
const CUT_OFF = [
  '{"Event":"SparkListenerApplicationStart","App ID":"application_0000000000000_0002","App Name":"t","Timestamp":0}',
  '{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10}}',
].join('\n');

let dir;
const p = (name) => join(dir, name);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sparkforensics-multi-'));
  writeFileSync(p('baseline'), log({ slowMs: 2000 }));
  writeFileSync(p('same'), log({ slowMs: 2000 }));
  writeFileSync(p('slower'), log({ slowMs: 4000 }));
  writeFileSync(p('cut-off'), `${CUT_OFF}\n`);
  writeFileSync(p('garbage'), 'this is not an event log\n');
  const withConf = log({ slowMs: 2000 }).split('\n');
  withConf.splice(1, 0, JSON.stringify({
    Event: 'SparkListenerEnvironmentUpdate',
    'Spark Properties': { 'spark.executor.memory': '2g', 'spark.sql.shuffle.partitions': '64', 'spark.custom.hidden': 'x' },
  }));
  writeFileSync(p('with-conf'), withConf.join('\n'));
  writeFileSync(p('fails-analysis'), log({ slowMs: 2000 }).replace('application_0000000000000_0001', FAILING_APP_ID));
});
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
      // Only the NDJSON mode writes one JSON document per line.
      get lines() { return stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)); },
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = previous;
  }
}

describe('several candidate logs', () => {
  it('writes one NDJSON line per candidate, in argument order, with the single-candidate content', async () => {
    const { status, lines } = await run([p('same'), p('slower'), '--baseline', p('baseline')]);
    expect(status).toBe(0);
    expect(lines.map((l) => l.log)).toEqual([p('same'), p('slower')]);
    for (const l of lines) {
      expect(l).toMatchObject({ status: 'pass', exitCode: 0, error: null, budgets: [] });
      expect(Object.keys(l.comparison)).toEqual([
        'verdict', 'confidence', 'reason', 'matchedCoverage', 'runtimeCoverage', 'metrics', 'findings',
        'comparisonSchemaVersion', 'stagePairs', 'unmatched', 'replanned', 'bookkeepingStageIds', 'executionAlignment',
      ]);
      expect(l.candidate.summary).toBeDefined();
    }
    const wall = (l) => l.comparison.metrics.find((m) => m.key === 'wallClock');
    expect(wall(lines[0]).delta).toBe(0);
    expect(wall(lines[1]).delta).toBe(2000);
  });

  it.each([[[]], [['--redact']]])('carries the single-candidate candidate object, metrics and effectiveConf included (%j)', async (extra) => {
    const flags = ['--baseline', p('baseline'), '--conf-keys', 'spark.executor.memory,spark.custom.hidden,spark.missing',
      '--conf-redact-regex', 'hidden', ...extra];
    const single = JSON.parse((await run([p('with-conf'), ...flags, '--format', 'json'])).stdout).candidate;
    const [line] = (await run([p('with-conf'), ...flags, '--format', 'ndjson'])).lines;
    expect(line.candidate).toEqual(single);
    expect(line.candidate.metrics.schemaVersion).toBeDefined();
    expect(line.candidate.effectiveConf).toMatchObject({
      values: { 'spark.executor.memory': '2g' },
      maskedKeys: ['spark.custom.hidden'],
      absentKeys: ['spark.missing'],
    });
  });

  it('gives each line its own status and exits with the worst: violation over inconclusive over pass', async () => {
    const { status, lines, stderr } = await run([
      p('same'), p('slower'), p('cut-off'), '--baseline', p('baseline'), '--regression-budget', 'executorRunTime:10',
    ]);
    expect(lines.map((l) => l.status)).toEqual(['pass', 'violation', 'inconclusive']);
    expect(lines[1].budgets).toEqual([expect.objectContaining({ name: 'max-regression', metric: 'executorRunTime', status: 'violation' })]);
    expect(stderr).toContain(`${p('slower')}: [violation] max-regression`);
    expect(status).toBe(1);
  });

  it('exits 3 when the worst line is inconclusive', async () => {
    const { status, lines } = await run([p('same'), p('cut-off'), '--baseline', p('baseline'), '--regression-budget', 'gcTime:10']);
    expect(lines.map((l) => l.status)).toEqual(['pass', 'inconclusive']);
    expect(status).toBe(3);
  });

  it('holds a regression budget on a metric a cut-off candidate cannot provide inconclusive', async () => {
    const { lines } = await run([p('cut-off'), '--baseline', p('baseline'), '--regression-budget', 'executorRunTime:10', '--format', 'ndjson']);
    const executorRunTime = lines[0].comparison.metrics.find((m) => m.key === 'executorRunTime');
    expect(executorRunTime).toMatchObject({ candidate: null, delta: null, direction: 'unavailable' });
    expect(lines[0].budgets).toContainEqual(expect.objectContaining({ name: 'max-regression', metric: 'executorRunTime', status: 'inconclusive' }));
    expect(lines[0].status).toBe('inconclusive');
  });

  it('turns a candidate that cannot be read or parsed into an exit-4 error line, and keeps going', async () => {
    const { status, lines } = await run([p('garbage'), p('same'), p('nope'), '--baseline', p('baseline')]);
    expect(lines.map((l) => l.status)).toEqual(['error', 'pass', 'error']);
    for (const [i, name] of [[0, 'garbage'], [2, 'nope']]) {
      expect(lines[i]).toMatchObject({ log: p(name), exitCode: 4, candidate: null, comparison: null, budgets: [] });
      expect(lines[i].error).toEqual(expect.any(String));
    }
    expect(status).toBe(4);
  });

  it('ranks the aggregate exit code 4 over 1 over 3 over 0', async () => {
    const budget = ['--baseline', p('baseline'), '--regression-budget', 'wallClock:10'];
    const cases = [
      [[p('slower'), p('garbage'), p('cut-off'), p('same')], [1, 4, 3, 0], 4],
      [[p('same'), p('cut-off'), p('slower')], [0, 3, 1], 1],
      [[p('same'), p('cut-off')], [0, 3], 3],
      [[p('same'), p('same')], [0, 0], 0],
    ];
    for (const [logs, lineCodes, aggregate] of cases) {
      const { status, lines } = await run([...logs, ...budget]);
      expect(lines.map((l) => l.exitCode)).toEqual(lineCodes);
      expect(status).toBe(aggregate);
    }
  });

  it('turns an internal failure on one candidate into an exit-6 error line, and keeps going', async () => {
    const { status, lines } = await run([p('fails-analysis'), p('same'), '--baseline', p('baseline')]);
    expect(lines.map((l) => [l.status, l.exitCode])).toEqual([['error', 6], ['pass', 0]]);
    expect(lines[0]).toMatchObject({ log: p('fails-analysis'), candidate: null, comparison: null, budgets: [] });
    expect(status).toBe(6);
  });

  it('writes a generic message for an internal failure under --redact', async () => {
    const { status, stdout, stderr, lines } = await run([p('fails-analysis'), p('same'), '--baseline', p('baseline'), '--redact']);
    expect(lines[0]).toMatchObject({ log: 'candidate-1', status: 'error', exitCode: 6, error: 'Candidate 1 could not be analyzed.' });
    expect(stdout + stderr).not.toContain(dir);
    expect(status).toBe(6);
  });

  it('exits 6 when the output cannot be written', async () => {
    const { status, stderr } = await run([p('same'), p('slower'), '--baseline', p('baseline'), '--out', p('no-such-dir/out.ndjson')]);
    expect(status).toBe(6);
    expect(stderr).toMatch(/^Internal error/);
  });

  it('names candidates by position and writes no candidate path under --redact', async () => {
    const out = p('redacted.ndjson');
    const { status, stderr } = await run([
      p('slower'), p('nope'), '--baseline', p('baseline'), '--regression-budget', 'wallClock:10', '--redact', '--out', out,
    ]);
    const written = readFileSync(out, 'utf8');
    const lines = written.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.log, l.status])).toEqual([['candidate-1', 'violation'], ['candidate-2', 'error']]);
    expect(lines[1].error).toBe('Candidate 2 could not be read or parsed.');
    expect(stderr).toContain('candidate-1: [violation] max-regression');
    expect(stderr).toContain('candidate-2: [error]');
    for (const text of [written, stderr]) {
      expect(text).not.toContain(dir);
      expect(text).not.toContain('nope');
    }
    expect(status).toBe(4);
  });

  it.each(['missing', 'garbage'])('exits 5 without output when the baseline (%s) cannot be read or parsed', async (name) => {
    const { status, stdout } = await run([p('same'), p('slower'), '--baseline', p(name)]);
    expect(status).toBe(5);
    expect(stdout).toBe('');
  });

  it('names the baseline, not its path, when it cannot be read under --redact', async () => {
    const { status, stdout, stderr } = await run([p('same'), p('slower'), '--baseline', p('missing'), '--redact']);
    expect(status).toBe(5);
    expect(stdout).toBe('');
    expect(stderr).toBe('The baseline could not be read or parsed.\n');
  });

  it('exits 5, not 4, when both the baseline and a candidate are unreadable', async () => {
    const { status, stdout } = await run([p('garbage'), p('same'), '--baseline', p('missing')]);
    expect(status).toBe(5);
    expect(stdout).toBe('');
  });

  it('writes the lines to --out', async () => {
    const out = p('lines.ndjson');
    const { status, stdout } = await run([p('same'), p('slower'), '--baseline', p('baseline'), '--out', out]);
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('supports --format ndjson with one candidate', async () => {
    const { status, lines } = await run([p('same'), '--baseline', p('baseline'), '--format', 'ndjson']);
    expect(status).toBe(0);
    expect(lines).toHaveLength(1);
  });

  it.each([
    [['a', 'b']],
    [['a', 'b', '--baseline', 'x', '--format', 'json']],
    [['a', 'b', '--baseline', 'x', '--format', 'md']],
    [['a', 'b', '--baseline', 'x', '--export-html', 'out']],
    [['a', '--format', 'ndjson']],
  ])('exits 2 on the unsupported combination %j', async (argv) => {
    const { status, stdout } = await run(argv);
    expect(status).toBe(2);
    expect(stdout).toBe('');
  });

  it('exits 2 when --format ndjson is combined with --shs-base-url', async () => {
    const { status, stdout, stderr } = await run([
      '--shs-base-url', 'http://h', '--app-id', 'application_0000000000000_0001', '--baseline', 'x', '--format', 'ndjson',
    ]);
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^--format ndjson requires --baseline and a local candidate log\./);
  });
});

describe('several regression budgets', () => {
  const base = () => [p('slower'), '--baseline', p('baseline')];

  it('checks every budget and reports its metric', async () => {
    const { status, lines } = await run([...base(), '--regression-budget', 'wallClock:150', '--regression-budget', 'executorRunTime:10', '--format', 'ndjson']);
    expect(lines[0].budgets).toEqual([
      expect.objectContaining({ metric: 'wallClock', status: 'pass' }),
      expect.objectContaining({ metric: 'executorRunTime', status: 'violation' }),
    ]);
    expect(status).toBe(1);
  });

  it('counts the legacy pair as one more budget', async () => {
    const { lines } = await run([...base(), '--max-regression-pct', '150', '--regression-budget', 'executorRunTime:10', '--format', 'ndjson']);
    expect(lines[0].budgets.map((b) => [b.metric, b.status])).toEqual([['wallClock', 'pass'], ['executorRunTime', 'violation']]);
  });

  it('reads --budgets from a file', async () => {
    const file = p('budgets.json');
    writeFileSync(file, JSON.stringify({ regression: { wallClock: 150, gcTime: 10 } }));
    const { status, lines } = await run([...base(), '--budgets', file, '--format', 'ndjson']);
    expect(lines[0].budgets.map((b) => [b.metric, b.status])).toEqual([['wallClock', 'pass'], ['gcTime', 'violation']]);
    expect(status).toBe(1);
  });

  it('still runs the single-candidate format with the new flags', async () => {
    const { status, stderr } = await run([...base(), '--regression-budget', 'wallClock:10']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/\[violation\] max-regression: Metric "wallClock"/);
  });

  it.each([
    ['unknown metric', ['--regression-budget', 'wallclock:10']],
    ['no percentage', ['--regression-budget', 'wallClock']],
    ['empty percentage', ['--regression-budget', 'wallClock:']],
    ['negative percentage', ['--regression-budget', 'wallClock:-5']],
    ['non-numeric percentage', ['--regression-budget', 'wallClock:ten']],
    ['metric given twice', ['--regression-budget', 'wallClock:10', '--regression-budget', 'wallClock:20']],
    ['metric in the legacy pair and a flag', ['--max-regression-pct', '10', '--regression-budget', 'wallClock:20']],
    ['legacy pair metric repeated', ['--max-regression-pct', '10', '--regression-metric', 'gcTime', '--regression-budget', 'gcTime:20']],
    ['unreadable budgets file', ['--budgets', '/nonexistent/budgets.json']],
  ])('exits 2 on %s', async (_name, extra) => {
    const { status, stdout, stderr } = await run([...base(), ...extra]);
    expect(status).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^Usage:/m);
  });

  it.each([
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['an unknown top-level key', '{"regression":{},"max":{}}'],
    ['a missing regression object', '{}'],
    ['an unknown metric', '{"regression":{"nope":10}}'],
    ['a string percentage', '{"regression":{"wallClock":"10"}}'],
    ['a negative percentage', '{"regression":{"wallClock":-1}}'],
    ['a metric also given by a flag', '{"regression":{"wallClock":10}}', ['--regression-budget', 'wallClock:5']],
  ])('exits 2 on a budgets file with %s', async (_name, content, extra = []) => {
    const file = p('bad-budgets.json');
    writeFileSync(file, content);
    const { status } = await run([...base(), '--budgets', file, ...extra]);
    expect(status).toBe(2);
  });

  it.each(['--regression-budget', '--budgets'])('exits 2 when %s is given without --baseline', async (flag) => {
    const { status, stderr } = await run([p('same'), flag, flag === '--budgets' ? p('budgets.json') : 'wallClock:10']);
    expect(status).toBe(2);
    expect(stderr).toMatch(/require --baseline/);
  });
});

describe('single-candidate exit codes for unreadable input', () => {
  it('exits 4 for an unreadable candidate and 5 for an unreadable baseline', async () => {
    expect((await run([p('garbage'), '--baseline', p('baseline')])).status).toBe(4);
    expect((await run([p('missing'), '--baseline', p('baseline')])).status).toBe(4);
    expect((await run([p('same'), '--baseline', p('garbage')])).status).toBe(5);
    expect((await run([p('same'), '--baseline', p('missing')])).status).toBe(5);
  });

  it.each([
    [['missing', '--baseline', 'baseline'], 4, 'The candidate could not be read or parsed.\n'],
    [['same', '--baseline', 'missing'], 5, 'The baseline could not be read or parsed.\n'],
  ])('names the role, not the path, of an unreadable log under --redact (%j)', async (argv, code, message) => {
    const { status, stdout, stderr } = await run([...argv.map((a) => (a.startsWith('--') ? a : p(a))), '--redact']);
    expect(status).toBe(code);
    expect(stdout).toBe('');
    expect(stderr).toBe(message);
  });

  it('names the role, not the URL, of a failed --shs-base-url fetch under --redact', async () => {
    const shs = ['--shs-base-url', 'http://shs:18080', '--app-id', 'application_0000000000000_0001', '--redact'];
    const { status, stderr } = await run(shs, { fetchImpl: shsZipFetch('', { status: 500 }) });
    expect(status).toBe(4);
    expect(stderr).toBe('The candidate could not be read or parsed.\n');
  });

  it('exits 5 when both are unreadable, the worse of the two', async () => {
    expect((await run([p('garbage'), '--baseline', p('missing')])).status).toBe(5);
  });

  it('exits 6 on an internal failure such as an unwritable --out', async () => {
    const { status, stderr } = await run([p('same'), '--out', p('no-such-dir/report.json')]);
    expect(status).toBe(6);
    expect(stderr).toMatch(/^Internal error/);
  });

  it('exits 4 when the --shs-base-url fetch fails', async () => {
    const shs = ['--shs-base-url', 'http://shs:18080', '--app-id', 'application_0000000000000_0001'];
    const fetchImpl = shsZipFetch('', { status: 500 });
    expect((await run(shs, { fetchImpl })).status).toBe(4);
    expect((await run([...shs, '--baseline', p('baseline')], { fetchImpl })).status).toBe(4);
  });

  it('exits 5, not 4, when the --shs-base-url fetch and the --baseline both fail', async () => {
    const shs = ['--shs-base-url', 'http://shs:18080', '--app-id', 'application_0000000000000_0001'];
    const fetchImpl = shsZipFetch('', { status: 500 });
    expect((await run([...shs, '--baseline', p('garbage')], { fetchImpl })).status).toBe(5);
    expect((await run([...shs, '--baseline', p('missing')], { fetchImpl })).status).toBe(5);
  });

  it.each([
    ['a non-HTTP --shs-base-url', ['--shs-base-url', 'ftp://shs', '--app-id', 'application_0000000000000_0001']],
    ['a --shs-base-url with a query', ['--shs-base-url', 'http://shs?x=1', '--app-id', 'application_0000000000000_0001']],
    ['an unsupported --app-id', ['--shs-base-url', 'http://shs:18080', '--app-id', 'myapp']],
    ['a path-unsafe --attempt-id', ['--shs-base-url', 'http://shs:18080', '--app-id', 'application_0000000000000_0001', '--attempt-id', '../x']],
  ])('exits 2 before any fetch for %s, even with an unreadable --baseline', async (_, shs) => {
    const fetchImpl = vi.fn(shsZipFetch(log({ slowMs: 2000 })));
    expect((await run(shs, { fetchImpl })).status).toBe(2);
    expect((await run([...shs, '--baseline', p('garbage')], { fetchImpl })).status).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps exit 2 for usage errors and a bad budgets file', async () => {
    expect((await run([p('same'), '--max-skew', 'x'])).status).toBe(2);
    expect((await run([p('same'), '--baseline', p('baseline'), '--budgets', p('missing-budgets.json')])).status).toBe(2);
  });
});
