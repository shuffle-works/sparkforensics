// The Findings board's disclosure and route state for the loaded run. The layout it indexes into
// (which cards exist, their rows and order) is a pure function of the run (src/view/board-layout.ts);
// this holds only what the reader and the active route have chosen.

export type BoardTab = 'findings' | 'full-report';

/** Where a route lands in a board layout. */
export interface ResolvedRoute {
  /** The tab to show, or null to leave the tab as it is (the verdict sits above the tabs). */
  tab: BoardTab | null;
  /** The cards the route opens. */
  openCards: readonly string[];
  /** The card the route lands in, if any. */
  cardKey: string | null;
  /** The element that takes focus: a row's finding key, or a line or landmark key. */
  rowKey: string | null;
}

export interface ActiveRoute extends ResolvedRoute {
  /** Each route is a new one, even to the same place. */
  token: number;
  /** Whether the landing row flashes; the triage shortcuts only move focus. */
  flash: boolean;
  /** Where in view the landing element scrolls to. */
  block: 'start' | 'center' | 'nearest';
}

export interface RouteOptions {
  flash?: boolean;
  block?: ActiveRoute['block'];
}

export interface BoardState {
  tab: BoardTab;
  openCards: ReadonlySet<string>;
  /** Every card a route has opened: a card the board shows only on a route stays once it is revealed. */
  revealedCards: ReadonlySet<string>;
  /** The group line whose members are listed. */
  expandedGroup: string | null;
  route: ActiveRoute | null;
  /** The route whose landing has run, so a row that mounts again does not take focus again. */
  landedToken: number;
  /** The line holding focus, from which j/k step. */
  cursor: string | null;
  /** What each widget remembers while its card is collapsed or its tab is hidden (a page, a sort,
   * a filter), by the widget's own key. It belongs to the loaded run and goes with it. */
  widgets: Readonly<Record<string, unknown>>;
}

export function initialBoard(): BoardState {
  return { tab: 'findings', openCards: new Set(), revealedCards: new Set(), expandedGroup: null, route: null, landedToken: 0, cursor: null, widgets: {} };
}

export interface BoardActions {
  /** Shows a tab; the reader leaving the route's place ends the route. */
  selectTab: (tab: BoardTab) => void;
  setCardOpen: (key: string, open: boolean) => void;
  toggleGroup: (lineKey: string) => void;
  startRoute: (route: ResolvedRoute, options?: RouteOptions) => void;
  landRoute: (token: number) => void;
  setCursor: (key: string | null) => void;
  /** Sets a widget's remembered state; `next` may be a function of the current value. */
  setWidgetState: (key: string, next: unknown | ((current: unknown) => unknown), initial: unknown) => void;
}

type Slice = { board: BoardState };

export function boardActions(set: (update: (state: Slice) => Partial<Slice>) => void): BoardActions {
  return {
    selectTab: (tab) => set(({ board }) => ({ board: { ...board, tab, route: null } })),
    setCardOpen: (key, open) => set(({ board }) => {
      if (board.openCards.has(key) === open) return {};
      const openCards = new Set(board.openCards);
      if (open) openCards.add(key);
      else openCards.delete(key);
      return { board: { ...board, openCards } };
    }),
    toggleGroup: (lineKey) => set(({ board }) => ({ board: { ...board, expandedGroup: board.expandedGroup === lineKey ? null : lineKey } })),
    startRoute: (resolved, { flash = true, block = 'center' } = {}) => set(({ board }) => ({
      board: {
        ...board,
        tab: resolved.tab ?? board.tab,
        openCards: new Set([...board.openCards, ...resolved.openCards]),
        revealedCards: new Set([...board.revealedCards, ...resolved.openCards]),
        route: { ...resolved, token: Math.max(board.route?.token ?? 0, board.landedToken) + 1, flash, block },
      },
    })),
    landRoute: (token) => set(({ board }) => (board.landedToken === token ? {} : { board: { ...board, landedToken: token } })),
    setCursor: (cursor) => set(({ board }) => (board.cursor === cursor ? {} : { board: { ...board, cursor } })),
    setWidgetState: (key, next, initial) => set(({ board }) => {
      const current = key in board.widgets ? board.widgets[key] : initial;
      const value = typeof next === 'function' ? (next as (current: unknown) => unknown)(current) : next;
      return Object.is(value, current) && key in board.widgets ? {} : { board: { ...board, widgets: { ...board.widgets, [key]: value } } };
    }),
  };
}
