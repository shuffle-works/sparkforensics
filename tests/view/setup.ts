import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// A test file's first render() of <App/> pays for a cold dynamic import +
// Vite transform of whichever lazy route it hits (Dashboard's is the
// heaviest: it statically pulls in every widget). Under load that first
// resolution can exceed the default 1000ms findByRole/waitFor timeout even
// though the route itself is fine, so failures show up as a stuck "Loading
// dashboard…"/"Loading plan graph…" fallback rather than a real assertion
// failure. Give async queries more room to let that one-time cost clear.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  // Global setupFile: node-environment tests have no `window`, so only clear
  // storage where jsdom actually provides it (view tests).
  if (typeof window !== 'undefined') window.localStorage?.clear();
});

// Node 26's Vitest/jsdom global proxy does not forward the Storage getter;
// expose the actual DOM storage surface to browser-facing code under test.
// If `window.localStorage` is already present (Node 24 / current vitest 2.1.9),
// this shim silently no-ops.
const domWindow = (globalThis as typeof globalThis & { jsdom?: { window: Window } }).jsdom?.window;
if (typeof window !== 'undefined' && domWindow && !window.localStorage) {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: domWindow.localStorage,
  });
}

// jsdom has no matchMedia; sonner's Toaster (and the store's initialTheme)
// query it to detect the OS color-scheme preference.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

if (typeof window !== 'undefined' && window.localStorage === undefined) {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    },
  });
}
