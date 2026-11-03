import { useCallback, useRef, useState, type SetStateAction } from 'react';

import { store, useStore } from '@/store/store';
import { useCardKey } from '@/view/WidgetGrid';

/** `useState` for what a widget remembers across its card collapsing or its tab hiding, which unmount
 * what is inside. The value lives in the store under `key`, for the loaded run; a null `key` (a widget
 * rendered on its own) keeps it in the component. `initial` is read once. */
export function useWidgetState<T>(key: string | null, initial: T): [T, (next: SetStateAction<T>) => void] {
  const initialRef = useRef(initial);
  const [local, setLocal] = useState(initial);
  const stored = useStore((s) => (key != null && key in s.board.widgets ? (s.board.widgets[key] as T) : initialRef.current));
  const setStored = useCallback((next: SetStateAction<T>) => {
    if (key != null) store.getState().setWidgetState(key, next, initialRef.current);
  }, [key]);
  return key == null ? [local, setLocal] : [stored, setStored];
}

/** The key under which a widget in the board card around the caller remembers `name`, or null outside a
 * board card. */
export function useCardStateKey(name: string): string | null {
  const cardKey = useCardKey();
  return cardKey == null ? null : `${cardKey}:${name}`;
}
