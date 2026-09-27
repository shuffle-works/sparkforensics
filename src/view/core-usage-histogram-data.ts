import { computeCoreTimeSeries } from '@sparkforensics/core/core-time-series.ts';
import type { AppModel, TaskData } from '@sparkforensics/core/types.ts';

// Live-only: built from per-task data the parser worker holds, which an HTML export does not
// carry, so the export build swaps this module for a stub (vite.export.config.ts).

interface TaskInterval {
  launch: number;
  finish: number;
}

/** Flattens per-stage task data into the launch/finish interval list
 * `computeCoreTimeSeries` expects. */
export async function gatherTaskIntervals(
  appModel: AppModel,
  getTaskData: (id: number) => Promise<TaskData>,
): Promise<{ intervals: TaskInterval[]; incomplete: boolean }> {
  const ids = [...appModel.stages.keys()];
  const results = await Promise.all(ids.map((id) => getTaskData(id).catch(() => null)));
  const intervals: TaskInterval[] = [];
  let incomplete = false;
  for (const data of results) {
    if (!data) {
      incomplete = true;
      continue;
    }
    const { metrics, fieldNames } = data;
    const stride = fieldNames.length;
    const li = fieldNames.indexOf('launchTime');
    const fi = fieldNames.indexOf('finishTime');
    if (li === -1 || fi === -1) continue;
    for (let i = 0; i < metrics.length; i += stride) {
      intervals.push({ launch: metrics[i + li], finish: metrics[i + fi] });
    }
  }
  return { intervals, incomplete };
}

/** Wall-clock time at each concurrent-core count, from every stage's task data. */
export async function loadCoreUsageHistogram(
  appModel: AppModel,
  getTaskData: (id: number) => Promise<TaskData>,
): Promise<{ histogram: number[]; incomplete: boolean }> {
  const { intervals, incomplete } = await gatherTaskIntervals(appModel, getTaskData);
  const { histogram } = computeCoreTimeSeries(intervals, { bucketBy: 'coreCount' }) as { mode: 'coreCount'; histogram: number[] };
  return { histogram: histogram ?? [], incomplete };
}
