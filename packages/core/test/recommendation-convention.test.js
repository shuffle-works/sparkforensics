import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyze, auditConfig } from '../src/analyzer.js';
import { collectRun } from '../src/cli/collect-run.js';
import { recommendationParts } from '../src/finding-names.js';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

// Every detector recommendation reads "<measurement>: <fix>". recommendationParts splits it at
// the last ": " and the UI shows the two halves in different places, so a recommendation that
// breaks the convention puts the wrong text under "What to try". These tests run the real
// detectors and check the text they emit: over the local log corpus when it is present, and over
// synthetic runs that trip the wordings the corpus may not.

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Finding types whose wording has no measurement to split off, and why.
const NO_MEASUREMENT = {
  stageFailed: 'the stage failure itself is the whole finding: there is no figure to quote, only where to look',
};

const executors = (n) => Array.from({ length: n }, (_, i) => ({ executorId: String(i), timestamp: 0, totalCores: 4 }));
const failedJob = (id) => ({ id, result: 'JobFailed', succeeded: false, stageIds: [1], submissionTime: 0, completionTime: 1000 });

// One analyze() call per case: detectors gate on each other and on runtime floors, so a case
// carries only the stage that should trip its detector.
const SYNTHETIC_RUNS = [
  { stage: { taskDurationP50: 100, taskDurationP95: 600 } },
  { stage: { taskCount: 10, taskDurationP50: 100, taskDurationP95: 100, taskDurationMax: 400 } },
  { stage: { shuffleReadBytes: 2 * GB, fetchWaitTime: 100000 } },
  { stage: { taskCount: 4, shuffleReadBytes: 8 * GB } },
  { stage: { inputBytes: GB, outputBytes: 50 * GB } },
  { stage: { taskCount: 3, executorRunTime: 100000, taskDurationP50: 1000, taskDurationMax: 2000 } },
  { stage: { memoryBytesSpilled: 5 * GB, diskBytesSpilled: 2 * GB, spillClassification: 'skew', spillMemP50: MB, spillMemMax: GB, spillDiskP50: MB, spillDiskMax: GB } },
  { stage: { memoryBytesSpilled: 5 * GB, diskBytesSpilled: 2 * GB, spillClassification: 'shuffle' } },
  { stage: { memoryBytesSpilled: 5 * GB, diskBytesSpilled: 2 * GB, spillClassification: 'unclassified' } },
  { stage: { jvmGCTime: 5000, executorRunTime: 10000, gcPct: 50 } },
  { stage: { failedTasks: 30, failureReasons: [{ reason: 'boom: x', count: 30 }] } },
  { stage: { stageFailureReason: 'Job aborted due to stage failure' } },
  { stage: { taskCount: 2000, taskDurationP50: 5, taskDurationP95: 8, taskDurationMax: 10 } },
  { stage: { submittedAt: 0, completedAt: 3600000 } },
  { stage: { speculativeTasks: 20, speculationWastedAttempts: 20, speculationWasteMs: 100000 } },
  { stage: { wastedAttempts: 10, retryWasteMs: 100000 } },
  { stage: { stragglerCount: 5, taskDurationMax: 4000, taskDurationP95: 200 } },
  { app: { endTime: undefined } },
  { app: { endTime: 100000 }, stage: { completedAt: 1000, executorRunTime: 1000 }, added: executors(10) },
  { jobs: [failedJob(0), failedJob(1)] },
];

const CONFIG_APPS = [
  { config: {}, resources: { dynamicAllocationEnabled: true } },
  { config: { a: '1' }, resources: { serializer: 'org.apache.spark.serializer.JavaSerializer' } },
  { config: { a: '1' }, resources: { executor: { memoryMB: 8192, memoryOverheadMB: 100 } } },
];

function syntheticFindings() {
  const analyzed = SYNTHETIC_RUNS.flatMap(({ app, stage, added = [], jobs = [] }) => {
    const stages = new Map([[1, makeStage(stage)]]);
    const jobMap = new Map(jobs.map((j) => [j.id, j]));
    return analyze(makeApp(app), stages, added, [], jobMap);
  });
  return [...analyzed, ...CONFIG_APPS.flatMap((app) => auditConfig(makeApp(app), new Map([[1, makeStage()]])))];
}

// The local log corpus is gitignored: the suite skips it on a checkout without logs.
const CORPUS_DIR = fileURLToPath(new URL('../../../dev/log-corpus/logs', import.meta.url));
const corpusFiles = existsSync(CORPUS_DIR)
  ? readdirSync(CORPUS_DIR).filter((n) => n.endsWith('.ndjson')).map((n) => `${CORPUS_DIR}/${n}`).filter((p) => statSync(p).isFile())
  : [];

function expectConvention(findings) {
  const broken = [];
  for (const f of findings) {
    if (typeof f.recommendation !== 'string' || !f.recommendation) continue;
    const { measured, fix } = recommendationParts(f.recommendation);
    if (f.type in NO_MEASUREMENT) {
      if (measured !== null) broken.push(`${f.type}: allowlisted but has a measurement: ${f.recommendation}`);
    } else if (!measured || !fix) {
      broken.push(`${f.type}: ${f.recommendation}`);
    }
  }
  expect(broken).toEqual([]);
}

describe('detector recommendations follow "<measurement>: <fix>"', () => {
  it('holds for every recommendation the synthetic runs emit', () => {
    const findings = syntheticFindings();
    const types = new Set(findings.filter((f) => f.recommendation).map((f) => f.type));
    // Guards the scenarios themselves: a threshold change that stops one tripping must fail here.
    for (const type of [
      'skew', 'shuffle', 'partitionSizing', 'stageShape', 'spill', 'gc', 'failures', 'stageFailed', 'tinyTask',
      'stageSlowness', 'speculationWaste', 'straggler', 'retryWaste', 'incompleteRun', 'utilization', 'configAudit',
      'jobFailureRate',
    ]) expect(types, `no synthetic run emitted a ${type} recommendation`).toContain(type);
    expectConvention(findings);
  });

  it('keeps every allowlist entry pointing at a finding that is actually emitted', () => {
    const emitted = new Set(syntheticFindings().map((f) => f.type));
    for (const type of Object.keys(NO_MEASUREMENT)) expect(emitted).toContain(type);
  });

  it.skipIf(corpusFiles.length === 0).each(corpusFiles.map((p) => [p]))('holds for the corpus log %s', async (path) => {
    const { appModel: m } = await collectRun(path);
    expectConvention(analyze(m.app, m.stages, m.executors.added, m.executors.removed, m.jobs, m.sql, m.runAggregates));
  });
});

