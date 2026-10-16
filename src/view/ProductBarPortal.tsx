import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getSharedProductBar } from '@/view/shuffle-hub';

/**
 * Portals `children` into the host site's shared product bar when this build is
 * published under it, so the header controls share its row. A real portal, not a
 * DOM move: relocating the nodes would strand their React event handlers. Falls
 * back to rendering in place when the bar markup is absent (dev server, standalone
 * build). The bar is static HTML present before this app's script runs, so it is
 * queried once per render rather than tracked in state.
 */
export function ProductBarPortal({ className, children }: { className?: string; children: ReactNode }) {
  const bar = getSharedProductBar();
  if (bar) return createPortal(<div data-shuffle-page-controls>{children}</div>, bar);
  return <div className={className} data-shuffle-page-controls>{children}</div>;
}
