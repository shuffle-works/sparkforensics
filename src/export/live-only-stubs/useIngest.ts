import type * as Live from '@/store/useIngest';
import { notInExport } from './not-in-export';

// Stands in for src/store/useIngest.ts (parser worker, analyzer, recent files).
export const useIngest: typeof Live.useIngest = () => ({
  startLoad: notInExport('startLoad'),
  startLoadFolder: notInExport('startLoadFolder'),
  startLoadFromUrl: notInExport('startLoadFromUrl'),
  resetToDropZone: notInExport('resetToDropZone'),
  cancelParse: notInExport('cancelParse'),
  // Async like the live one; widgets skip it in export mode (useLiveTaskData).
  getTaskData: () => Promise.reject(new Error('Task data is not part of an exported dashboard.')),
  pickRecent: notInExport('pickRecent'),
  prepareComparison: notInExport('prepareComparison'),
  startCompareLoad: notInExport('startCompareLoad'),
  drillIntoRun: notInExport('drillIntoRun'),
  compareWithAnotherRun: notInExport('compareWithAnotherRun'),
});
