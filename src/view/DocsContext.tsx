import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { docsUrl, isKnownDocAnchor } from '@sparkforensics/core/docs-config.ts';
import { docsHref } from '@/view/docs-href';

const DEFAULT_ANCHOR = '#intro';

/** What the docs panel is currently showing: a docs-site (VitePress) page,
 * either the tuning-reference glossary (an anchor resolved via docsUrl()) or
 * a guide page. Both open through the same panel, at a resolved `path`;
 * `source` records which entry point opened it so the panel title stays
 * correct without inferring it from the path shape. */
export type DocsTarget = { kind: 'site'; source: 'reference' | 'guide'; path: string };

export interface DocsContextValue {
  /** Opens the panel on the tuning-reference glossary at `anchor`. */
  open: (anchor?: string) => void;
  /** Opens the panel on a docs-site guide page at `path` (e.g. the value of
   * `findingGuideUrl()`). */
  openSite: (path: string) => void;
  close: () => void;
  isOpen: boolean;
  /** Current target, consumed by DocsSheet to drive the iframe. */
  target: DocsTarget;
}

const Ctx = createContext<DocsContextValue | null>(null);

/** Owns the docs-sheet open/target state. Mount <DocsSheet /> once, inside
 * this provider, to render the actual panel + iframe. */
export function DocsProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [target, setTarget] = useState<DocsTarget>({ kind: 'site', source: 'reference', path: docsUrl(DEFAULT_ANCHOR) });

  const open = useCallback((next: string = DEFAULT_ANCHOR) => {
    setTarget({ kind: 'site', source: 'reference', path: docsUrl(next) });
    setIsOpen(true);
  }, []);
  const openSite = useCallback((path: string) => {
    setTarget({ kind: 'site', source: 'guide', path });
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  const value = useMemo<DocsContextValue>(
    () => ({ open, openSite, close, isOpen, target }),
    [open, openSite, close, isOpen, target],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDocs(): DocsContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDocs outside DocsProvider');
  return v;
}

/** Same as `useDocs()`, but tolerates rendering with no `DocsProvider`
 * ancestor: returns null instead of throwing. Used by widely-shared
 * components (e.g. `TagBadge`) that render in many places a DocsProvider
 * doesn't always wrap (most widget unit tests render the widget bare). */
export function useOptionalDocs(): DocsContextValue | null {
  return useContext(Ctx);
}

export interface DocsLinkProps {
  anchor: string;
  children: ReactNode;
}

/** Inline docs deep-link: clicking opens the DocsSheet at `anchor` instead of
 * navigating. */
export function DocsLink({ anchor, children }: DocsLinkProps) {
  const { open } = useDocs();
  // A "Learn more" affordance with no destination is worse than none: when the
  // target section does not exist in the tuning reference, render nothing
  // rather than a link that scrolls nowhere. See KNOWN_DOC_ANCHORS in docs-config.ts.
  if (!isKnownDocAnchor(anchor)) return null;
  return (
    <a
      href={docsHref(docsUrl(anchor))}
      className="text-primary underline-offset-4 hover:underline"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        open(anchor);
      }}
    >
      {children}
    </a>
  );
}
