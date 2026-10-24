// Unlayered CSS beats every Tailwind utility, so a margin on `.trace-eyebrow` there would silently
// cancel `mt-*`, `mb-*` and `space-y-*` on every eyebrow label.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../src/theme/${name}`, import.meta.url)), 'utf8');

test('.trace-eyebrow sets no margin, so its margin utilities apply', () => {
  for (const css of [read('board.css'), read('landing.css')]) {
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\.trace-eyebrow\b/.test(selector)) continue;
      expect(body, selector.trim()).not.toMatch(/(^|[;\s])margin(-[a-z]+)?\s*:/);
    }
  }
});
