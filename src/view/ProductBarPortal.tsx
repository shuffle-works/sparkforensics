import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getSharedProductBar } from '@/view/shuffle-hub';

/**
 * Portals `children` into the Shuffle Works hub's shared product bar when
 * this build is running published under the hub, so this page's own header
 * controls merge onto the shared row instead of stacking a second bar
 * underneath it. A vanilla DOM relocation (the technique the hub uses for a
 * static page) would strand these controls' event handlers outside React's
 * root once moved, so this is a real portal, not a DOM move. See
 * docs/product-bar-contract.md in shuffle-works-site for the full contract.
 * Falls back to rendering `children` in place, unchanged, when the hub
 * markup isn't present (a standalone dev server or build).
 *
 * The bar is queried once per render rather than tracked with state: the
 * contract guarantees it's static HTML already in the DOM before this
 * app's own script runs, and nothing afterward replaces that node.
 */
export function ProductBarPortal({ className, children }: { className?: string; children: ReactNode }) {
  const bar = getSharedProductBar();
  if (bar) return createPortal(<div data-shuffle-page-controls>{children}</div>, bar);
  return <div className={className} data-shuffle-page-controls>{children}</div>;
}
