// Shared stage/app fixture factories for analyzer.test.js, analyzer-finding-identity.test.js,
// evidence-report.test.js, and detectors-plan.test.js.
export function makeStage(overrides = {}) {
  return {
    id: 1, name: 'test', submittedAt: 0, completedAt: 1000,
    taskCount: 100, failedTasks: 0,
    shuffleReadBytes: 0, shuffleWriteBytes: 0, fetchWaitTime: 0,
    memoryBytesSpilled: 0, diskBytesSpilled: 0,
    jvmGCTime: 0, executorRunTime: 10000,
    inputBytes: 0, outputBytes: 0,
    sqlExecutionId: null,
    taskDurationP50: 100, taskDurationP95: 100, taskDurationMax: 100,
    gcPct: 0,
    spillClassification: 'unclassified',
    parentIds: [], hostStats: [], executorStats: [], speculativeTasks: 0,
    failureReasons: [], stragglerCount: 0,
    wastedAttempts: 0, retryWasteMs: 0,
    speculationWastedAttempts: 0, speculationWasteMs: 0,
    spillMemP50: 0, spillMemMax: 0, spillDiskP50: 0, spillDiskMax: 0,
    ...overrides,
  };
}

export function makeApp(overrides = {}) {
  return { id: 'app_1', name: 'test', startTime: 0, endTime: 5000, sparkVersion: '3.4.0', config: {}, ...overrides };
}

// A slow tail whose extra time data volume explains: skew reports a stage only with one, since a tail
// with no measured cause is straggler's alone.
export function dataTail(overrides = {}) {
  return {
    tasks: 5, excessMs: 10000, dataMs: 9000, gcMs: 0, fetchWaitMs: 0, hostMs: 0, host: null, hostTasks: 0,
    dataRatio: 8, cpuPct: null, ...overrides,
  };
}

// One executor's participation row as finalizeStage builds it from that executor's task durations:
// the count, the summed duration and the sum and M2 of ln(1 + duration) slowHost tests against.
export function executorRow(executorId, durationsMs, overrides = {}) {
  const logs = durationsMs.map(Math.log1p);
  const logDurationSum = logs.reduce((a, b) => a + b, 0);
  const logMean = logDurationSum / logs.length;
  return {
    executorId, taskCount: durationsMs.length, totalDuration: durationsMs.reduce((a, b) => a + b, 0),
    logDurationSum, logDurationM2: logs.reduce((sum, x) => sum + (x - logMean) ** 2, 0),
    inputBytes: 0, shuffleReadBytes: 0, shuffleWriteBytes: 0, ...overrides,
  };
}
