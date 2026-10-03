import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { anchorsOf, checkDocAnchors, slugify } from '../scripts/check-doc-anchors.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
let tmp;
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

// Lays out a throwaway repo: `docs` maps docs-site-relative paths to markdown,
// `root` maps root-level files (AGENTS.md, ...) to markdown.
function fixture({ docs = {}, root = {} }) {
  tmp = mkdtempSync(join(tmpdir(), 'doc-anchors-'));
  for (const [rel, text] of Object.entries(docs)) {
    const file = join(tmp, 'docs-site', rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
  for (const [rel, text] of Object.entries(root)) writeFileSync(join(tmp, rel), text);
  return tmp;
}

describe('slugify / anchorsOf', () => {
  it('slugs headings like VitePress and honours explicit ids', () => {
    expect(slugify('Per-formula spot-checks')).toBe('per-formula-spot-checks');
    expect(slugify('Cross-finding rollup: `computeStageUnionMs`')).toBe('cross-finding-rollup-computestageunionms');
    const anchors = anchorsOf('# Title\n\n## Run it locally {#local-server-mode}\n\n```\n# not a heading\n```\n');
    expect([...anchors].sort()).toEqual(['local-server-mode', 'title']);
  });
});

describe('checkDocAnchors', () => {
  it('accepts a link to an existing heading in another page and in the same page', () => {
    const root = fixture({
      docs: {
        'a.md': '# A\n\nSee [b](./sub/b.md#second-part) and [here](#a).\n',
        'sub/b.md': '# B\n\n## Second part\n',
      },
    });
    expect(checkDocAnchors(root)).toEqual([]);
  });

  it('reports a missing heading and a missing page', () => {
    const root = fixture({
      docs: {
        'a.md': '# A\n\n[gone](./b.md#moved) and [nope](./c.md)\n',
        'b.md': '# B\n',
      },
    });
    expect(checkDocAnchors(root)).toEqual([
      'docs-site/a.md:3: no heading #moved in docs-site/b.md',
      'docs-site/a.md:3: no such page docs-site/c.md',
    ]);
  });

  it('checks root docs links into the docs site, in relative, published and blob form', () => {
    const root = fixture({
      docs: { 'guide.md': '# Guide\n\n## Real\n' },
      root: {
        'README.md': [
          '[ok](docs-site/guide.md#real)',
          '[bad](docs-site/guide.md#fake)',
          '[pub](https://shuffle-works.github.io/sparkforensics/docs/guide.html#fake2)',
          '[blob](https://github.com/shuffle-works/sparkforensics/blob/main/docs-site/guide.md#fake3)',
          '[elsewhere](src/other.md#nope)',
        ].join('\n'),
      },
    });
    expect(checkDocAnchors(root)).toEqual([
      'README.md:2: no heading #fake in docs-site/guide.md',
      'README.md:3: no heading #fake2 in docs-site/guide.md',
      'README.md:4: no heading #fake3 in docs-site/guide.md',
    ]);
  });

  it('passes on the real docs', () => {
    expect(checkDocAnchors(repoRoot)).toEqual([]);
  });
});
