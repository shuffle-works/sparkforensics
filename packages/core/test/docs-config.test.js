import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_DOC_ANCHORS, isKnownDocAnchor, docAnchorForType, tuningDocSlugForAnchor, docsUrl } from '../src/docs-config.js';
import { DETECTORS } from '../src/detectors.js';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const chaptersDir = resolve(root, 'packages/core/src/docs-content/chapters');
const tuningDir = resolve(root, 'packages/core/src/docs-content/tuning');
const navIndex = JSON.parse(readFileSync(resolve(chaptersDir, 'nav-index.json'), 'utf8'));
// Real ids: every manifest anchor plus every {#id} heading attr across the committed markdown.
const docIds = new Set(navIndex.map((e) => e.anchor));
for (const dir of [chaptersDir, tuningDir]) {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    for (const m of readFileSync(resolve(dir, f), 'utf8').matchAll(/\{#([a-z][a-z0-9-]+)\}/g)) docIds.add(m[1]);
  }
}

describe('KNOWN_DOC_ANCHORS', () => {
  // The allowlist must never claim an anchor the committed docs lack, or DocsLink surfaces a dead link.
  it('stays a subset of the real ids across the committed spark markdown', () => {
    const phantom = [...KNOWN_DOC_ANCHORS].filter((a) => !docIds.has(a.replace(/^#/, '')));
    expect(phantom).toEqual([]);
  });

  it('gates isKnownDocAnchor for documented and undocumented anchors', () => {
    expect(isKnownDocAnchor('#bottleneck-skew')).toBe(true);
    expect(isKnownDocAnchor('#bottleneck-memory-utilization')).toBe(true);
    expect(isKnownDocAnchor('#nonsense')).toBe(false);
  });

  // A detector declaring an anchor before its section exists fails here and is named,
  // rather than becoming a silent dead link.
  it('flags detector docAnchors that have no doc section yet', () => {
    const missing = [...new Set(DETECTORS.map((d) => d.docAnchor))]
      .filter((a) => a && !isKnownDocAnchor(a))
      .sort();
    expect(missing).toEqual([]);
  });
});

describe('docAnchorForType', () => {
  it('resolves a single-anchor type straight from its DETECTORS entry', () => {
    expect(docAnchorForType('skew')).toBe('#bottleneck-skew');
    expect(docAnchorForType('stageShape')).toBe('#bottleneck-stage-shape');
    expect(docAnchorForType('memoryUtilization')).toBe('#bottleneck-memory-utilization');
    expect(docAnchorForType('coreLocality')).toBe('#bottleneck-utilization');
    expect(docAnchorForType('jobFailureRate')).toBe('#bottleneck-job-failure-rate');
    expect(docAnchorForType('cacheUtilization')).toBe('#memory-model');
  });

  it('returns undefined for configAudit, whose four entries disagree on docAnchor', () => {
    expect(docAnchorForType('configAudit')).toBeUndefined();
  });

  it('maps underBroadcast/overBroadcast to the broadcastSizing entry anchor', () => {
    expect(docAnchorForType('underBroadcast')).toBe('#bottleneck-broadcast-sizing');
    expect(docAnchorForType('overBroadcast')).toBe('#bottleneck-broadcast-sizing');
  });

  it('returns undefined for a type with no DETECTORS entry at all', () => {
    expect(docAnchorForType('zetaSignal')).toBeUndefined();
  });
});

describe('docs-content/tuning/ vendored corpus', () => {
  // Drift guard: nothing else asserts the committed docs-content/tuning/ files stay
  // complete, and getFindingDocumentation degrades silently to null on a missing file.
  // Expected slugs derive from resolving every real '#bottleneck-*' anchor through
  // tuningDocSlugForAnchor, reusing its sub-anchor logic.
  const tuningDir = resolve(root, 'packages/core/src/docs-content/tuning');
  const expectedSlugs = [...new Set(
    [...KNOWN_DOC_ANCHORS]
      .filter((a) => a.startsWith('#bottleneck-'))
      .map((a) => tuningDocSlugForAnchor(a))
      .filter((slug) => slug !== null),
  )].sort();

  it('has at least one expected slug (sanity check the filter above isn\'t vacuous)', () => {
    expect(expectedSlugs.length).toBeGreaterThan(0);
  });

  it('has a non-empty committed .md file for every expected tuning-doc slug', () => {
    for (const slug of expectedSlugs) {
      const file = resolve(tuningDir, `${slug}.md`);
      expect(() => statSync(file), `missing ${file}`).not.toThrow();
      expect(statSync(file).size, `${file} is empty`).toBeGreaterThan(0);
    }
  });
});

describe('docsUrl', () => {
  it('resolves an anchor to its docs-site tuning-reference page', () => {
    expect(docsUrl('#bottleneck-skew')).toBe('docs/tuning-reference/bottleneck-skew.html#bottleneck-skew');
    expect(docsUrl('#metric-task-duration')).toBe('docs/tuning-reference/metrics.html#metric-task-duration');
  });
});

describe('tuningDocSlugForAnchor', () => {
  it('strips the bottleneck- prefix for a page-owning anchor', () => {
    expect(tuningDocSlugForAnchor('#bottleneck-skew')).toBe('skew');
    expect(tuningDocSlugForAnchor('#bottleneck-memory-utilization')).toBe('memory-utilization');
  });

  it('resolves a sub-anchor to its owning page slug, not its own name', () => {
    expect(tuningDocSlugForAnchor('#bottleneck-stage-shape')).toBe('skew');
    expect(tuningDocSlugForAnchor('#bottleneck-stage-slowness')).toBe('slow-host');
  });

  it('returns null for a non-bottleneck anchor', () => {
    expect(tuningDocSlugForAnchor('#memory-model')).toBeNull();
    expect(tuningDocSlugForAnchor('#config-serializer')).toBeNull();
  });
});
