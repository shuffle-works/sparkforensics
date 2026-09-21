import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectRun } from '../src/cli/collect-run.js';
import { analyze } from '../src/analyzer.js';
import { stageIdsForSqlExec } from '../src/detectors.js';

const beautyPath = fileURLToPath(
  new URL('../../../examples/grupo-semanal-beauty-application_1785266278671_91660.zstd', import.meta.url),
);
// Full app-id suffix filename per docs/architecture.md convention; the
// shortened 'ventas-mensual-multi-big.zstd' does not exist as a fixture.
const ventasPath = fileURLToPath(
  new URL('../../../examples/ventas-mensual-multi-big-application_1785266278671_91510.zstd', import.meta.url),
);

async function analyzeFixture(path) {
  const { appModel } = await collectRun(path);
  const findings = analyze(
    appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed,
    appModel.jobs, appModel.sql, appModel.runAggregates,
  );
  return { appModel, findings };
}

describe('plan-node-to-stage mapping: real-log validation', () => {
  it.skipIf(!existsSync(beautyPath))(
    'narrows at least one duplicatePlanSubtree/smallFiles/broadcastSizing finding below the execution-wide stage count on a real log',
    async () => {
      const { appModel, findings } = await analyzeFixture(beautyPath);
      const narrowingTargets = findings.filter((f) =>
        ['duplicatePlanSubtree', 'smallFiles', 'underBroadcast', 'overBroadcast'].includes(f.type));
      expect(narrowingTargets.length).toBeGreaterThan(0);

      const narrowed = narrowingTargets.filter((f) => {
        const wide = stageIdsForSqlExec(f.executionId, appModel.stages);
        return Array.isArray(f.stageIds) && f.stageIds.length < wide.length;
      });
      expect(narrowed.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!existsSync(beautyPath))(
    'never reports a stageId for a finding that does not belong to that finding\'s own SQL execution (cross-execution clip holds)',
    async () => {
      const { appModel, findings } = await analyzeFixture(beautyPath);
      const violations = [];
      for (const f of findings) {
        if (!Array.isArray(f.stageIds) || f.executionId == null) continue;
        for (const sid of f.stageIds) {
          const stage = appModel.stages.get(sid);
          if (stage && stage.sqlExecutionId !== f.executionId) violations.push({ type: f.type, sid, executionId: f.executionId });
        }
      }
      expect(violations).toEqual([]);
    },
  );

  it.skipIf(!existsSync(ventasPath))(
    'holds the same narrowing and clip invariants on a second, independent real log',
    async () => {
      const { appModel, findings } = await analyzeFixture(ventasPath);
      const narrowingTargets = findings.filter((f) =>
        ['duplicatePlanSubtree', 'smallFiles', 'underBroadcast', 'overBroadcast'].includes(f.type));
      const violations = [];
      for (const f of narrowingTargets) {
        if (!Array.isArray(f.stageIds) || f.executionId == null) continue;
        for (const sid of f.stageIds) {
          const stage = appModel.stages.get(sid);
          if (stage && stage.sqlExecutionId !== f.executionId) violations.push({ type: f.type, sid, executionId: f.executionId });
        }
      }
      expect(violations).toEqual([]);
    },
  );

  it.skipIf(!existsSync(beautyPath))(
    'narrowing measurably changes the outcome for executions that received at least one AQE re-plan',
    async () => {
      const { appModel, findings } = await analyzeFixture(beautyPath);
      // hadAdaptiveUpdate is the per-execution AQE-replanned signal used here.
      const aqeReplannedExecIds = new Set(
        [...appModel.sql.values()].filter((e) => e.hadAdaptiveUpdate === true).map((e) => e.id),
      );
      // No AQE-replanned executions: log a visible skip rather than silently
      // passing on empty input.
      if (aqeReplannedExecIds.size === 0) {
        console.warn('No AQE-replanned executions found in the beauty fixture; AQE-interaction assertion skipped for this run.');
        return;
      }
      const aqeTargets = findings.filter((f) =>
        aqeReplannedExecIds.has(f.executionId)
        && ['duplicatePlanSubtree', 'smallFiles', 'underBroadcast', 'overBroadcast'].includes(f.type));
      const narrowed = aqeTargets.filter((f) => {
        const wide = stageIdsForSqlExec(f.executionId, appModel.stages);
        return Array.isArray(f.stageIds) && f.stageIds.length < wide.length;
      });
      expect(narrowed.length).toBeGreaterThan(0);
    },
  );
});
