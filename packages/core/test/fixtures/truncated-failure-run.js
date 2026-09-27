import { makeApp, makeStage } from './stage-app-fixtures.js';

// A run whose one job failed at a stage with a Spark failure reason longer than the verdict's
// 240-character quote, with a host name straddling the cut: the quote keeps "ip-10-12-13-" and
// drops the rest, a fragment no host pattern matches once it is cut.
export const TRUNCATED_HOST = 'ip-10-12-13-14.ec2.internal';
export const TRUNCATED_HOST_FRAGMENT = 'ip-10-12-13-';

export function truncatedFailureRun() {
  const reason = `${'X'.repeat(212)} executor on ${TRUNCATED_HOST} failed while fetching shuffle blocks`;
  return {
    app: makeApp({ id: 'application_0000000000000_0001' }),
    stages: new Map([[1, makeStage({ id: 1, stageFailureReason: reason })]]),
    executors: { added: [], removed: [] },
    sql: new Map(),
    jobs: new Map([[1, {
      id: 1, submissionTime: 0, stageIds: [1], sqlExecutionId: null,
      result: 'JobFailed', succeeded: false, exception: null, completionTime: 1000,
    }]]),
    runAggregates: null,
    evidenceAvailability: null,
  };
}
