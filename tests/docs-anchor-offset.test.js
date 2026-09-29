// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The docs site inlines this script into every page's head (config.ts). jsdom
// has no layout, so each test stubs the geometry of the chrome it builds.
const source = readFileSync(resolve(import.meta.dirname, '../docs-site/.vitepress/anchor-offset.js'), 'utf8');
// Each run adds window listeners and a DOM observer; drop them after every
// test so one test's script instance can't react to the next test's chrome.
const listeners = [];
const observers = [];
const runScript = () => {
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, fn, opts) => {
    listeners.push([type, fn]);
    add(type, fn, opts);
  });
  const observe = MutationObserver.prototype.observe;
  vi.spyOn(MutationObserver.prototype, 'observe').mockImplementation(function (...args) {
    observers.push(this);
    observe.apply(this, args);
  });
  new Function(source)();
};

function chrome(html, { style, height = 0, bottom = 0 }) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  el.outerHTML = html;
  const node = document.body.lastElementChild;
  node.setAttribute('style', style);
  node.getClientRects = () => (node.style.display === 'none' ? [] : [{}]);
  node.getBoundingClientRect = () => ({ top: bottom - height, bottom });
  Object.defineProperty(node, 'offsetHeight', { configurable: true, get: () => height });
  return node;
}

const offset = () => document.documentElement.style.getPropertyValue('--sf-anchor-offset');

afterEach(() => {
  listeners.splice(0).forEach(([type, fn]) => window.removeEventListener(type, fn));
  observers.splice(0).forEach((observer) => observer.disconnect());
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('docs anchor offset', () => {
  it('reaches below VitePress\'s fixed nav and its sticky local nav', () => {
    chrome('<header class="VPNav"></header>', { style: 'position: fixed', height: 64, bottom: 64 });
    chrome('<div class="VPLocalNav"></div>', { style: 'position: sticky; top: 64px', height: 48, bottom: 112 });
    runScript();
    expect(offset()).toBe('136px');
  });

  it('measures the hub product bar where the hub hides VPNav', () => {
    chrome('<header data-shuffle-product-bar></header>', { style: 'position: sticky; top: 0px', height: 97, bottom: 97 });
    chrome('<header class="VPNav"></header>', { style: 'display: none', height: 0 });
    chrome('<div class="VPLocalNav"></div>', { style: 'position: sticky; top: 0px', height: 48, bottom: 48 });
    runScript();
    expect(offset()).toBe('121px');
  });

  it('ignores chrome that scrolls away with the page', () => {
    chrome('<header class="VPNav"></header>', { style: 'position: relative', height: 64, bottom: 64 });
    runScript();
    expect(offset()).toBe('24px');
  });

  it('adds the probe VitePress\'s router measures for its scroll offset', () => {
    runScript();
    expect(document.querySelectorAll('[data-sf-anchor-offset]')).toHaveLength(1);
  });

  it('re-places the hash heading when chrome grows under a reader parked on it', () => {
    history.replaceState(null, '', '#tuning');
    const localNav = chrome('<div class="VPLocalNav"></div>', { style: 'display: none', height: 0 });
    const heading = document.createElement('h2');
    heading.id = 'tuning';
    heading.getBoundingClientRect = () => ({ top: 24, bottom: 60 });
    document.body.appendChild(heading);
    const scrollIntoView = vi.fn();
    heading.scrollIntoView = scrollIntoView;
    runScript();

    localNav.style.cssText = 'position: sticky; top: 0px';
    Object.defineProperty(localNav, 'offsetHeight', { get: () => 48 });
    window.dispatchEvent(new Event('resize'));

    expect(offset()).toBe('72px');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('picks up chrome that mounts after start', async () => {
    chrome('<header class="VPNav"></header>', { style: 'position: fixed', height: 64, bottom: 64 });
    runScript();
    expect(offset()).toBe('88px');

    chrome('<div class="VPLocalNav"></div>', { style: 'position: sticky; top: 64px', height: 48, bottom: 112 });
    await Promise.resolve();
    expect(offset()).toBe('136px');
  });
});
