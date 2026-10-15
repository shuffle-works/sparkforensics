// @vitest-environment node
// Docs home and brand checks that run the real consumers: gray-matter-style frontmatter parsed
// with js-yaml, the home hero styled by the docs stylesheet in JSDOM, and the app's own icon
// component rendered next to the docs header logo assets.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { load as loadYaml } from 'js-yaml';
import { Activity } from 'lucide-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import docsConfig from '../docs-site/.vitepress/config.ts';
import { installStylesheet, resolvedColor } from './view/_shared/css-contrast.ts';

const docsSite = path.join(import.meta.dirname, '../docs-site');
const docsCss = path.join(docsSite, '.vitepress/theme/custom.css');

const frontmatter = loadYaml(/^---\n([\s\S]*?)\n---/.exec(readFileSync(path.join(docsSite, 'index.md'), 'utf8'))[1]);

describe('docs home cards', () => {
  it('has one card for every top-level section in the nav', () => {
    const sections = docsConfig.themeConfig.nav.filter((item) => item.link !== '/..').map((item) => item.link);
    expect(frontmatter.features.map((card) => card.link)).toEqual(sections);
  });

  it('gives every card a title, a description and a link label', () => {
    for (const card of frontmatter.features) {
      expect(card).toEqual({
        title: expect.any(String),
        details: expect.any(String),
        link: expect.any(String),
        linkText: expect.any(String),
      });
    }
  });
});

describe('docs home hero', () => {
  const { document } = new JSDOM().window;
  let name;
  let text;

  beforeAll(() => {
    installStylesheet(document, docsCss);
    const hero = document.createElement('div');
    hero.className = 'VPHero';
    hero.innerHTML = `<h1><span class="name">${frontmatter.hero.name}</span><span class="text">${frontmatter.hero.text}</span></h1>`;
    document.body.append(hero);
    name = hero.querySelector('.name');
    text = hero.querySelector('.text');
  });

  it.each(['light', 'dark'])('sets "Docs" in the ink color in the %s theme', (theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const ink = resolvedColor(document.documentElement, '--sf-ink');
    expect(resolvedColor(text, 'color')).toBe(ink);
  });

  it('sets "Docs" at a lighter weight than the name', () => {
    const weight = (el) => Number(document.defaultView.getComputedStyle(el).fontWeight);
    expect(weight(text)).toBeLessThan(weight(name));
  });
});

describe('docs header logo', () => {
  const appMark = new JSDOM(renderToStaticMarkup(createElement(Activity))).window.document.querySelector('svg');
  const appPaths = [...appMark.querySelectorAll('path')].map((p) => p.getAttribute('d'));

  it.each(['light', 'dark'])('draws the app mark in the ink color of the %s theme', (theme) => {
    const svg = readFileSync(path.join(docsSite, 'public', docsConfig.themeConfig.logo[theme]), 'utf8');
    const logo = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document.documentElement;
    expect([...logo.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual(appPaths);

    const { document } = new JSDOM().window;
    installStylesheet(document, docsCss);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    expect(logo.getAttribute('stroke')).toBe(resolvedColor(document.documentElement, '--sf-ink'));
  });
});
