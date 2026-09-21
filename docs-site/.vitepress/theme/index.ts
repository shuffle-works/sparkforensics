import DefaultTheme from 'vitepress/theme';
import { inBrowser, useData, type Theme } from 'vitepress';
import { watch } from 'vue';
import TuningLanding from './TuningLanding.vue';
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
  enhanceApp({ app }) {
    app.component('TuningLanding', TuningLanding);

    if (!inBrowser) return; // this hook also runs during SSR's data pass

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

      // Mark VitePress's own appearance-switch control so a hub-owned
      // script (not part of this repo) can find and relocate/merge it into
      // a shared nav bar later, instead of this site showing two toggle
      // buttons side by side once that shared bar wraps it. VitePress
      // renders up to three copies at once, shown/hidden by breakpoint via
      // CSS rather than v-if: `.VPNavBarAppearance` (wide viewports),
      // `.VPNavBarExtra .appearance-action` (medium, inside the "extra"
      // flyout), `.VPNavScreenAppearance` (narrow, inside the full mobile
      // nav screen, which only mounts once the hamburger is opened) - so
      // keep watching rather than marking once.
      const markAppearanceSwitch = () => {
        document
          .querySelectorAll(
            '.VPNavBarAppearance, .VPNavScreenAppearance, .VPNavBarExtra .appearance-action',
          )
          .forEach((el) => {
            if (!el.hasAttribute('data-shuffle-page-controls')) {
              el.setAttribute('data-shuffle-page-controls', '');
            }
          });
      };
      markAppearanceSwitch();
      const switchMountObserver = new MutationObserver(markAppearanceSwitch);
      switchMountObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  },
};

export default theme;
