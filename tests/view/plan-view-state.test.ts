import { describe, expect, test } from 'vitest';

import { resolvePlanTree } from '@/view/plan-tree';
import { emptyAppModel } from '@/store/store';
import { memoizedBuildPlanGraphModel, planViewReducer, type PlanView } from '@/view/PlanGraphRoute';

const start: PlanView = { focusStageId: 7, requestedScope: 'segment', selectedNodeId: 'n1', center: { nodeId: null, token: 0 } };

describe('the plan view reducer', () => {
  test('a scope switch clears the selection, which only means something in one scope', () => {
    expect(planViewReducer(start, { type: 'setScope', scope: 'full' })).toMatchObject({ requestedScope: 'full', selectedNodeId: null });
    expect(planViewReducer({ ...start, requestedScope: 'full' }, { type: 'setScope', scope: 'segment' })).toMatchObject({ requestedScope: 'segment', selectedNodeId: null });
  });

  test('a scope switch made for a paired-node jump selects and centers the partner in the same step', () => {
    const next = planViewReducer(start, { type: 'setScope', scope: 'full', jumpTo: 'n9' });
    expect(next).toMatchObject({ requestedScope: 'full', selectedNodeId: 'n9', center: { nodeId: 'n9', token: 1 } });
    // A second jump to the same node is a new request.
    expect(planViewReducer(next, { type: 'jumpTo', id: 'n9' }).center.token).toBe(2);
  });

  test('focusing another stage returns to its segment with nothing selected', () => {
    expect(planViewReducer({ ...start, requestedScope: 'full' }, { type: 'focusStage', stageId: 9 })).toMatchObject({ focusStageId: 9, requestedScope: 'segment', selectedNodeId: null });
  });
});

describe('the plan graph model cache', () => {
  const planTree = { id: 'n0', name: 'Sort', detail: 'Sort', metrics: [], children: [] };
  const runModel = () => {
    const appModel = emptyAppModel();
    appModel.stages.set(7, { id: 7, sqlExecutionId: 1 } as never);
    appModel.sql.set(1, { executionId: 1, planTree, stageIds: [7] } as never);
    return appModel;
  };
  const build = (appModel: ReturnType<typeof emptyAppModel>) =>
    memoizedBuildPlanGraphModel(resolvePlanTree(7, appModel)!, { scope: 'segment', stageId: 7, appModel, findings: [], durationMode: 'exclusive' }, false);

  test('serves the same model within a run and builds a new one for another run', () => {
    const runA = runModel();
    expect(build(runA)).toBe(build(runA));
    expect(build(runModel())).not.toBe(build(runA));
  });
});
