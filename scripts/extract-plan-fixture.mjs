#!/usr/bin/env node
// One-off extraction: pulls stage 394's planTree out of the real grupo-semanal
// fixture into a small JSON test fixture, so tests/plan-graph-model.test.js can
// pin real-world node/edge/badge counts without the multi-hundred-MB event log.
import { writeFileSync } from 'node:fs';
import { collectRun } from '../packages/core/src/cli/collect-run.ts';

const LOG_PATH = process.argv[2]
  ?? '../spark-log-examples/run-compare-grupo-semanal-baseline-application_1785266278671_63415.zstd';
const STAGE_ID = 394;

const { appModel } = await collectRun(LOG_PATH);
const stage = appModel.stages.get(STAGE_ID);
if (!stage) throw new Error(`Stage ${STAGE_ID} not found in ${LOG_PATH}`);
const sqlExec = appModel.sql.get(stage.sqlExecutionId);
if (!sqlExec?.planTree) throw new Error(`No planTree for stage ${STAGE_ID}`);

const fixture = {
  stageId: STAGE_ID,
  sqlExecutionId: stage.sqlExecutionId,
  stage: { submittedAt: stage.submittedAt, completedAt: stage.completedAt },
  sqlExec: { executionId: sqlExec.executionId, stageIds: sqlExec.stageIds },
  planTree: sqlExec.planTree,
  // Real findings for this stage, to reproduce the skew/gc/straggler badge scenario.
  findings: [],
};

writeFileSync('packages/core/test/fixtures/plan-graph-stage-394.json', JSON.stringify(fixture, null, 2));
console.log('Wrote packages/core/test/fixtures/plan-graph-stage-394.json');
