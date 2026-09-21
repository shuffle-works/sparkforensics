// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';

// base-ui popups position via floating-ui, which constructs a ResizeObserver
// on mount; jsdom has none. A no-op stub is enough (we assert class lists,
// not pixel layout). Scoped to this file, same as docs-sheet.test.tsx.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

/** Query a base-ui portal element off the live document and return its class list. */
function slotClasses(slot: string): string {
  const el = document.querySelector(`[data-slot="${slot}"]`);
  expect(el, `[data-slot="${slot}"] should be in the document`).not.toBeNull();
  return el?.className ?? '';
}

describe('dialog respects prefers-reduced-motion and the scrim token', () => {
  it('overlay and content carry motion-reduce:animate-none; overlay consumes --overlay-scrim', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>t</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const overlay = slotClasses('dialog-overlay');
    expect(overlay).toContain('motion-reduce:animate-none');
    expect(overlay).toContain('bg-(--overlay-scrim)');
    expect(overlay).not.toContain('bg-black/10');
    expect(slotClasses('dialog-content')).toContain('motion-reduce:animate-none');
  });
});

describe('sheet respects prefers-reduced-motion and the scrim token', () => {
  it('overlay and content carry motion-reduce:transition-none; overlay consumes --overlay-scrim', () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>t</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    const overlay = slotClasses('sheet-overlay');
    expect(overlay).toContain('motion-reduce:transition-none');
    expect(overlay).toContain('bg-(--overlay-scrim)');
    expect(overlay).not.toContain('bg-black/10');
    expect(slotClasses('sheet-content')).toContain('motion-reduce:transition-none');
  });
});

describe('dropdown menu respects prefers-reduced-motion', () => {
  it('content carries motion-reduce:animate-none', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>t</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>i</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(slotClasses('dropdown-menu-content')).toContain('motion-reduce:animate-none');
  });

  it('sub-content carries motion-reduce:animate-none', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>t</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>more</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>sub</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(slotClasses('dropdown-menu-sub-content')).toContain('motion-reduce:animate-none');
  });
});
