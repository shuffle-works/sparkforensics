import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';
import { useRouteFocusedWidgetId, useTriageNavigation } from '@/view/TriageNavigationContext';

interface GridCardState {
  openRequestGeneration: number;
  reportOpen: (open: boolean) => void;
  setDisclosureButton: (button: HTMLButtonElement | null) => void;
  onDisclosureBlur: () => void;
  routeFocused: boolean;
  /** Reference-region tile: the card starts collapsed and floors its collapsed
   * height so every tile in the grid lines up regardless of summary content. */
  collapsedTile: boolean;
}

const WidgetGridCardContext = createContext<GridCardState | null>(null);

export function useWidgetGridCard() {
  return useContext(WidgetGridCardContext);
}

export function WidgetGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] items-start gap-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function WidgetGridItem({
  cardId,
  widgetId,
  children,
  className,
  collapsedTile = false,
}: {
  cardId: string;
  widgetId?: string;
  children: ReactNode;
  className?: string;
  collapsedTile?: boolean;
}) {
  const navigation = useTriageNavigation();
  const focusedWidgetId = useRouteFocusedWidgetId();
  const [openRequestGeneration, setOpenRequestGeneration] = useState(0);
  // Local mirror of the card's disclosure state, kept via `reportOpen`, so the
  // grid item can widen itself (`col-span`) when its card is open. The card
  // owns the actual open state, so this is the only channel to observe it.
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const disclosureButtonRef = useRef<HTMLButtonElement | null>(null);
  const gridCard = useMemo(() => ({
    openRequestGeneration,
    reportOpen: (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (widgetId) navigation?.reportWidgetOpen(widgetId, nextOpen);
    },
    setDisclosureButton: (button: HTMLButtonElement | null) => {
      disclosureButtonRef.current = button;
    },
    onDisclosureBlur: () => {
      if (widgetId) navigation?.clearRouteFocus(widgetId);
    },
    routeFocused: widgetId ? focusedWidgetId === widgetId : false,
    collapsedTile,
  }), [navigation, openRequestGeneration, widgetId, focusedWidgetId, collapsedTile]);

  useLayoutEffect(() => {
    if (!navigation || !widgetId || !wrapperRef.current) return;

    return navigation.registerWidget(widgetId, {
      wrapperElement: wrapperRef.current,
      open: () => {
        setOpenRequestGeneration((generation) => generation + 1);
      },
      getDisclosureButton: () => disclosureButtonRef.current,
    });
  }, [navigation, widgetId]);

  return (
    <WidgetGridCardContext.Provider value={gridCard}>
      <div
        ref={wrapperRef}
        data-testid={`widget-grid-item-${cardId}`}
        className={cn(
          'empty:hidden',
          widgetId && 'scroll-mt-20',
          open && 'col-span-full',
          className,
        )}
      >
        {children}
      </div>
    </WidgetGridCardContext.Provider>
  );
}

/** Prevent nested WidgetCards from inheriting their parent card's grid state. */
export function WidgetGridCardBoundary({ children }: { children: ReactNode }) {
  return <WidgetGridCardContext.Provider value={null}>{children}</WidgetGridCardContext.Provider>;
}
