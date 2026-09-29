// Inlined into every docs page's head by config.ts. Plain JS, not part of
// the theme bundle, because the published Spark tuning reference ships with
// VitePress hydration stripped and would never run theme code.
//
// Keeps --sf-anchor-offset on the root element equal to how far down the
// page's pinned top chrome reaches, plus breathing room. Both scroll paths
// read it: custom.css turns it into scroll-padding-top for native fragment
// jumps (a deep link, an unhydrated page), and VitePress's router measures
// the [data-sf-anchor-offset] probe (config.ts `scrollOffset`) for the
// in-page links it intercepts. The chrome differs by build and width:
// VitePress's own nav and local nav locally, and on the published site the
// Shuffle Works product bar, which hides VPNav and can wrap onto several
// rows. So measure what is on screen instead of adding fixed heights.
(() => {
  // Assembled at runtime so the built page never contains the bar's marker
  // attribute: the hub greps page source for it to detect a page that
  // renders its own bar, and would then skip injecting one. A `+` of two
  // literals would not do, since VitePress minifies this script and folds it.
  const PRODUCT_BAR = `[${['data', 'shuffle', 'product', 'bar'].join('-')}]`;
  const PINNED_CHROME = `${PRODUCT_BAR}, .VPNav, .VPLocalNav`;
  const GAP_PX = 24; // VitePress's own default scrollOffset padding
  const root = document.documentElement;

  // Where an element's bottom edge sits once the reader has scrolled down: a
  // fixed bar stays where it is, a sticky one sticks at its `top`, anything
  // else scrolls away and covers nothing.
  const pinnedBottom = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || el.getClientRects().length === 0) return 0;
    if (style.position === 'fixed') return el.getBoundingClientRect().bottom;
    if (style.position === 'sticky') return (parseFloat(style.top) || 0) + el.offsetHeight;
    return 0;
  };

  const hashTarget = () => {
    try {
      return location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    } catch {
      return null; // malformed percent-encoding in the fragment
    }
  };

  let offset = null;
  const sync = () => {
    const bottoms = Array.from(document.querySelectorAll(PINNED_CHROME), pinnedBottom);
    const next = Math.ceil(Math.max(0, ...bottoms)) + GAP_PX;
    if (next === offset) return;
    const previous = offset;
    offset = next;
    root.style.setProperty('--sf-anchor-offset', `${offset}px`);

    // Chrome can grow after a jump already placed the heading, for example
    // VitePress's local nav, which appears only once hydration finds an
    // outline. If the reader is still parked where the old offset put the
    // hash's heading (the router lands it higher by its padding-top), place
    // it again so it doesn't end up underneath.
    const target = previous === null ? null : hashTarget();
    if (!target) return;
    const slack = (parseFloat(getComputedStyle(target).paddingTop) || 0) + 2;
    if (Math.abs(target.getBoundingClientRect().top - previous) <= slack) target.scrollIntoView();
  };

  const start = () => {
    const probe = document.createElement('div');
    probe.setAttribute('data-sf-anchor-offset', '');
    probe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(probe);
    sync();

    // The bar wraps as the viewport narrows, the hub's hoist script moves
    // controls into it, and hydration or the chrome toggle can show or hide
    // any of these, so resync whenever one of them changes size.
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(sync);
      document.querySelectorAll(PINNED_CHROME).forEach((el) => observer.observe(el));
    }
    window.addEventListener('resize', sync);
    window.addEventListener('load', sync);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
