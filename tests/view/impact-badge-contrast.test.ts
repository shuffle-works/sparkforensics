// WCAG AA contrast guard for the light-theme impact badge palette: badge text is the impact
// color over a 10% tint of itself composited on each light surface. Recomputes that from
// src/index.css and asserts the 4.5:1 minimum; the dark theme is intentionally not checked.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, describe } from 'vitest';

const css: string = readFileSync(fileURLToPath(new URL('../../src/index.css', import.meta.url)), 'utf8');

/** The `:root[data-theme="light"] { ... }` block: the light palette. */
function lightThemeBlock(): string {
  const match = css.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/);
  if (!match) throw new Error('light theme block not found in src/index.css');
  return match[1];
}

function lightVar(name: string): string {
  const match = lightThemeBlock().match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  if (!match) throw new Error(`--${name} not found in light theme block`);
  return match[1].trim();
}

type Rgb = [number, number, number];

function hexToRgb(value: string): Rgb {
  // Neutrals may be var(--color-x, #hex) aliases; the fallback hex is what renders standalone, so resolve it.
  const aliased = value.match(/^var\([^,]+,\s*(#[0-9a-f]{6})\s*\)$/i);
  const hex = aliased ? aliased[1] : value;
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`expected 6-digit hex color, got ${value}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** WCAG 2.x relative luminance of an sRGB color. */
function relativeLuminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Alpha-composite `fg` at `alpha` over an opaque `bg`. */
function composite(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as Rgb;
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const IMPACTS = ['critical', 'warning', 'info', 'clean'] as const;
// Every opaque light surface a badge can sit on.
const SURFACES = ['surface', 'bg', 'surface-2'] as const;
// Badge background is the impact color at 10% opacity (`bg-<impact>/10`).
const BADGE_TINT_ALPHA = 0.1;

describe('light-theme impact badge text contrast (WCAG AA)', () => {
  for (const impact of IMPACTS) {
    for (const surface of SURFACES) {
      test(`${impact} text on its 10% tint over --${surface} is >= 4.5:1`, () => {
        const text = hexToRgb(lightVar(impact));
        const badgeBg = composite(text, hexToRgb(lightVar(surface)), BADGE_TINT_ALPHA);
        expect(contrastRatio(text, badgeBg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe('light-theme dim tints stay derived from the impact base colors', () => {
  // --crit-dim/--warn-dim/--info-dim mirror bg-<impact>/10; their RGB must not fork from the base impact color.
  const DIM_VAR: Record<(typeof IMPACTS)[number], string> = {
    critical: 'crit-dim',
    warning: 'warn-dim',
    info: 'info-dim',
    clean: 'clean-dim',
  };
  for (const impact of IMPACTS) {
    test(`--${DIM_VAR[impact]} RGB matches --${impact}`, () => {
      const dim = lightVar(DIM_VAR[impact]).match(/^rgba\((\d+),(\d+),(\d+),/);
      if (!dim) throw new Error(`--${DIM_VAR[impact]} is not an rgba() value`);
      expect([Number(dim[1]), Number(dim[2]), Number(dim[3])]).toEqual(hexToRgb(lightVar(impact)));
    });
  }
});
