// Computed-color helpers for WCAG contrast tests: load a real stylesheet into the jsdom document,
// resolve the color an element ends up with, and measure the ratio between two colors.
import { readFileSync } from 'node:fs';

/**
 * Appends the stylesheet at `path` to `doc` and returns a remover. `@import` lines are dropped:
 * jsdom cannot fetch them, and they hold no rules the callers assert on.
 */
export function installStylesheet(doc: Document, path: string): () => void {
  const style = doc.createElement('style');
  style.textContent = readFileSync(path, 'utf8').replace(/^@import[^;]*;$/gm, '');
  doc.head.append(style);
  return () => style.remove();
}

/**
 * The hex color `property` resolves to on `el`. jsdom applies the cascade (including `!important`
 * over inline styles) and inherits custom properties but leaves `var()` unresolved, so each
 * `var(--name, fallback)` is substituted from the element's computed custom properties here.
 */
export function resolvedColor(el: Element, property: string): string {
  const style = el.ownerDocument.defaultView!.getComputedStyle(el);
  let value = style.getPropertyValue(property).trim();
  for (let depth = 0; value.startsWith('var(') && depth < 10; depth++) {
    const m = value.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
    if (!m) break;
    value = style.getPropertyValue(m[1]).trim() || (m[2] ?? '').trim();
  }
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${property} did not resolve to a hex color: ${value}`);
  return value.toLowerCase();
}

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** WCAG 2.x relative luminance of an sRGB color. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
