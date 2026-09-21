import { useState } from 'react';

export interface ExpandableRowState<T> {
  expanded: boolean;
  data: T | null;
  loading: boolean;
  error: boolean;
  toggle: () => void;
}

/** Shared per-row disclosure state for the Gold Standard row/expand pattern
 * (docs-site/contributor-guide/architecture/widget-rendering.md). Pass a
 * `fetchFn` for rows with async detail to lazily fetch on first expand
 * (e.g. Skew.tsx's duration histogram); omit it for rows whose expanded
 * content is already available synchronously (recommendation text,
 * PlanExplorer, evidence links): `data`/`loading`/`error` then stay at
 * their initial values and callers ignore them. */
export function useExpandableRow<T = void>(fetchFn?: () => Promise<T>): ExpandableRowState<T> {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && fetchFn && !hasFetched && !loading) {
      setLoading(true);
      fetchFn()
        .then((result) => setData(result))
        .catch(() => setError(true))
        .finally(() => {
          setHasFetched(true);
          setLoading(false);
        });
    }
  };

  return { expanded, data, loading, error, toggle };
}
