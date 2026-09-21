// Shared stage/app fixture factories, deduped out of near-identical copies
// previously pasted into analyzer.test.js, analyzer-finding-identity.test.js,
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
