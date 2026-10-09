// @vitest-environment node
// Hit-area floor for the docs theme: footnote markers and heading permalinks keep their visual
// size and reach a 24px target through an overlay declared in the theme stylesheet.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const css = readFileSync(path.join(import.meta.dirname, '../docs-site/.vitepress/theme/custom.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block of the first rule whose selector list contains `selector`. */
function ruleFor(selector) {
  const rule = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, selectors]) =>
    selectors.split(',').some((s) => s.trim() === selector),
  );
  expect(rule, `no rule for ${selector}`).toBeTruthy();
  return rule[2];
}

describe('docs hit-area floor', () => {
  for (const selector of ['.citation-chip::after', '.vp-doc .header-anchor::after']) {
    test(`${selector} overlay reaches 24px in both axes`, () => {
      const block = ruleFor(selector);
      expect(block).toMatch(/min-width:\s*24px/);
      expect(block).toMatch(/min-height:\s*24px/);
      expect(block).toMatch(/position:\s*absolute/);
    });
  }

  test('footnote markers anchor the overlay', () => {
    expect(ruleFor('.citation-chip')).toMatch(/position:\s*relative/);
  });
});
