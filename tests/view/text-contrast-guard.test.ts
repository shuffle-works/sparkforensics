// WCAG AA guard (4.5:1) for text whose color is set outside component code: the chart legend
// label and the docs-site code-block comment. Recomputes ratios from the stylesheets.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, describe } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const appCss = read('../../src/index.css');
const docsCss = read('../../docs-site/.vitepress/theme/custom.css');

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Declared hex value of `--name` inside the first block opened by `selector`. */
function token(css: string, selector: string, name: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`${selector} not found`);
  const block = css.slice(start, css.indexOf('}', start));
  const m = block.match(new RegExp(`--${name}\\s*:\\s*(?:var\\([^,]+,\\s*)?(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`--${name} not found in ${selector}`);
  return m[1];
}

describe('chart legend label color', () => {
  test('the stylesheet overrides the inline series color with the text token', () => {
    const rule = appCss.match(/\.recharts-legend-item-text\s*\{([^}]*)\}/);
    expect(rule, 'rule for .recharts-legend-item-text').not.toBeNull();
    expect(rule![1]).toMatch(/color:\s*var\(--text\)\s*!important/);
  });

  test.each([
    ['dark', ':root {', ':root {'],
    ['light', ':root[data-theme="light"] {', ':root[data-theme="light"] {'],
  ])('text token has 4.5:1 on the %s panel and canvas', (_theme, textSel, surfSel) => {
    const text = token(appCss, textSel, 'text');
    for (const surface of ['surface', 'bg']) {
      expect(contrast(text, token(appCss, surfSel, surface))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('docs code-block comment color', () => {
  test('the override replaces the Shiki comment color in both themes', () => {
    const rule = docsCss.match(/span\[style\*='--shiki-light:#6A737D'\]\s*\{([^}]*)\}/);
    expect(rule, 'comment override rule').not.toBeNull();
    expect(rule![1]).toMatch(/--shiki-light:\s*var\(--sf-muted\)\s*!important/);
    expect(rule![1]).toMatch(/--shiki-dark:\s*var\(--sf-muted\)\s*!important/);
  });

  test.each([
    ['light', ':root {'],
    ['dark', '.dark {'],
  ])('muted token has at least 5:1 on the %s code block surface', (_theme, selector) => {
    const ratio = contrast(token(docsCss, selector, 'sf-muted'), token(docsCss, selector, 'sf-surface-2'));
    expect(ratio).toBeGreaterThanOrEqual(5);
  });
});
