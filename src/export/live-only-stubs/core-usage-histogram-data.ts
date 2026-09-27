import type * as Live from '@/view/core-usage-histogram-data';
import { notInExport } from './not-in-export';

// Stands in for src/view/core-usage-histogram-data.ts: an export carries no task data,
// and CoreUsageHistogram shows that instead of loading (useLiveTaskData).
export const gatherTaskIntervals: typeof Live.gatherTaskIntervals = notInExport('gatherTaskIntervals');

export const loadCoreUsageHistogram: typeof Live.loadCoreUsageHistogram = notInExport('loadCoreUsageHistogram');
