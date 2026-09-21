import { computeEfficiencyModel } from '@sparkforensics/core/efficiency-model.ts';
import { computeWallClock } from '@sparkforensics/core/wall-clock.ts';
import type { AppModel } from '@sparkforensics/core/types.ts';

type EfficiencyEstimate = {
  value: number | null;
  unavailableReason: 'application-timing' | null;
};

type WastageEstimate = {
  value: number | null;
  unavailableReason: 'application-timing' | 'core-usage-summary' | 'executor-capacity' | null;
};

export function hasCompleteApplicationInterval(app: AppModel['app']): boolean {
  return typeof app?.startTime === 'number'
    && Number.isFinite(app.startTime)
    && typeof app?.endTime === 'number'
    && Number.isFinite(app.endTime)
    && app.endTime > app.startTime;
}

export function getScorecardEstimates(appModel: AppModel): {
  efficiency: EfficiencyEstimate;
  wastage: WastageEstimate;
} {
  if (!hasCompleteApplicationInterval(appModel.app)) {
    return {
      efficiency: { value: null, unavailableReason: 'application-timing' },
      wastage: { value: null, unavailableReason: 'application-timing' },
    };
  }

  const wallClock = computeWallClock(appModel.app, appModel.stages);
  const efficiency = Math.min(100, Math.round((wallClock.stagesActive / wallClock.total) * 100));

  if (!appModel.runAggregates) {
    return {
      efficiency: { value: efficiency, unavailableReason: null },
      wastage: { value: null, unavailableReason: 'core-usage-summary' },
    };
  }

  const efficiencyModel = computeEfficiencyModel({
    app: appModel.app,
    stages: appModel.stages,
    executorsAdded: appModel.executors.added,
    runAggregates: appModel.runAggregates,
  });

  if (!Number.isFinite(efficiencyModel.availableComputeHours) || efficiencyModel.availableComputeHours <= 0) {
    return {
      efficiency: { value: efficiency, unavailableReason: null },
      wastage: { value: null, unavailableReason: 'executor-capacity' },
    };
  }

  return {
    efficiency: { value: efficiency, unavailableReason: null },
    wastage: { value: efficiencyModel.wastagePct, unavailableReason: null },
  };
}
