import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import {
  injectHeadingAnchor,
  rewriteCrossLinks,
  rewriteDiagramPaths,
  renderPage,
  TITLE_TEMPLATE,
  REFERENCE_DESCRIPTION,
} from '../scripts/build-tuning-reference.mjs';
import { pageForAnchor, isKnownDocAnchor } from '../packages/core/src/docs-config.ts';

const root = resolve(import.meta.dirname, '..');
const docsContent = resolve(root, 'packages/core/src/docs-content');

// Splits a rendered page into its parsed YAML frontmatter and body.
function parsePage(page) {
  const m = /^---\n([\s\S]*?)\n---\n\n/.exec(page);
  if (!m) throw new Error('page has no frontmatter');
  return { front: loadYaml(m[1]), body: page.slice(m[0].length) };
}

// Mirrors the real pageForAnchor sub-anchor resolution for the test.
const resolvePage = (a) => {
  if (a.startsWith('metric-')) return 'metrics';
  if (a.startsWith('config-')) return 'config';
  return a;
};
// Mirrors isKnownDocAnchor: takes a '#'-prefixed anchor. Includes page anchors
// AND sub-anchors, exactly like KNOWN_DOC_ANCHORS.
const known = new Set(['#intro', '#joins', '#metrics', '#config', '#metric-task-duration', '#config-serializer']);
const isKnown = (a) => known.has(a);

describe('injectHeadingAnchor', () => {
  it('appends the anchor to a bare h1', () => {
    expect(injectHeadingAnchor('# Introduction\n\nbody', 'intro')).toBe('# Introduction {#intro}\n\nbody');
  });
  it('leaves an h1 that already has an attr alone', () => {
    expect(injectHeadingAnchor('# Metrics {#metrics}\n', 'metrics')).toBe('# Metrics {#metrics}\n');
  });
});

describe('rewriteCrossLinks', () => {
  it('rewrites a cross-page page anchor to a sibling page link', () => {
    expect(rewriteCrossLinks('see [joins](#joins)', 'intro', isKnown, resolvePage)).toBe('see [joins](./joins)');
  });
  it('rewrites a cross-page sub-anchor to its owning page plus fragment', () => {
    expect(rewriteCrossLinks('[m](#metric-task-duration)', 'intro', isKnown, resolvePage))
      .toBe('[m](./metrics#metric-task-duration)');
  });
  it('leaves a sub-anchor whose owning page is the current page as a fragment', () => {
    expect(rewriteCrossLinks('[m](#metric-task-duration)', 'metrics', isKnown, resolvePage))
      .toBe('[m](#metric-task-duration)');
  });
  it('leaves an unknown fragment (e.g. a footnote ref) untouched', () => {
    expect(rewriteCrossLinks('[f](#fn1)', 'intro', isKnown, resolvePage)).toBe('[f](#fn1)');
  });
});

describe('rewriteDiagramPaths', () => {
  it('adds the explicit ./ a chapter page\'s sibling reference needs', () => {
    expect(rewriteDiagramPaths('<img src="diagrams/driver-executor.svg">'))
      .toBe('<img src="./diagrams/driver-executor.svg">');
  });
  it('rewrites a bottleneck page\'s one-level-up reference to page-relative', () => {
    expect(rewriteDiagramPaths('<img src="../diagrams/cold-start-timeline.svg">'))
      .toBe('<img src="./diagrams/cold-start-timeline.svg">');
  });
  it('rewrites every occurrence, including a dark-mode srcset', () => {
    const md =
      '<source srcset="../diagrams/x.dark.svg" media="(prefers-color-scheme: dark)">\n' +
      '<img src="../diagrams/x.svg" alt="x">';
    expect(rewriteDiagramPaths(md)).toBe(
      '<source srcset="./diagrams/x.dark.svg" media="(prefers-color-scheme: dark)">\n' +
        '<img src="./diagrams/x.svg" alt="x">',
    );
  });
});

describe('renderPage frontmatter', () => {
  // The generated nav-index comes from the pinned upstream manifest (the
  // vitest globalSetup runs ensureTuningDocs first).
  const nav = JSON.parse(readFileSync(resolve(docsContent, 'chapters/nav-index.json'), 'utf8'));

  it('names the Spark Tuning Reference and uses the manifest brief as the description', () => {
    const entry = nav.find((e) => e.anchor === 'bottleneck-skew');
    const md = readFileSync(resolve(docsContent, entry.store, `${entry.slug}.md`), 'utf8');
    const { front, body } = parsePage(renderPage(entry, md, isKnownDocAnchor, pageForAnchor));
    expect(front.title).toBe(entry.title);
    expect(front.titleTemplate).toBe(':title | Spark Tuning Reference');
    expect(entry.brief).not.toBe('');
    expect(front.description).toBe(entry.brief);
    expect(body).toMatch(/^# .* \{#bottleneck-skew\}$/m);
  });

  it('gives every reference page its own non-empty description', () => {
    const descriptions = nav.map((e) => parsePage(renderPage(e, `# ${e.title}\n`, isKnownDocAnchor, pageForAnchor)).front.description);
    expect(descriptions.every((d) => d.length > 0)).toBe(true);
    expect(new Set(descriptions).size).toBe(nav.length);
  });

  it('survives quotes and colons in a brief, and falls back when the brief is missing', () => {
    const tricky = { anchor: 'x', title: 'A "quoted": title', brief: 'Brief: with "quotes".' };
    expect(parsePage(renderPage(tricky, '# X\n', () => false, (a) => a)).front)
      .toEqual({ title: tricky.title, titleTemplate: TITLE_TEMPLATE, description: tricky.brief });
    const bare = { anchor: 'x', title: 'X', brief: '' };
    expect(parsePage(renderPage(bare, '# X\n', () => false, (a) => a)).front.description).toBe(REFERENCE_DESCRIPTION);
  });

  it('keeps the landing page on the reference title and description', () => {
    const { front } = parsePage(readFileSync(resolve(root, 'docs-site/tuning-reference/index.md'), 'utf8'));
    expect(front.title).toBe('Spark Tuning Reference');
    expect(front.titleTemplate).toBe(false);
    expect(front.description).toBe(REFERENCE_DESCRIPTION);
  });
});
