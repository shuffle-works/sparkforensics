import { useSyncExternalStore } from 'react';

// Live prefers-reduced-motion subscription so chart animations react to the OS
// setting changing mid-session. Recharts animates via JS (react-smooth), not CSS
// transitions, so a CSS media rule can't stop it; charts drive its
// isAnimationActive from this.
const QUERY = '(prefers-reduced-motion: reduce)';

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

export function useReducedMotion(): boolean {
  // Server/jsdom snapshot is false (motion allowed), matching Recharts' default.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
