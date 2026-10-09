// @vitest-environment node
// WCAG guard for docs-site code-block comments: renders a fenced block through VitePress's own
// Markdown renderer (Shiki, github-light/github-dark), applies the docs theme stylesheet and
// measures the comment token against the code block background in both themes. Node environment
// with its own JSDOM: VitePress bundles esbuild, which refuses to load under the jsdom environment.
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, test } from 'vitest';
import { createMarkdownRenderer } from 'vitepress';
import { contrastRatio, installStylesheet, resolvedColor } from './view/_shared/css-contrast.ts';

const docsSrc = path.join(import.meta.dirname, '../docs-site');
const docsCss = path.join(import.meta.dirname, '../docs-site/.vitepress/theme/custom.css');

const { document } = new JSDOM().window;
let block;
let comment;

beforeAll(async () => {
  const md = await createMarkdownRenderer(docsSrc, {}, '/');
  installStylesheet(document, docsCss);
  const page = document.createElement('div');
  page.className = 'vp-doc';
  page.innerHTML = md.render('```sh\n# Speculatively relaunch straggler tasks\nspark.speculation true\n```\n');
  document.body.append(page);
  block = page.querySelector("div[class*='language-']");
  comment = [...page.querySelectorAll('.line span')].find((el) => el.textContent.startsWith('#'));
});

describe('docs code-block comment color', () => {
  test.each([
    ['light', '--shiki-light'],
    ['dark', '--shiki-dark'],
  ])('the comment has at least 5:1 on the %s code block background', (theme, variable) => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    expect(comment, 'rendered comment token').toBeDefined();
    const ratio = contrastRatio(resolvedColor(comment, variable), resolvedColor(block, '--vp-code-block-bg'));
    expect(ratio).toBeGreaterThanOrEqual(5);
  });
});
