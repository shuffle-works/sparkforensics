import { createContext, useContext } from 'react';

import type { BoardLayout } from '@/view/board-layout';

/** The layout of the board being rendered. Absent where a widget renders on its own (the docs
 * example, a test), which then has no cards to open and no routes to land. */
export const BoardLayoutContext = createContext<BoardLayout | null>(null);

export function useBoardLayout(): BoardLayout | null {
  return useContext(BoardLayoutContext);
}
