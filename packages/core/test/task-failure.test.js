import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  buildStackExcerpt, describeTaskFailure, extractTaskFailureDetail, formatTaskFailureHeadline,
  redactTaskFailureGroup, taskFailureKey, REDACTED_TEXT,
} from '../src/task-failure.ts';
import { collectRun } from '../src/cli/collect-run.js';

const frames = (n) => Array.from({ length: n }, (_, i) => `\tat com.example.Step${i}.run(Step${i}.scala:${i + 1})`);

describe('extractTaskFailureDetail', () => {
  it('reads class, message and stack trace from an ExceptionFailure', () => {
    const d = extractTaskFailureDetail({
      Reason: 'ExceptionFailure', 'Class Name': 'java.io.FileNotFoundException', Description: '/data/in/part-0001 (No such file)',
      'Full Stack Trace': ['java.io.FileNotFoundException: /data/in/part-0001 (No such file)', ...frames(2)].join('\n'),
    });
    expect(d).toEqual({
      reason: 'ExceptionFailure', className: 'java.io.FileNotFoundException', message: '/data/in/part-0001 (No such file)',
      lossReason: null, stackExcerpt: ['java.io.FileNotFoundException: /data/in/part-0001 (No such file)', ...frames(2)].join('\n'),
    });
  });

  it('reads the loss reason from an ExecutorLostFailure', () => {
    const d = extractTaskFailureDetail({ Reason: 'ExecutorLostFailure', 'Loss Reason': 'Container killed by YARN for exceeding memory limits.' });
    expect(d.lossReason).toBe('Container killed by YARN for exceeding memory limits.');
    expect(describeTaskFailure(d)).toBe('ExecutorLostFailure: Container killed by YARN for exceeding memory limits.');
  });

  it('uses a FetchFailed message as both the message (first line) and the stack source', () => {
    const d = extractTaskFailureDetail({ Reason: 'FetchFailed', Message: ['org.apache.spark.shuffle.FetchFailedException: Failed to connect', ...frames(1)].join('\n') });
    expect(d.message).toBe('org.apache.spark.shuffle.FetchFailedException: Failed to connect');
    expect(d.stackExcerpt).toContain('Step0');
  });

  it('reads a TaskKilled kill reason as the message', () => {
    expect(extractTaskFailureDetail({ Reason: 'TaskKilled', 'Kill Reason': 'another attempt succeeded' }).message).toBe('another attempt succeeded');
  });

  it('names a PySpark failure by its Python error line, so distinct Python errors get distinct keys', () => {
    const pyFrames = Array.from({ length: 6 }, (_, i) => [`  File "/jobs/etl.py", line ${i + 1}, in step${i}`, `    step${i + 1}(row)`]).flat();
    const pythonFailure = (error) => {
      const traceback = ['Traceback (most recent call last):', ...pyFrames, error].join('\n');
      return {
        Reason: 'ExceptionFailure', 'Class Name': 'org.apache.spark.api.python.PythonException', Description: traceback,
        'Full Stack Trace': [`org.apache.spark.api.python.PythonException: ${traceback}`, '', ...frames(3)].join('\n'),
      };
    };
    const valueError = extractTaskFailureDetail(pythonFailure('ValueError: bad row'));
    const keyError = extractTaskFailureDetail(pythonFailure(`KeyError: '${'k'.repeat(400)}'`));
    expect(valueError.message).toBe('ValueError: bad row');
    expect(keyError.message.length).toBe(300);
    expect(taskFailureKey(valueError)).not.toBe(taskFailureKey(keyError));
    expect(formatTaskFailureHeadline(valueError)).toBe('org.apache.spark.api.python.PythonException: ValueError: bad row');
    const excerpt = valueError.stackExcerpt.split('\n');
    expect(excerpt.slice(9)).toEqual(['\t...', 'ValueError: bad row', '\t...']);
    expect(redactTaskFailureGroup({ ...valueError, count: 1 })).toMatchObject({ message: REDACTED_TEXT });
    expect(redactTaskFailureGroup({ ...valueError, count: 1 }).stackExcerpt).not.toContain('bad row');
  });

  it('reads the Python error line after the newer Python-worker preamble', () => {
    const d = extractTaskFailureDetail({
      Reason: 'ExceptionFailure', 'Class Name': 'org.apache.spark.api.python.PythonException',
      Description: ['An exception was thrown from the Python worker. Please see the stack trace below.', 'Traceback (most recent call last):',
        '  File "/jobs/etl.py", line 3, in parse', '    int(row)', 'ValueError: invalid literal', ''].join('\n'),
    });
    expect(d.message).toBe('ValueError: invalid literal');
  });

  it('returns null without an end reason and bounds a long message', () => {
    expect(extractTaskFailureDetail(undefined)).toBeNull();
    const d = extractTaskFailureDetail({ Reason: 'ExceptionFailure', Description: 'x'.repeat(5000) });
    expect(d.message.length).toBe(300);
    expect(d.message.endsWith('...')).toBe(true);
  });
});

describe('buildStackExcerpt', () => {
  it('keeps the header and 8 frames, then the last Caused by line and its first frame', () => {
    const trace = ['java.lang.RuntimeException: outer', ...frames(20), 'Caused by: java.io.IOException: first', ...frames(3),
      'Caused by: java.lang.OutOfMemoryError: root', '\tat com.example.Root.alloc(Root.scala:5)', ...frames(2)].join('\n');
    const lines = buildStackExcerpt(trace).split('\n');
    expect(lines.slice(0, 9)).toEqual(['java.lang.RuntimeException: outer', ...frames(8)]);
    expect(lines.slice(9)).toEqual(['\t...', 'Caused by: java.lang.OutOfMemoryError: root', '\tat com.example.Root.alloc(Root.scala:5)']);
  });

  it('stays bounded however long the trace lines are', () => {
    const trace = Array.from({ length: 100 }, () => `\tat ${'a'.repeat(5000)}`).join('\n');
    const excerpt = buildStackExcerpt(trace);
    expect(excerpt.length).toBeLessThanOrEqual(2000);
    expect(excerpt.split('\n').every((l) => l.length <= 300)).toBe(true);
  });
});

