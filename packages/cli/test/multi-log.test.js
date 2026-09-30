import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/sparkforensics-analyze.mjs';

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
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(argv) {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await main(argv);
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
      expect(Object.keys(l.comparison)).toEqual(['verdict', 'confidence', 'reason', 'matchedCoverage', 'metrics', 'findings']);
      expect(l.candidate.summary).toBeDefined();
    }
    const wall = (l) => l.comparison.metrics.find((m) => m.key === 'wallClock');
    expect(wall(lines[0]).delta).toBe(0);
    expect(wall(lines[1]).delta).toBe(2000);
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

  it('reports a metric a cut-off candidate log cannot provide as null, never 0', async () => {
    const { lines } = await run([p('cut-off'), p('same'), '--baseline', p('baseline')]);
    const metrics = Object.fromEntries(lines[0].comparison.metrics.map((m) => [m.key, m]));
    for (const key of ['executorRunTime', 'gcTime', 'shuffleSpill', 'diskSpill']) {
      expect(metrics[key]).toMatchObject({ candidate: null, delta: null, direction: 'unavailable' });
    }
    // The baseline's own figures survive, so null marks the candidate's gap only.
    expect(metrics.executorRunTime.baseline).toBeGreaterThan(0);
  });

  it('turns a candidate that cannot be parsed into an error line counted as inconclusive, and keeps going', async () => {
    const { status, lines } = await run([p('garbage'), p('same'), p('nope'), '--baseline', p('baseline')]);
    expect(lines.map((l) => l.status)).toEqual(['error', 'pass', 'error']);
    expect(lines[0]).toMatchObject({ log: p('garbage'), exitCode: 3, candidate: null, comparison: null, budgets: [] });
    expect(lines[0].error).toEqual(expect.any(String));
    expect(status).toBe(3);
  });

  it('lets a violation outrank an error line', async () => {
    const { status } = await run([p('garbage'), p('slower'), '--baseline', p('baseline'), '--regression-budget', 'wallClock:10']);
    expect(status).toBe(1);
  });

  it('exits 2 without output when the baseline cannot be read', async () => {
    const { status, stdout } = await run([p('same'), p('slower'), '--baseline', p('missing')]);
    expect(status).toBe(2);
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
    [['--shs-base-url', 'http://h', '--app-id', 'x', '--baseline', 'x', '--format', 'ndjson']],
  ])('exits 2 on the unsupported combination %j', async (argv) => {
    const { status, stdout } = await run(argv);
    expect(status).toBe(2);
    expect(stdout).toBe('');
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
