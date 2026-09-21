import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectRun } from '../src/cli/collect-run.js';
import { analyze } from '../src/analyzer.js';
import { computeOccupancy } from '../src/occupancy.js';
import { computeTotalCores } from '../src/core-count.js';

// Real event log, gitignored/local-only: copy it from the sibling
// ../spark-log-examples/ checkout (see CLAUDE.md) into examples/ under this
// exact name before this test can run locally.
const fixturePath = fileURLToPath(
  new URL('../../../examples/grupo-semanal-beauty-application_1785266278671_91660.zstd', import.meta.url),
);

describe('estimateImpact: false-zero regression guard (2026-08-30 N1 occupancy redesign)', () => {
  it.skipIf(!existsSync(fixturePath))(
    'a stage that ran alone (gate >= 0.95) with a real waste magnitude never reports wallClock.high === 0 or an unquantified basis (real fixture: gitignored, local-only)',
    async () => {
      const { appModel } = await collectRun(fixturePath);
      const totalCores = computeTotalCores(appModel.app ?? {}, appModel.executors.added);
      const occupancy = computeOccupancy(appModel.stages, totalCores);
      const findings = analyze(
        appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed,
        appModel.jobs, appModel.sql, appModel.runAggregates,
      );

      const violations = [];
      for (const f of findings) {
        // Single-stage findings key by `stageId`; SQL/plan-scope findings (duplicatePlanSubtree,
        // stage-mappable smallFiles/overBroadcast/underBroadcast) key by `stageIds` instead: this
        // guard treats a multi-stage finding as "ran alone" only when EVERY one of its stages did.
        const stageIds = f.stageId != null ? [f.stageId] : (Array.isArray(f.stageIds) ? f.stageIds : null);
        if (!stageIds || stageIds.length === 0) continue;
        if (f.type === 'stageShape') continue; // lowParallelism/dataExplosion/taskStageSkew are permanently resourceOnly by design, not a wall-clock claim ever
        const infos = stageIds.map((id) => occupancy.get(id));
        if (infos.some((info) => !info)) continue; // some stage excluded from the sweep
        const minGate = Math.min(...infos.map((info) => info.gate));
        if (minGate < 0.95) continue;
        const rawWasteValue = f.impactEstimate?.rawWaste?.value;
        if (!(typeof rawWasteValue === 'number' && rawWasteValue > 0)) continue;
        const est = f.impactEstimate;
        const isFalseZero = est?.wallClock?.high === 0
          || est?.basis === 'informational' || est?.basis === 'resourceOnly';
        if (isFalseZero) {
          violations.push({ type: f.type, stageId: f.stageId ?? null, stageIds, gate: minGate, rawWasteValue });
        }
      }
      expect(violations).toEqual([]);
    },
  );
});
