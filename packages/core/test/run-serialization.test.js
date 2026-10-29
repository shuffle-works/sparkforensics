import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRun } from '../src/analyzed-run.ts';
import { collectRun } from '../src/cli/collect-run.ts';
import { redactRun } from '../src/redact.ts';
import { deserializeRun, FIELDS, serializeRun } from '../src/run-serialization.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LOGS = [FIXTURES, join(FIXTURES, 'synthetic')]
  .flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith('.ndjson')).sort().map((name) => join(dir, name)));
const nameOf = (path) => path.slice(FIXTURES.length + 1);

const analyzed = async (path) => analyzeRun((await collectRun(path)).appModel);

// The run's own fields and its model's fields that `FIELDS` has no entry for.
function unserializedFields(run) {
  const known = new Set(Object.values(FIELDS).map(({ from }) => from));
  return [
    ...Object.keys(run).filter((key) => key !== 'appModel'),
    ...Object.keys(run.appModel).map((key) => `appModel.${key}`),
  ].filter((path) => !known.has(path));
}

describe('serializeRun and deserializeRun', () => {
  it.each(LOGS.map((path) => [nameOf(path), path]))('round-trip a run of %s', async (_name, path) => {
    const run = await analyzed(path);

    expect(deserializeRun(serializeRun(run))).toEqual(run);
  });

  it('round-trip the task data a snapshot source holds', async () => {
    const run = await analyzed(LOGS[0]);
    const stages = new Map([[1, { metrics: new Float64Array([1, 2]), fieldNames: ['duration'] }]]);
    const withTaskData = { ...run, taskData: { kind: 'snapshot', stages } };

    expect(deserializeRun(serializeRun(withTaskData))).toEqual(withTaskData);
  });

  it('carry what a worker-backed run fetched so far, since the worker itself is not data', async () => {
    const run = { ...(await analyzed(LOGS[0])), taskData: { kind: 'worker', request: () => Promise.reject(new Error('no worker')) } };
    const fetched = new Map([[2, { metrics: new Float64Array([3]), fieldNames: ['duration'] }]]);

    expect(deserializeRun(serializeRun(run, fetched)).taskData).toEqual({ kind: 'snapshot', stages: fetched });
    expect(deserializeRun(serializeRun(run)).taskData).toEqual({ kind: 'none' });
  });

  it('write every key FIELDS lists, and nothing else', async () => {
    const serialized = serializeRun(await analyzed(LOGS[0]));

    expect(Object.keys(serialized).sort()).toEqual(Object.keys(FIELDS).sort());
  });
});

describe('the serializer covers the whole run', () => {
  it('leaves out no field of a run or its model', async () => {
    for (const path of LOGS) expect(unserializedFields(await analyzed(path)), nameOf(path)).toEqual([]);
  });

  it('names a field added to the run or its model that no table entry carries', async () => {
    const run = await analyzed(LOGS[0]);
    const grown = { ...run, lineage: [], appModel: { ...run.appModel, parseWarnings: [] } };

    expect(unserializedFields(grown).sort()).toEqual(['appModel.parseWarnings', 'lineage']);
  });
});

describe('redactRun', () => {
  it('follows the policy of every serialized field', async () => {
    const run = await analyzed(LOGS[0]);
    const withHost = { ...run, appModel: { ...run.appModel, unreadableSqlExecutions: [3], skippedLines: 2 } };
    const redacted = serializeRun(redactRun(withHost));
    const original = serializeRun(withHost);

    for (const [field, { redaction }] of Object.entries(FIELDS)) {
      if (redaction === 'keep') expect(redacted[field], field).toEqual(original[field]);
    }
    expect(redacted.taskData).toBeNull();
    expect(Object.keys(redacted).sort()).toEqual(Object.keys(FIELDS).sort());
  });

  it('derives the interpretation from the redacted findings', async () => {
    const run = await analyzed(LOGS[0]);
    const redacted = redactRun(run);
    const ids = new Set([...redacted.catalog, ...redacted.configFindings].map((finding) => finding.id));

    expect(redacted.interpretation.verdict.steps.every((step) => ids.has(step.leadId))).toBe(true);
    expect(Object.keys(redacted.interpretation.savings).every((id) => ids.has(id))).toBe(true);
  });
});
