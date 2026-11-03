// The messages the docs site and the app's frames exchange. Both sides are same-origin, so every
// post targets `window.location.origin` and every receipt checks the sender's origin and window.

/** What the docs page sends the example frame (docs-widget.html) when its theme changes. */
export type ThemeMessage = { type: 'sparkforensics:docs-theme'; theme: 'light' | 'dark' };
/** What the example frame sends the docs page: its content height in CSS pixels. */
export type HeightMessage = { type: 'sparkforensics:docs-widget-height'; height: number };
/** What a framed docs page sends the app when it sees Esc that it does not consume itself. */
export type EscapeMessage = { type: 'sparkforensics:docs-escape' };

export type DocsFrameMessage = ThemeMessage | HeightMessage | EscapeMessage;

export function isDocsFrameMessage(data: unknown): data is DocsFrameMessage {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case 'sparkforensics:docs-theme':
      return message.theme === 'light' || message.theme === 'dark';
    case 'sparkforensics:docs-widget-height':
      return typeof message.height === 'number' && Number.isFinite(message.height);
    case 'sparkforensics:docs-escape':
      return true;
    default:
      return false;
  }
}

/** Posts `message` to a frame's window. */
export function postToFrame(frame: Window, message: DocsFrameMessage): void {
  frame.postMessage(message, window.location.origin);
}

/** Posts `message` to the page that frames this one. */
export function postToParent(message: DocsFrameMessage): void {
  window.parent.postMessage(message, window.location.origin);
}

/** The message in `event` when it came from `source` on this origin, else null. */
export function receiveDocsFrameMessage(event: MessageEvent, source: Window | null | undefined): DocsFrameMessage | null {
  if (event.origin !== window.location.origin || !source || event.source !== source) return null;
  return isDocsFrameMessage(event.data) ? event.data : null;
}
