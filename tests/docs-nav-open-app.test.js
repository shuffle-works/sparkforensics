import { describe, expect, it } from 'vitest';
import docsConfig from '../docs-site/.vitepress/config.ts';

// VitePress's withBase (client/app/utils): prefix a root-relative nav link with
// the site base, collapsing repeated slashes.
const withBase = (base, path) => `${base}${path}`.replace(/\/+/g, '/');

describe('docs header "Open app" link', () => {
  const { nav } = docsConfig.themeConfig;
  const openApp = nav.find((item) => item.text === 'Open app');

  it('is a nav entry, so desktop and the phone menu both render it', () => {
    expect(openApp).toBeDefined();
  });

  it('opts out of VitePress client-side routing', () => {
    // An in-docs route would 404; a target attribute makes the router skip it.
    expect(openApp.target).toBe('_self');
  });

  it.each([
    ['/docs/', '/docs/user-guide/getting-started.html', '/'],
    ['/docs/', '/docs/tuning-reference/', '/'],
    ['/hub/docs/', '/hub/docs/user-guide/getting-started.html', '/hub/'],
  ])('resolves under base %s to the app root from %s', (base, page, appRoot) => {
    const href = withBase(base, openApp.link);
    expect(new URL(href, `http://example.test${page}`).pathname).toBe(appRoot);
  });
});
