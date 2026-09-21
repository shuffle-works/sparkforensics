import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatBytes } from '@sparkforensics/core/format-utils.ts';
import type { RecentFileEntry } from '@sparkforensics/core/recent-files.ts';

// Canonical shape lives in src/recent-files.ts (the IndexedDB layer); re-export
// it here for callers importing from this module.
export type { RecentFileEntry };

export interface RecentListProps {
  entries: RecentFileEntry[];
  activeId?: string | null;
  onPick?: (id: string) => void;
  onRemove?: (id: string) => void;
}

/** Pure view over a recent-files list, reused by the drop zone and the
 * topbar file switcher. Knows nothing about IndexedDB. */
export function RecentList({ entries, activeId = null, onPick, onRemove }: RecentListProps) {
  if (!entries.length) {
    return <p className="px-1.5 py-1 text-sm text-muted-foreground">No recent files yet</p>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {entries.map((entry) => {
        const label = entry.appName || entry.name;
        const issues =
          entry.issueCount != null ? ` · ${entry.issueCount} issue${entry.issueCount === 1 ? '' : 's'}` : '';
        return (
          <li
            key={entry.id}
            className={cn(
              'flex items-center gap-1 rounded-md',
              entry.id === activeId && 'bg-accent',
            )}
          >
            <button
              type="button"
              className="tap-target-comfortable flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-left hover:bg-muted"
              onClick={() => onPick?.(entry.id)}
            >
              <span className="w-full truncate text-sm font-medium">{label}</span>
              <span className="w-full truncate text-xs text-muted-foreground">
                {entry.name} · {formatBytes(entry.size)}
                {issues}
              </span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="tap-target-comfortable"
              aria-label="Remove from recent files"
              onClick={() => onRemove?.(entry.id)}
            >
              <X aria-hidden="true" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
