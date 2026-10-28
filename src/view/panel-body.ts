/** True when an evidence panel's body shows no evidence: no text and no chart or table once what
 * only names the finding (its stage chip, stage name and call site) is set aside. */
export function isBlankPanelBody(body: HTMLElement): boolean {
  const clone = body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-panel-identity], button[aria-label^="Open details for Stage"]').forEach((node) => node.remove());
  return !clone.textContent?.trim() && clone.querySelector('svg:not([aria-hidden="true"]), table, canvas, img') == null;
}
