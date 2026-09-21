import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useTheme } from '@/theme/ThemeProvider';
import { useDocs } from '@/view/DocsContext';

/** What's currently loaded in the iframe: the resolved `path` and the theme
 * the load was made with. A docs-site page has no live channel back to this
 * app, so it only reads its light/dark preference once, from localStorage,
 * as it boots (see ThemeProvider). Tracking `theme` here lets a later toggle
 * reload the iframe so it picks up the fresh value. */
type LoadedTarget = { kind: 'site'; path: string; theme: 'dark' | 'light' };

/** Width of the resize handle (Tailwind w-1.5). Added to the published inset so
 * the dashboard's reserved gutter clears the separator too, not just the panel. */
const SEPARATOR_PX = 6;

/** Preferred minimum width of the docs panel (px). */
const PANEL_MIN_PX = 320;
/** Fraction of the viewport the panel may occupy at most: keep in sync with
 * the `maxSize="90vw"` prop on the docs <Panel> below. */
const PANEL_MAX_VIEWPORT_FRACTION = 0.9;

function subscribeToWindowResize(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

/** The panel's effective minimum width: the preferred 320px, clamped so it
 * never exceeds the effective `90vw` maximum. react-resizable-panels resolves
 * numbers as px and `vw` strings against window.innerWidth (no CSS `min()`
 * support), so on viewports under ~356px a hard 320px minimum would exceed
 * the maximum and make the constraints unsatisfiable. `Math.floor` keeps the
 * clamp at or below the library's own `90vw` resolution under rounding. */
function clampedPanelMinSize(): number {
  return Math.min(PANEL_MIN_PX, Math.floor(window.innerWidth * PANEL_MAX_VIEWPORT_FRACTION));
}

/** A docs-site page picks its light/dark mode once, from the
 * `vitepress-theme-appearance` localStorage key kept current by
 * ThemeProvider, the moment it loads. There's no live channel to re-push a
 * theme change into an already-loaded iframe. Re-assigning the exact same
 * `src` string wouldn't make the browser reload it, so a `t=<theme>` marker
 * is threaded in ahead of any `#anchor` purely to change the string and
 * force a real reload; the page never reads this param itself. */
function siteFrameSrc(path: string, theme: 'dark' | 'light'): string {
  const hashIndex = path.indexOf('#');
  const base = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : path.slice(hashIndex);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}t=${theme}${hash}`;
}

/** The docs slide-in panel: a shadcn Sheet wrapping the docs iframe. Mount
 * once inside <DocsProvider>. Radix (base-ui) owns focus/inert/ESC. */
export function DocsSheet() {
  const { isOpen, target, close } = useDocs();
  const { theme } = useTheme();

  // Viewport-clamped minimum: re-reads on window resize so the constraint
  // stays satisfiable while the sheet is open (the library re-resolves the
  // `90vw` maximum at layout time, so the minimum must follow).
  const panelMinSize = useSyncExternalStore(subscribeToWindowResize, clampedPanelMinSize);

  const currentTargetRef = useRef<LoadedTarget | null>(null);
  // The iframe's `src` is driven declaratively (not via a ref mutation) so it
  // doesn't race the Sheet portal mounting the iframe a commit after `isOpen`
  // flips true: React applies whatever `loadedSrc` holds once the node
  // exists, no matter when that happens.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  // The docs panel is a fixed overlay, so the dashboard can't reflow around it
  // on its own. Publish the panel's live width as a CSS variable
  // (--docs-inset); the dashboard root reserves that much right-padding, so the
  // board shrinks into the remaining space and no widget hides behind the docs.
  // A ref callback + ResizeObserver (not React state) keeps drag-resize free of
  // re-renders and survives the panel mounting a commit after `isOpen` flips.
  const roRef = useRef<ResizeObserver | null>(null);
  const measurePanel = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!node) {
      document.documentElement.style.setProperty('--docs-inset', '0px');
      return;
    }
    const update = () =>
      document.documentElement.style.setProperty(
        '--docs-inset',
        `${node.getBoundingClientRect().width + SEPARATOR_PX}px`,
      );
    const ro = new ResizeObserver(update);
    ro.observe(node);
    update();
    roRef.current = ro;
  }, []);

  // Drive the iframe. A docs-site page has no channel back to this app (it's
  // a plain static page), so any change to the resolved path or the theme
  // just reassigns `src` outright, forcing a full reload via the `t=` marker
  // (see siteFrameSrc).
  useEffect(() => {
    if (!isOpen) {
      currentTargetRef.current = null;
      setLoadedSrc(null);
      return;
    }

    const path = target.path;
    const loaded = currentTargetRef.current;
    if (loaded && loaded.path === path && loaded.theme === theme) return;
    currentTargetRef.current = { kind: 'site', path, theme };
    setLoadedSrc(siteFrameSrc(path, theme));
  }, [isOpen, target, theme]);

  // Same panel, same chrome, either way; only the title admits which doc
  // source is loaded: the tuning-reference glossary, or a guide page. Read the
  // explicit `source` set by the entry point (open vs openSite), not the path
  // shape, so a guide that deep-links into the tuning reference stays "Guide".
  const panelLabel = target.source === 'reference' ? 'Reference' : 'Guide';

  return (
    // Non-modal + no backdrop: the dashboard stays fully visible, un-blurred,
    // and interactive alongside the docs panel. disablePointerDismissal keeps
    // the panel open while the user works in the dashboard (only the X or ESC
    // closes it). base-ui still owns focus-in, focus-restore, and ESC.
    //
    // z-[60] sits the whole panel above any other modal's backdrop (dialogs
    // use z-50) so, e.g., the stage-detail dialog's backdrop-blur dims the
    // dashboard behind it without also blurring these docs.
    <Dialog.Root
      open={isOpen}
      modal={false}
      disablePointerDismissal
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        {/* Full-viewport, click-through shell: the left (spacer) panel is
         * transparent and pointer-events-none so the dashboard underneath
         * stays clickable; only the resize handle and the docs panel capture
         * pointer events. The Separator uses pointer capture, so dragging over
         * the iframe no longer loses the pointer stream. */}
        <Dialog.Popup
          data-slot="docs-panel"
          className="pointer-events-none fixed inset-0 z-[60]"
        >
          <Group orientation="horizontal" className="h-full w-full">
            <Panel minSize="10%" className="pointer-events-none" />
            <Separator
              aria-label="Resize docs panel"
              className="pointer-events-auto w-1.5 cursor-col-resize bg-border/60 transition-colors hover:bg-primary/50 data-dragging:bg-primary/50"
            />
            <Panel defaultSize={576} minSize={panelMinSize} maxSize="90vw" className="pointer-events-auto">
              <div
                ref={measurePanel}
                className="flex h-full flex-col border-l border-border bg-popover text-sm text-popover-foreground shadow-lg"
              >
                <div className="flex items-center justify-between border-b border-border p-4">
                  <Dialog.Title className="font-heading text-base font-medium text-foreground">
                    {panelLabel}
                  </Dialog.Title>
                  <Dialog.Close render={<Button variant="ghost" size="icon-sm" />}>
                    <XIcon aria-hidden="true" />
                    <span className="sr-only">Close</span>
                  </Dialog.Close>
                </div>
                <iframe
                  src={loadedSrc ?? undefined}
                  title={panelLabel}
                  className="w-full flex-1 border-0"
                />
              </div>
            </Panel>
          </Group>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
