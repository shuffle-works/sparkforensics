import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import docsConfig from '../docs-site/.vitepress/config.ts';

const docsSite = path.join(import.meta.dirname, '../docs-site');
const home = readFileSync(path.join(docsSite, 'index.md'), 'utf8');
const css = readFileSync(path.join(docsSite, '.vitepress/theme/custom.css'), 'utf8');
const featureLinks = [...home.matchAll(/^\s+link: (\S+)$/gm)].map((m) => m[1]);

describe('docs home', () => {
  it('has one card for every top-level section in the nav', () => {
    const sections = docsConfig.themeConfig.nav.filter((item) => item.link !== '/..').map((item) => item.link);
    expect(featureLinks).toEqual(sections);
  });

  it('sets the title "Docs" in the ink color at a lighter weight than the name', () => {
    const rule = (selector) => css.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`))?.[0] ?? '';
    const weight = (block) => Number(block.match(/font-weight:\s*(\d+)/)?.[1]);
    expect(rule('\\.VPHero \\.text')).toMatch(/color:\s*var\(--sf-ink\)/);
    expect(weight(rule('\\.VPHero \\.text'))).toBeLessThan(weight(rule('\\.VPHero \\.name')));
  });
});

describe('docs header logo', () => {
  const { logo } = docsConfig.themeConfig;

  it.each(['light', 'dark'])('uses the app pulse-line mark in the %s theme', (theme) => {
    const svg = readFileSync(path.join(docsSite, 'public', logo[theme].replace(/^\//, '')), 'utf8');
    // lucide's Activity icon, the mark the app header renders.
    expect(svg).toContain('M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36');
  });
});
