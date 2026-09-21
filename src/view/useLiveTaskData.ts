import type { TaskData } from '@sparkforensics/core/types.ts';
import { useStore } from '@/store/store';

export interface LiveTaskData {
  /** True in the offline `--export-html` bundle, which has no live parser
   * worker behind `getTaskData`: callers skip the fetch and show an honest
   * "not available in exported reports" message instead. */
  exportMode: boolean;
  /** `getTaskData`, unchanged, or `undefined` in export mode. */
  getTaskData: ((id: number) => Promise<TaskData>) | undefined;
}

/** Gates a widget's `getTaskData` prop on `exportMode` in one place, for the
 * widgets that fetch per-task detail on demand (CoreUsageHistogram,
 * StageDetailDialog, StageFindingGroup). */
export function useLiveTaskData(
  getTaskData: (id: number) => Promise<TaskData>,
): LiveTaskData {
  const exportMode = useStore((s) => s.exportMode);
  return { exportMode, getTaskData: exportMode ? undefined : getTaskData };
}
