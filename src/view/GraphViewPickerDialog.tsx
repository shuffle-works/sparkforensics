import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Workflow } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ImpactDot } from '@/view/ImpactBadge';
import type { ImpactBand, StageId } from '@sparkforensics/core/types.ts';

export interface GraphViewPickerEntry {
  executionId: number;
  stageId: StageId;
  label: string;
  secondary: string;
  /** Optional: when set (non-null), an ImpactDot + finding count renders
   * next to the primary line. `undefined` (caller not yet passing it) and
   * `null` both render nothing extra. */
  impactBand?: ImpactBand | null;
  findingCount?: number;
}

export interface GraphViewPickerDialogProps {
  open: boolean;
  entries: GraphViewPickerEntry[];
  onSelect: (stageId: StageId) => void;
  onOpenChange: (open: boolean) => void;
}

/** Lists every SQL execution eligible for the Topbar's "open the graph view"
 * entry point (Topbar.tsx's eligibleGraphExecutions), one row per execution,
 * two-line layout mirroring RecentList.tsx. Only ever rendered when there are
 * 2+ eligible executions; exactly 1 opens its graph directly with no dialog,
 * 0 renders no entry point at all. */
export function GraphViewPickerDialog({ open, entries, onSelect, onOpenChange }: GraphViewPickerDialogProps) {
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) setFilter('');
  }, [open]);

  const normalizedFilter = filter.trim().toLowerCase();
  const visibleEntries = normalizedFilter
    ? entries.filter(
        (entry) =>
          entry.label.toLowerCase().includes(normalizedFilter) ||
          entry.secondary.toLowerCase().includes(normalizedFilter) ||
          String(entry.executionId).includes(normalizedFilter),
      )
    : entries;

  // Moves focus to the row button at `index` among the currently visible
  // (filtered) rows, clamped to the list's bounds: no wraparound.
  function focusRowAt(index: number) {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [];
    buttons[index]?.focus();
  }

  function handleRowKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRowAt(index + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusRowAt(index - 1);
    }
  }

  function handleFilterKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      if (visibleEntries.length === 1) onSelect(visibleEntries[0].stageId);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRowAt(0);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Workflow aria-hidden="true" className="size-4 text-plan-aggregate" />
            Open plan graph
          </DialogTitle>
          <DialogDescription>Choose which SQL execution&apos;s plan to open.</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="Filter executions…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={handleFilterKeyDown}
        />
        {visibleEntries.length === 0 ? (
          <p className="px-1.5 py-1 text-sm text-muted-foreground">No matching executions</p>
        ) : (
          <ul ref={listRef} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            {visibleEntries.map((entry, index) => (
              <li key={entry.executionId}>
                <button
                  type="button"
                  className="flex w-full min-w-0 cursor-pointer flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-left hover:bg-muted"
                  onClick={() => onSelect(entry.stageId)}
                  onKeyDown={(e) => handleRowKeyDown(e, index)}
                >
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    {entry.impactBand != null && (
                      <>
                        <ImpactDot impactBand={entry.impactBand} />
                        <span className="shrink-0 text-xs font-normal text-muted-foreground">
                          {entry.findingCount} finding{entry.findingCount === 1 ? '' : 's'}
                        </span>
                      </>
                    )}
                    <span className="truncate text-sm font-medium">{entry.secondary}</span>
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground">{entry.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
