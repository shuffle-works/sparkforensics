import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Previous/Page X of Y/Next control shared by every paginated Tier B list.
 * `renderJumpControl` is an opt-in slot for ShuffleIO.tsx's jump-to-stage
 * `<Select>`: only that widget pays for it. Renders nothing when everything
 * fits on one page.
 */
export function RowPagination({
  page,
  totalPages,
  onPrev,
  onNext,
  renderJumpControl,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  renderJumpControl?: () => ReactNode;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${renderJumpControl ? 'justify-between' : 'justify-end'}`}>
      {renderJumpControl?.()}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="tap-target-comfortable tap-target-comfortable--sm"
          onClick={onPrev}
          disabled={page === 0}
        >
          Previous
        </Button>
        <span className="text-muted-foreground">
          Page {page + 1} of {totalPages}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="tap-target-comfortable tap-target-comfortable--sm"
          onClick={onNext}
          disabled={page === totalPages - 1}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
