import { describe, it, expect } from 'vitest';
import { injectHeadingAnchor, rewriteCrossLinks, rewriteDiagramPaths } from '../scripts/build-tuning-reference.mjs';

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
