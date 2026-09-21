import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import * as recentFiles from '@sparkforensics/core/recent-files.ts';
import { useIngest } from '@/store/useIngest';
import type { RecentFileEntry } from '@/view/RecentList';

/** Recent files are best-effort: IndexedDB or permissions can be
 * unavailable, in which case the switcher just shows no entries. Mirrors
 * DropZone's own refreshEntries/onPickRecent/onRemoveRecent trio.
 *
 * `activeFileId` is only a refresh trigger (the list is re-read whenever the
 * active file changes), not otherwise consulted here. */
export function useRecentFiles(activeFileId: string | null): {
  recentEntries: RecentFileEntry[];
  onPickRecent: (id: string) => Promise<void> | void;
  onRemoveRecent: (id: string) => void;
} {
  const { pickRecent } = useIngest();
  const [recentEntries, setRecentEntries] = useState<RecentFileEntry[]>([]);

  const refreshEntries = useCallback(() => {
    recentFiles
      .list()
      .then((list: RecentFileEntry[]) => setRecentEntries(list))
      .catch(() => setRecentEntries([]));
  }, []);

  useEffect(() => {
    refreshEntries();
  }, [refreshEntries, activeFileId]);

  const onPickRecent = useCallback(
    async (id: string) => {
      const entry = recentEntries.find((e) => e.id === id);
      const result = await pickRecent(id, entry?.handle);
      if (result === 'restored' || result === 'gone') refreshEntries();
    },
    [recentEntries, pickRecent, refreshEntries],
  );

  const onRemoveRecent = useCallback(
    (id: string) => {
      const entry = recentEntries.find((e) => e.id === id);
      recentFiles.remove(id).catch(() => {}).finally(refreshEntries);
      if (entry) {
        toast(`Removed "${entry.appName || entry.name}" from recent files`, {
          action: {
            label: 'Undo',
            onClick: () => {
              recentFiles.add(entry).catch(() => {}).finally(refreshEntries);
            },
          },
        });
      }
    },
    [recentEntries, refreshEntries],
  );

  return { recentEntries, onPickRecent, onRemoveRecent };
}
