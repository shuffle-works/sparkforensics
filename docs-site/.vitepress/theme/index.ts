// theme-without-fonts: skip VitePress's bundled Inter; Trace fonts load below.
import DefaultTheme from 'vitepress/theme-without-fonts';
import { inBrowser, useData, type Theme } from 'vitepress';
import { nextTick, watch } from 'vue';
import TuningLanding from './TuningLanding.vue';
import DetectorIndex from './DetectorIndex.vue';
import DetectorPage from './DetectorPage.vue';
import DetectorTypeList from './DetectorTypeList.vue';
import DetectorThresholds from './DetectorThresholds.vue';
import DetectorMcpExample from './DetectorMcpExample.vue';
import { setupCitationChips } from './citation-chips';
// Trace fonts, self-hosted (bundled woff2): the docs make no font request.
import '@fontsource-variable/instrument-sans/wdth.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './custom.css';

// Shared theme contract used by every surface in the product family (the
// hub, the SparkForensics app itself, the sibling "Spark Tuning Reference"
// docs site): a `"light" | "dark"` string in this localStorage key, mirrored
// onto a `data-theme` attribute on <html>. VitePress's own default theme
// persists dark mode independently (its own `vitepress-theme-appearance`
// localStorage key and a `.dark` class on <html>), so without this bridge
// toggling dark mode anywhere else in the family never carries into these
// docs, and vice versa.
const SHUFFLE_THEME_KEY = 'shuffle-works-theme';

function readSharedTheme(): 'light' | 'dark' | null {
  try {
    const stored = window.localStorage.getItem(SHUFFLE_THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null; // storage unavailable (private mode, etc.)
  }
}

function writeSharedTheme(isDark: boolean): void {
  const value = isDark ? 'dark' : 'light';
  try {
    window.localStorage.setItem(SHUFFLE_THEME_KEY, value);
  } catch {
    /* ignore unavailable storage */
  }
  document.documentElement.dataset.theme = value;
}

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app, router }) {
    app.component('TuningLanding', TuningLanding);
    app.component('DetectorIndex', DetectorIndex);
    app.component('DetectorPage', DetectorPage);
    app.component('DetectorTypeList', DetectorTypeList);
    app.component('DetectorThresholds', DetectorThresholds);
    app.component('DetectorMcpExample', DetectorMcpExample);

    if (!inBrowser) return; // this hook also runs during SSR's data pass

    // Wire citation chips after every client-side route change (each page
    // renders its own footnotes list from scratch).
    router.onAfterRouteChange = () => {
      nextTick(() => setupCitationChips());
    };

    // The very first page load doesn't go through that same hook usefully:
    // VitePress's client entry calls `onAfterRouteChange` for the initial
    // route too, but strictly before handing off to `app.mount()`, so at
    // that point there's no real DOM yet for `setupCitationChips()` to find
    // (confirmed live: a direct load or hard refresh of a tuning-reference
    // page left every footnote marker unwired). Wrap `app.mount` itself so
    // the chip pass also runs once mounting actually lands content in the
    // page, covering a bookmark, search hit, or refresh - not just in-app
    // navigation.
    const originalMount = app.mount.bind(app);
    app.mount = ((...args: Parameters<typeof app.mount>) => {
      const result = originalMount(...args);
      nextTick(() => setupCitationChips());
      return result;
    }) as typeof app.mount;

    // useData() injects from the app's Vue context; outside a component
    // setup() function (which enhanceApp is) that requires runWithContext.
    app.runWithContext(() => {
      const { isDark } = useData();

      // Adopt a theme already chosen elsewhere in the family before this
      // site's own first paint settles.
      const shared = readSharedTheme();
      if (shared) isDark.value = shared === 'dark';
      writeSharedTheme(isDark.value);

      // Whenever VitePress's own dark-mode state changes (its built-in
      // sun/moon toggle, OS-preference detection, etc.), mirror it out to
      // the shared contract so every other surface in the family follows.
      watch(isDark, (dark) => writeSharedTheme(dark));

      // An external toggle (e.g. a shared product-bar rendered outside this
      // app once the hub wraps this site) may set `data-theme` on <html>
      // directly, without going through VitePress at all. Reflect that into
      // `isDark` so this site's own styling (driven by the `.dark` class)
      // follows suit.
      const themeAttrObserver = new MutationObserver(() => {
        const attr = document.documentElement.dataset.theme;
        if (attr === 'light' || attr === 'dark') {
          const shouldBeDark = attr === 'dark';
          if (isDark.value !== shouldBeDark) isDark.value = shouldBeDark;
        }
      });
      themeAttrObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
    });
  },
};

export default theme;