describe('taskFailureKey / formatTaskFailureHeadline', () => {
  it('ignores the excerpt, so two traces of one error share a key', () => {
    const a = { reason: 'ExceptionFailure', className: 'X', message: 'm', lossReason: null, stackExcerpt: 'one' };
    expect(taskFailureKey(a)).toBe(taskFailureKey({ ...a, stackExcerpt: 'two' }));
    expect(taskFailureKey(a)).not.toBe(taskFailureKey({ ...a, message: 'other' }));
  });

  it('names the class and message, or the tag and loss reason', () => {
    expect(formatTaskFailureHeadline({ reason: 'ExceptionFailure', className: 'java.lang.X', message: 'boom', lossReason: null })).toBe('java.lang.X: boom');
    expect(formatTaskFailureHeadline({ reason: 'ExecutorLostFailure', className: null, message: null, lossReason: 'Heartbeat timed out' }))
      .toBe('ExecutorLostFailure: Heartbeat timed out');
    expect(formatTaskFailureHeadline({ reason: null, className: null, message: null, lossReason: null })).toBe('Unknown failure');
  });
});

describe('redactTaskFailureGroup', () => {
  it('drops the message and every message line of the excerpt, keeping class names and frames', () => {
    const group = {
      reason: 'ExceptionFailure', className: 'org.apache.spark.api.python.PythonException', count: 2, lossReason: 'Container killed on host ip-10-1-2-3',
      message: 'Traceback (most recent call last):',
      stackExcerpt: [
        'org.apache.spark.api.python.PythonException: Traceback (most recent call last):',
        '  File "/home/alice/jobs/etl.py", line 12, in parse',
        'ValueError: invalid literal for int(): \'4111-1111\'',
        '\tat org.apache.spark.api.python.BasePythonRunner.read(PythonRunner.scala:1)',
        '\t...',
        'Caused by: java.io.FileNotFoundException: /secret/path/part-0001',
      ].join('\n'),
    };
    const out = redactTaskFailureGroup(group);
    expect(out.message).toBe(REDACTED_TEXT);
    expect(out.stackExcerpt).toBe([
      'org.apache.spark.api.python.PythonException',
      '\tat org.apache.spark.api.python.BasePythonRunner.read(PythonRunner.scala:1)',
      '\t...',
      'Caused by: java.io.FileNotFoundException',
    ].join('\n'));
    expect(out).toMatchObject({ className: group.className, count: 2, lossReason: group.lossReason });
    expect(group.message).toBe('Traceback (most recent call last):'); // input untouched
  });

  it('leaves absent fields null', () => {
    const out = redactTaskFailureGroup({ reason: 'FetchFailed', className: null, message: null, lossReason: null, stackExcerpt: null });
    expect(out.message).toBeNull();
    expect(out.stackExcerpt).toBeNull();
  });
});

// dev/log-corpus is a git submodule: CI doesn't fetch submodules, so these skip there.
// Locally: `git submodule update --init dev/log-corpus`.
const EXTERNAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dev', 'log-corpus', 'logs', 'external');

function failedEndReasons(file) {
  return readFileSync(join(EXTERNAL_DIR, file), 'utf8').split('\n')
    .filter((l) => l.includes('"SparkListenerTaskEnd"'))
    .map((l) => JSON.parse(l)['Task End Reason'])
    .filter((r) => r && r.Reason && r.Reason !== 'Success');
}

describe('task failure details on public corpus logs', () => {
  const files = existsSync(EXTERNAL_DIR) ? readdirSync(EXTERNAL_DIR).filter((f) => f.endsWith('.ndjson')) : [];

  it.skipIf(files.length === 0)('names the error behind every failed attempt that carries one, with a bounded excerpt', () => {
    const withFailures = files.filter((f) => failedEndReasons(f).length > 0);
    expect(withFailures.length).toBeGreaterThanOrEqual(7);
    for (const file of withFailures) {
      for (const raw of failedEndReasons(file)) {
        const d = extractTaskFailureDetail(raw);
        expect(d.reason, file).toBe(raw.Reason);
        if (raw['Class Name']) {
          expect(d.className, file).toBe(raw['Class Name']);
          expect(d.stackExcerpt.startsWith(raw['Class Name']), file).toBe(true);
          expect(d.stackExcerpt.length, file).toBeLessThanOrEqual(2000);
          expect(formatTaskFailureHeadline(d), file).toContain(raw.Description);
        }
        if (raw['Kill Reason']) expect(d.message, file).toBe(raw['Kill Reason']);
      }
    }
  });

  it.skipIf(files.length === 0)('groups the surviving failed task of external-local-1422981780767 under its exception', async () => {
    const { appModel } = await collectRun(join(EXTERNAL_DIR, 'external-local-1422981780767.ndjson'));
    const stage = [...appModel.stages.values()].find((s) => s.failedTasks > 0);
    expect(stage.failureGroups).toHaveLength(1);
    expect(stage.failureGroups[0]).toMatchObject({
      reason: 'ExceptionFailure', className: 'java.lang.RuntimeException', message: 'got a 3, failing', count: 1,
    });
    expect(stage.failureGroups[0].stackExcerpt.split('\n')[0]).toBe('java.lang.RuntimeException: got a 3, failing');
  });
});
