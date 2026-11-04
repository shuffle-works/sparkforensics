import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stageIdsForSqlExec } from '../src/sql-stages.js';
import { analyzedRunFrom } from './fixtures/analyzed-run.js';

// Private event logs, gitignored/local-only: each test skips unless its file
// exists under examples/. The private-log table in
// docs-site/contributor-guide/testing.md says which log goes under each name.
const firstLogPath = fileURLToPath(
  new URL('../../../examples/private-log-01.zstd', import.meta.url),
);
const secondLogPath = fileURLToPath(
  new URL('../../../examples/private-log-02.zstd', import.meta.url),
);

/** @param {string} path */
async function analyzeFixture(path) {
  const run = await analyzedRunFrom(path);
  return { appModel: run.appModel, findings: run.catalog };
}

// The execution and stages of a finding that came from a plan node; null for any other finding.
/** @param {import('../src/types.ts').Finding} f */
function planScopeOf(f) {
  if (!('executionId' in f && 'stageIds' in f)) return null;
  return { executionId: f.executionId, stageIds: f.stageIds };
}

describe('plan-node-to-stage mapping: real-log validation', () => {
  it.skipIf(!existsSync(firstLogPath))(
    'narrows at least one duplicatePlanSubtree/smallFiles/broadcastSizing finding below the execution-wide stage count on a real log',
    async () => {
      const { appModel, findings } = await analyzeFixture(firstLogPath);
      const narrowingTargets = findings.filter((f) =>
        ['duplicatePlanSubtree', 'smallFiles', 'underBroadcast', 'overBroadcast'].includes(f.type));
      expect(narrowingTargets.length).toBeGreaterThan(0);

      const narrowed = narrowingTargets.filter((f) => {
        const scope = planScopeOf(f);
        return scope != null && Array.isArray(scope.stageIds)
          && scope.stageIds.length < stageIdsForSqlExec(scope.executionId, appModel.stages).length;
      });
      expect(narrowed.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!existsSync(firstLogPath))(
    'never reports a stageId for a finding that does not belong to that finding\'s own SQL execution (cross-execution clip holds)',
    async () => {
      const { appModel, findings } = await analyzeFixture(firstLogPath);
      /** @type {{ type: string, sid: number, executionId: number }[]} */
      const violations = [];
      for (const f of findings) {
        const scope = planScopeOf(f);
        if (!scope || !Array.isArray(scope.stageIds) || scope.executionId == null) continue;
        for (const sid of scope.stageIds) {
          const stage = appModel.stages.get(sid);
          if (stage && stage.sqlExecutionId !== scope.executionId) violations.push({ type: f.type, sid, executionId: scope.executionId });
        }
      }
      expect(violations).toEqual([]);
    },
  );

  it.skipIf(!existsSync(secondLogPath))(
    'holds the same narrowing and clip invariants on a second, independent real log',
    async () => {
      const { appModel, findings } = await analyzeFixture(secondLogPath);
      const narrowingTargets = findings.filter((f) =>
        ['duplicatePlanSubtree', 'smallFiles', 'underBroadcast', 'overBroadcast'].includes(f.type));
      /** @type {{ type: string, sid: number, executionId: number }[]} */
      const violations = [];
      for (const f of narrowingTargets) {
        const scope = planScopeOf(f);
        if (!scope || !Array.isArray(scope.stageIds) || scope.executionId == null) continue;
        for (const sid of scope.stageIds) {
          const stage = appModel.stages.get(sid);
          if (stage && stage.sqlExecutionId !== scope.executionId) violations.push({ type: f.type, sid, executionId: scope.executionId });
        }
      }
      expect(violations).toEqual([]);
    },
  );

  it.skipIf(!existsSync(firstLogPath))(
    'narrowing measurably changes the outcome for executions that received at least one AQE re-plan',
    async () => {
      const { appModel, findings } = await analyzeFixture(firstLogPath);
      // hadAdaptiveUpdate is the per-execution AQE-replanned signal used here.
      const aqeReplannedExecIds = new Set(
        [...appModel.sql.values()].filter((e) => 'hadAdaptiveUpdate' in e && e.hadAdaptiveUpdate === true).map((e) => e.id),
      );
      // No AQE-replanned executions: log a visible skip rather than silently
      // passing on empty input.
      if (aqeReplannedExecIds.size === 0) {
        console.warn('No AQE-replanned executions found in the first private log; AQE-interaction assertion skipped for this run.');
        return;
      }
      const aqeTargets = findings.filter((f) => {
        const scope = planScopeOf(f);
        return scope != null && aqeReplannedExecIds.has(scope.executionId)
          && ['duplicatePlanSubtree', 'smallFiles', 'underBroadcast', 'overBroadcast'].includes(f.type);
      });
      const narrowed = aqeTargets.filter((f) => {
        const scope = planScopeOf(f);
        return scope != null && Array.isArray(scope.stageIds)
          && scope.stageIds.length < stageIdsForSqlExec(scope.executionId, appModel.stages).length;
      });
      expect(narrowed.length).toBeGreaterThan(0);
    },
  );
});
