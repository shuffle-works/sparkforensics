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
// The key of the board card around a component, for the state its widget remembers. Unlike the grid
// card it reaches into the card's body, where a nested card has its own.
const CardKeyContext = createContext<string | null>(null);

export function useCardKey(): string | null {
  return useContext(CardKeyContext);
}

export function useWidgetGridCard(): GridCard | null {
  return useContext(GridCardContext);
}

/** The disclosure of the card around the caller. A card the layout lists is open when the board
 * says so; a report card (`ReportCard`) keeps it in the run's widget state, so hiding its tab loses
 * nothing; any other card (a widget on its own) keeps its own state, starting as `initiallyOpen`. */
export function useCardDisclosure(initiallyOpen: boolean): { open: boolean; setOpen: (open: boolean) => void } {
  const key = useWidgetGridCard()?.key ?? null;
  const cardKey = useCardKey();
  const stateKey = key == null && cardKey != null ? `${cardKey}:open` : null;
  const stored = useStore((s) => key != null && s.board.openCards.has(key));
  const remembered = useStore((s) => (stateKey != null && stateKey in s.board.widgets ? s.board.widgets[stateKey] === true : initiallyOpen));
  const [local, setLocal] = useState(initiallyOpen);
  if (key != null) return { open: stored, setOpen: (open) => store.getState().setCardOpen(key, open) };
  if (stateKey != null) return { open: remembered, setOpen: (open) => store.getState().setWidgetState(stateKey, open, initiallyOpen) };
  return { open: local, setOpen: setLocal };
}

/** A Full app report card outside the grid: `name` keys what it remembers for the run. */
export function ReportCard({ name, children }: { name: string; children: ReactNode }) {
  return <CardKeyContext.Provider value={`report:${name}`}>{children}</CardKeyContext.Provider>;
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
      <CardKeyContext.Provider value={listed ? cardId : null}>
      <div
        data-testid={`widget-grid-item-${cardId}`}
        className={cn('scroll-mt-20', open && 'col-span-full', className)}
      >
        {/* A widget that throws on its log's data shows an error card here, not a blank page. */}
        <ErrorBoundary fallback={(error, reset) => <WidgetErrorCard error={error} onRetry={reset} />}>
          {children}
        </ErrorBoundary>
      </div>
      </CardKeyContext.Provider>
    </GridCardContext.Provider>
  );
}

/** Prevent nested WidgetCards from inheriting their parent card's grid state. */
export function WidgetGridCardBoundary({ children }: { children: ReactNode }) {
  return <GridCardContext.Provider value={null}>{children}</GridCardContext.Provider>;
}
