// The docs page frames this app from the same origin: it owns the theme and the frame's height, so
// the app reads the first from its URL and from `theme` messages, and reports the second.
import { postToParent, receiveDocsFrameMessage } from './frame-messages';

type Theme = 'light' | 'dark';

/** The theme the docs page put in the frame's `theme` query parameter, or null when it gave none. */
export function hostTheme(): Theme | null {
  const theme = new URLSearchParams(window.location.search).get('theme');
  return theme === 'light' || theme === 'dark' ? theme : null;
}

/** Calls `apply` with the docs page's theme each time it sends one. */
export function followHostTheme(apply: (theme: Theme) => void): void {
  if (window.parent === window) return;
  window.addEventListener('message', (event) => {
    const message = receiveDocsFrameMessage(event, window.parent);
    if (message?.type === 'sparkforensics:docs-theme') apply(message.theme);
  });
}

/** Tells the docs page how tall `element` is now and whenever it resizes. */
export function reportHeight(element: HTMLElement): void {
  if (window.parent === window) return;
  const post = () => postToParent({
    type: 'sparkforensics:docs-widget-height',
    height: Math.ceil(element.getBoundingClientRect().height),
  });
  new ResizeObserver(post).observe(element);
  post();
}
