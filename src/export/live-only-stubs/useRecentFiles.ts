import type * as Live from '@/view/useRecentFiles';
import { notInExport } from './not-in-export';

// Stands in for src/view/useRecentFiles.ts (IndexedDB recent files): an export has none.
export const useRecentFiles: typeof Live.useRecentFiles = () => ({
  recentEntries: [],
  onPickRecent: notInExport('onPickRecent'),
  onRemoveRecent: notInExport('onRemoveRecent'),
});
