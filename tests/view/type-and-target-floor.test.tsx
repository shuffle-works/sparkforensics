// @vitest-environment jsdom
// Type and hit-area floor for the dashboard: text a person reads is at least
// 12px (10px stays only on numeric chart tick labels), and short links and
// buttons reach a 24px hit area through the `tap-target-comfortable` overlay.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test, expect, describe } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ChartCopyBar } from '../../src/view/charts/ChartTheme';
import { TagBadge } from '../../src/view/ImpactBadge';

const SRC = join(process.cwd(), 'src');
const MIN_TEXT_PX = 12;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(path);
  }
  return out;
}

// The plan graph keeps its own node sizing and is not covered by this floor.
const files = sourceFiles(SRC)
  .filter((p) => !relative(SRC, p).startsWith('view/plan-graph/'))
  .map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, 'utf8') }));

/** Every `file:line: match | source line` for a pattern whose captured px size is below the floor. */
function undersized(pattern: RegExp, sizeGroup = 1): string[] {
  const hits: string[] = [];
  for (const { rel, text } of files) {
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(pattern)) {
        if (parseFloat(m[sizeGroup]) < MIN_TEXT_PX) hits.push(`${rel}:${i + 1}: ${m[0]} | ${line.trim()}`);
      }
    });
  }
  return hits;
}

describe('text size floor', () => {
  test('no Tailwind arbitrary text size below 12px', () => {
    expect(undersized(/\btext-\[(\d+(?:\.\d+)?)px\]/g)).toEqual([]);
  });

  test('no CSS font-size or font shorthand below 12px outside the verdict strip axis ticks', () => {
    const hits = [
      ...undersized(/font-size:\s*(\d+(?:\.\d+)?)px/g),
      ...undersized(/font:\s*(?:[\w-]+\s+)*?(\d+(?:\.\d+)?)px\//g),
    ].filter((h) => !h.includes('.verdict-strip__axis'));
    expect(hits).toEqual([]);
  });

  test('chart text below 12px is limited to numeric tick labels', () => {
    const hits = undersized(/(?:tick=\{\{\s*)?fontSize:\s*(\d+(?:\.\d+)?)/g).filter((h) => !/tick=\{\{ fontSize: 10\b/.test(h));
    expect(hits).toEqual([]);
  });
});

describe('hit-area floor', () => {
  const css = readFileSync(join(SRC, 'index.css'), 'utf8');

  test('the tap-target overlay reaches 24px for every pointer, not only coarse ones', () => {
    // The base rule sits outside the `(pointer: coarse)` media block.
    const base = css.match(/\.tap-target-comfortable::after\s*\{([^}]*)\}/);
    expect(base).not.toBeNull();
    expect(base![1]).toMatch(/min-width:\s*24px/);
    expect(base![1]).toMatch(/min-height:\s*24px/);
    const coarseStart = css.indexOf('@media (pointer: coarse)');
    expect(css.indexOf(base![0])).toBeLessThan(coarseStart);
  });

  test('the chart Table and Copy actions carry the overlay', () => {
    render(<ChartCopyBar caption="c" columns={['a']} rows={[[1]]} />);
    expect(screen.getByRole('button', { name: /table/i }).className).toContain('tap-target-comfortable');
    expect(screen.getByRole('button', { name: /copy/i }).className).toContain('tap-target-comfortable');
  });

  test('a tag pill that links to docs carries the overlay and is not clipped by the badge', () => {
    render(<TagBadge type="skew" impactBand="warning" />);
    const pill = screen.getByText('SKEW').closest('a');
    expect(pill).not.toBeNull();
    expect(pill!.className).toContain('tap-target-comfortable');
    expect(pill!.className).toContain('overflow-visible');
  });
});
