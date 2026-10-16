/** DOM markers the host site's publish step injects into the static HTML shell
 * before this app's script runs (see "The docs site's anchor clicks" in
 * docs-site/contributor-guide/development-setup.md). */
export const PRODUCT_BAR_SELECTOR = '[data-shuffle-product-bar]';
export const HUB_FOOTER_SELECTOR = '[data-shuffle-footer]';

export function getSharedProductBar(): Element | null {
  return document.querySelector(PRODUCT_BAR_SELECTOR);
}

export function hasHubFooter(): boolean {
  return document.querySelector(HUB_FOOTER_SELECTOR) !== null;
}
