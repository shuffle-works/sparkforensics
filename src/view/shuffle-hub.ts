/** DOM markers the Shuffle Works hub's publish-time pipeline
 * (shuffle-works-site's scripts/sync-static-sites.sh) injects into the
 * static HTML shell before this app's own script runs. See
 * docs/product-bar-contract.md in shuffle-works-site for the contract this
 * file implements the app side of. */
export const PRODUCT_BAR_SELECTOR = '[data-shuffle-product-bar]';
export const HUB_FOOTER_SELECTOR = '[data-shuffle-footer]';

export function getSharedProductBar(): Element | null {
  return document.querySelector(PRODUCT_BAR_SELECTOR);
}

export function hasHubFooter(): boolean {
  return document.querySelector(HUB_FOOTER_SELECTOR) !== null;
}
