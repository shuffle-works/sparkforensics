import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useStore, store } from '../store/store';

const Ctx = createContext<{ theme: 'dark' | 'light'; toggle: () => void } | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem('shuffle-works-theme', theme); } catch { /* ignore */ }
      // Same-origin docs-site (VitePress) pages read this key before first paint
      // to pick light/dark with no flash; syncing it here keeps any docs page
      // matching the app's theme however it was opened. See DocsSheet.tsx.
      try { window.localStorage.setItem('vitepress-theme-appearance', theme); } catch { /* ignore */ }
    }
  }, [theme]);
  const toggle = () => store.getState().setTheme(theme === 'dark' ? 'light' : 'dark');
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}
export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}
