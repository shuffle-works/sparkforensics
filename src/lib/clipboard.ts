/** Copies plain text with a same-origin/no-permission fallback: the async
 * Clipboard API can be rejected by permissions or an embedding policy even
 * when `navigator.clipboard` exists, so fall through to the classic
 * hidden-textarea + execCommand('copy') dance rather than surfacing an error. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to the selection-based fallback below
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand('copy')) throw new Error('copy unavailable');
  } finally {
    textarea.remove();
  }
}
