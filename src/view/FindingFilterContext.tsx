import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ImpactBand } from '@sparkforensics/core/types.ts';
import {
  emptySelection,
  parseFilterSelection,
  serializeFilterSelection,
  type FilterOptions,
  type FilterSelection,
} from './finding-filter';

export interface FindingFilterContextValue {
  selection: FilterSelection;
  toggleImpactBand: (value: ImpactBand) => void;
  toggleType: (value: string) => void;
  toggleStage: (value: number) => void;
  clearAll: () => void;
  replaceSelection: (next: FilterSelection) => void;
}

const Ctx = createContext<FindingFilterContextValue | null>(null);

function toggled<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// Providers currently mounted. A provider that renders while another is still mounted replaces a
// run (`DashboardRoute` is keyed by run), and the address bar still holds the old run's params until
// that provider unmounts, so the new one starts with no filter instead of reading them.
let mountedProviders = 0;

/**
 * Owns the board-wide finding filter and keeps it in sync with the URL. Mirrors
 * StageDetailContext's lightweight createContext + useState idiom. Seeded only
 * from the URL (reload with no params = clean slate); every change is written
 * back with `history.replaceState` (never push), and `popstate` re-seeds it so
 * Back/forward re-applies filters.
 */
export function FindingFilterProvider({
  options,
  children,
}: {
  options: FilterOptions;
  children: ReactNode;
}) {
  const [selection, setSelection] = useState<FilterSelection>(() => (
    mountedProviders > 0
      ? emptySelection()
      : parseFilterSelection(typeof window === 'undefined' ? '' : window.location.search, options)
  ));

  // Mirror the active selection into the URL. Runs on mount (idempotent
  // normalization) and every change; always replaceState so history never grows.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = serializeFilterSelection(selection);
    const url = `${window.location.pathname}${query}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', url);
  }, [selection]);

  // On unmount (a fresh parse tears the dashboard down and remounts it for the
  // next file), strip our params so the remount seeds a clean slate instead of
  // re-applying the previous file's filter from a stale URL. A genuine page
  // reload re-reads the address bar, so deep-links still restore.
  useEffect(() => {
    mountedProviders += 1;
    return () => {
      mountedProviders -= 1;
      if (typeof window === 'undefined') return;
      const url = `${window.location.pathname}${window.location.hash}`;
      window.history.replaceState(window.history.state, '', url);
    };
  }, []);

  // Back/forward: re-seed from the restored URL against the latest options.
  // `options` is memoized upstream (changes only on file/catalog load), so
  // re-subscribing on its identity is cheap and avoids a stale-closure ref.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => setSelection(parseFilterSelection(window.location.search, options));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [options]);

  const toggleImpactBand = useCallback(
    (value: ImpactBand) => setSelection((s) => ({ ...s, impactBands: toggled(s.impactBands, value) })),
    [],
  );
  const toggleType = useCallback(
    (value: string) => setSelection((s) => ({ ...s, types: toggled(s.types, value) })),
    [],
  );
  const toggleStage = useCallback(
    (value: number) => setSelection((s) => ({ ...s, stages: toggled(s.stages, value) })),
    [],
  );
  const clearAll = useCallback(() => setSelection(emptySelection()), []);

  const value = useMemo<FindingFilterContextValue>(
    () => ({ selection, toggleImpactBand, toggleType, toggleStage, clearAll, replaceSelection: setSelection }),
    [selection, toggleImpactBand, toggleType, toggleStage, clearAll],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFindingFilter(): FindingFilterContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFindingFilter outside FindingFilterProvider');
  return v;
}
