// The docs page frames this app from the same origin: the page owns the theme and the frame's
// height, so the app follows the first and reports the second.

/** Message the app posts to the docs page with its content height in CSS pixels. */
export const HEIGHT_MESSAGE = 'sparkforensics:docs-widget-height';

type Theme = 'light' | 'dark';

function hostRoot(): HTMLElement | null {
  try {
    return window.parent !== window ? window.parent.document.documentElement : null;
  } catch {
    return null; // a cross-origin host
  }
}

/** The docs page's theme (it mirrors it on `data-theme`), or null when nothing frames the app. */
export function hostTheme(): Theme | null {
  const theme = hostRoot()?.dataset.theme;
  return theme === 'light' || theme === 'dark' ? theme : null;
}

/** Calls `apply` with the docs page's theme each time it changes. */
export function followHostTheme(apply: (theme: Theme) => void): void {
  const root = hostRoot();
  if (!root) return;
  new MutationObserver(() => {
    const theme = hostTheme();
    if (theme) apply(theme);
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}

/** Tells the docs page how tall `element` is now and whenever it resizes. */
export function reportHeight(element: HTMLElement): void {
  if (window.parent === window) return;
  const post = () => window.parent.postMessage(
    { type: HEIGHT_MESSAGE, height: Math.ceil(element.getBoundingClientRect().height) },
    window.location.origin,
  );
  new ResizeObserver(post).observe(element);
  post();
}
