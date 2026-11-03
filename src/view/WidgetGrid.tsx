import { createContext, useContext, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { store, useStore } from '@/store/store';
import { ErrorBoundary, WidgetErrorCard } from '@/view/ErrorBoundary';
import { useBoardLayout } from '@/view/BoardLayoutContext';

interface GridCard {
  /** The board card key when the card is one the layout lists; its disclosure is the board's. */
  key: string | null;
  /** Reference-region tile: the card starts collapsed and floors its collapsed
   * height so every tile in the grid lines up regardless of summary content. */
  collapsedTile: boolean;
}

const GridCardContext = createContext<GridCard | null>(null);

export function useWidgetGridCard(): GridCard | null {
  return useContext(GridCardContext);
}

/** The disclosure of the card around the caller. A card the layout lists is open when the board
 * says so; any other card (a widget on its own) keeps its own state, starting as `initiallyOpen`. */
export function useCardDisclosure(initiallyOpen: boolean): { open: boolean; setOpen: (open: boolean) => void } {
  const key = useWidgetGridCard()?.key ?? null;
  const stored = useStore((s) => key != null && s.board.openCards.has(key));
  const [local, setLocal] = useState(initiallyOpen);
  if (key != null) return { open: stored, setOpen: (open) => store.getState().setCardOpen(key, open) };
  return { open: local, setOpen: setLocal };
}

export function WidgetGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function WidgetGridItem({
  cardId,
  children,
  className,
  collapsedTile = false,
}: {
  /** The card's key in the board layout. */
  cardId: string;
  children: ReactNode;
  className?: string;
  collapsedTile?: boolean;
}) {
  const layout = useBoardLayout();
  const listed = layout?.cards.has(cardId) ?? false;
  const open = useStore((s) => listed && s.board.openCards.has(cardId));
  return (
    <GridCardContext.Provider value={{ key: listed ? cardId : null, collapsedTile }}>
      <div
        data-testid={`widget-grid-item-${cardId}`}
        className={cn('scroll-mt-20', open && 'col-span-full', className)}
      >
        {/* A widget that throws on its log's data shows an error card here, not a blank page. */}
        <ErrorBoundary fallback={(error, reset) => <WidgetErrorCard error={error} onRetry={reset} />}>
          {children}
        </ErrorBoundary>
      </div>
    </GridCardContext.Provider>
  );
}

/** Prevent nested WidgetCards from inheriting their parent card's grid state. */
export function WidgetGridCardBoundary({ children }: { children: ReactNode }) {
  return <GridCardContext.Provider value={null}>{children}</GridCardContext.Provider>;
}
