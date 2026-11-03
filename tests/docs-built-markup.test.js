// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { build } from 'vitepress';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The accessibility and shared-bar markup of the docs header must be in the built HTML, rendered by
// the component overrides (docs-site/.vitepress/theme/overrides/) that config.ts aliases in, not
// added to the page after it renders. The site here is a minimal one built with that real config.
const repoRoot = path.join(import.meta.dirname, '..');
const configPath = path.join(repoRoot, 'docs-site/.vitepress/config.ts');

let site;
let root;
const page = (name) => new JSDOM(readFileSync(path.join(root, '.vitepress/dist', name), 'utf8')).window.document;

beforeAll(async () => {
  // Inside the repo so the generated config and theme resolve `vitepress` from its node_modules.
  const cache = path.join(repoRoot, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  site = mkdtempSync(path.join(cache, 'docs-built-markup-'));
  root = site;
  mkdirSync(path.join(root, '.vitepress/theme'), { recursive: true });
  writeFileSync(path.join(root, 'index.md'), '---\nlayout: home\n---\n');
  writeFileSync(path.join(root, 'guide.md'), '# Guide\n\n## Section\n');
  writeFileSync(
    path.join(root, '.vitepress/config.mts'),
    `import config from ${JSON.stringify(configPath)};\nexport default { vite: config.vite };\n`,
  );
  writeFileSync(
    path.join(root, '.vitepress/theme/index.mts'),
    "import DefaultTheme from 'vitepress/theme-without-fonts';\nexport default DefaultTheme;\n",
  );
  await build(root);
}, 120000);

afterAll(() => rmSync(site, { recursive: true, force: true }));

describe('docs header markup in the built HTML', () => {
  it('marks every appearance switch wrapper as page controls', () => {
    const document = page('guide.html');
    expect(document.querySelectorAll('.VPNavBarAppearance[data-shuffle-page-controls]')).toHaveLength(1);
    expect(document.querySelectorAll('.VPNavBarExtra .appearance-action[data-shuffle-page-controls]')).toHaveLength(1);
  });

  it('labels each appearance switch', () => {
    const switches = page('guide.html').querySelectorAll('.VPSwitchAppearance');
    expect(switches.length).toBeGreaterThan(0);
    for (const el of switches) expect(el.getAttribute('aria-label')).toBe('Dark theme');
  });

  it('gives the home page a main landmark', () => {
    expect(page('index.html').querySelector('.VPHome').getAttribute('role')).toBe('main');
  });
});
