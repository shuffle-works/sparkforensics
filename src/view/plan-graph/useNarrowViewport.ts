import { useSyncExternalStore } from 'react';

// Matches Tailwind's `sm` breakpoint (640px): below it the node detail is a
// bottom sheet under the graph, at or above it the docked right-hand inspector.
const QUERY = '(max-width: 639.98px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/** True on phone-width viewports. jsdom has no matchMedia, so tests and the
 * server snapshot get the desktop layout. */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
