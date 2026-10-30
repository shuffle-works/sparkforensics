import type { TaskData } from '@sparkforensics/core/types.ts';
import { useStore } from '@/store/store';

export interface LiveTaskData {
  /** True when the run on screen has no source of per-task detail (an exported report, or a run
   * restored with nothing prefetched): callers skip the fetch and say the detail is not available. */
  unavailable: boolean;
  /** `getTaskData`, unchanged, or `undefined` when the run has no task data. */
  getTaskData: ((id: number) => Promise<TaskData>) | undefined;
}

/** Gates a widget's `getTaskData` prop on the run's task data source in one place, for the
 * widgets that fetch per-task detail on demand (CoreUsageHistogram,
 * StageDetailDialog, StageFindingGroup). */
export function useLiveTaskData(
  getTaskData: (id: number) => Promise<TaskData>,
): LiveTaskData {
  const unavailable = useStore((s) => s.run?.taskData.kind === 'none');
  return { unavailable, getTaskData: unavailable ? undefined : getTaskData };
}
