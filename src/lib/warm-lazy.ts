/**
 * Starts loading `React.lazy` components ahead of their first render. A lazy component that has
 * not been read yet suspends on its first render even when its chunk is already cached, and the
 * fallback that commit shows stays on screen for at least 300 ms (React's Suspense reveal
 * throttle). Reading each component's initializer here starts the chunk fetch, and React marks
 * the component resolved when the chunk arrives, so a later render shows the real content at once.
 *
 * `_init` and `_payload` are React's own fields on a lazy component. When they are absent the
 * call does nothing and the component loads on first render as usual.
 */
export function warmLazy(...components: unknown[]): void {
  for (const component of components) {
    const lazy = component as { _init?: (payload: unknown) => unknown; _payload?: unknown };
    try {
      lazy._init?.(lazy._payload);
    } catch {
      // Still loading, which is the expected outcome here, or failed: the first render reads
      // the same state again and reports it through Suspense and the error boundary.
    }
  }
}
