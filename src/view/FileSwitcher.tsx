import { useCallback } from 'react';
import { ChevronDown } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { RecentList, type RecentFileEntry } from '@/view/RecentList';
import { useIngest } from '@/store/useIngest';

export interface FileSwitcherProps {
  activeName?: string | null;
  activeSub?: string | null;
  activeId?: string | null;
  entries: RecentFileEntry[];
  onPick?: (id: string) => void;
  onRemove?: (id: string) => void;
  onOpenNew?: () => void;
}

/** Topbar "current file ▾" control. Wraps the shared RecentList plus a
 * "Load new file…" action inside a shadcn DropdownMenu: outside-click and
 * ESC dismissal are owned by the underlying menu primitive, not hand-rolled.
 *
 * When the caller doesn't supply `onPick`, picking an entry falls back to
 * `useIngest().pickRecent`, which restores instantly from the in-session
 * snapshot cache or re-parses from the entry's handle. */
export function FileSwitcher({
  activeName,
  activeSub,
  activeId = null,
  entries,
  onPick,
  onRemove,
  onOpenNew,
}: FileSwitcherProps) {
  const { pickRecent } = useIngest();

  const handlePick = useCallback(
    (id: string) => {
      if (onPick) { onPick(id); return; }
      void pickRecent(id, entries.find((e) => e.id === id)?.handle);
    },
    [onPick, entries, pickRecent],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          buttonVariants({ variant: 'ghost' }),
          'h-auto min-w-0 shrink max-w-40 flex-col items-start justify-center gap-0 py-1 sm:max-w-80',
        )}
      >
        {/* buttonVariants ships `shrink-0`; override with `shrink`+`min-w-0` so
            the trigger can shrink below its content, and give the span min-w-0
            too so `truncate` can clip a spaceless filename (whose min-content is
            the whole string) instead of overflowing into the Topbar badge. */}
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-heading text-sm font-semibold">{activeName ?? 'No file'}</span>
          <ChevronDown aria-hidden="true" className="ml-auto shrink-0 opacity-60" />
        </span>
        {activeSub ? (
          <span className="w-full min-w-0 truncate text-left text-xs text-muted-foreground">{activeSub}</span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72 p-2">
        <RecentList entries={entries} activeId={activeId} onPick={handlePick} onRemove={onRemove} />
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onOpenNew?.()}>Load new file…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
