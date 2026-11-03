/** DOM markers the host site's publish step injects into the static HTML shell
 * before this app's script runs (see "The docs site's anchor clicks" in
 * docs-site/contributor-guide/development-setup.md). */
export const PRODUCT_BAR_SELECTOR = '[data-shuffle-product-bar]';
export const HUB_FOOTER_SELECTOR = '[data-shuffle-footer]';

export function getSharedProductBar(): Element | null {
  // The host site's markup is outside this app, so only the page can say whether it is there.
  // ast-grep-ignore: no-dom-routing
  return document.querySelector(PRODUCT_BAR_SELECTOR);
}

export function hasHubFooter(): boolean {
  // The host site's markup is outside this app, so only the page can say whether it is there.
  // ast-grep-ignore: no-dom-routing
  return document.querySelector(HUB_FOOTER_SELECTOR) !== null;
}
