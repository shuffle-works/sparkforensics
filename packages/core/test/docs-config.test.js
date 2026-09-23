import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_DOC_ANCHORS, isKnownDocAnchor, docAnchorForType, tuningDocSlugForAnchor, docsUrl, pageForAnchor, sharedDocAnchor } from '../src/docs-config.js';
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

  // docsUrl() links to pageForAnchor(anchor).html#anchor, so a sub-anchor missing from
  // pageForAnchor's map would point at a page that is never generated.
  it('resolves every detector docAnchor to a nav-index page whose markdown carries that anchor', () => {
    const navByAnchor = new Map(navIndex.map((e) => [e.anchor, e]));
    const unresolved = [...new Set(DETECTORS.map((d) => d.docAnchor))]
      .filter(Boolean)
      .map((a) => a.replace(/^#/, ''))
      .filter((a) => {
        const entry = navByAnchor.get(pageForAnchor(a));
        if (!entry) return true;
        const md = readFileSync(resolve(root, 'packages/core/src/docs-content', entry.store, `${entry.slug}.md`), 'utf8');
        return entry.anchor !== a && !md.includes(`{#${a}}`);
      })
      .sort();
    expect(unresolved).toEqual([]);
  });
});

describe('docAnchorForType', () => {
  it('resolves a single-anchor type straight from its DETECTORS entry', () => {
    expect(docAnchorForType('skew')).toBe('#bottleneck-skew');
    expect(docAnchorForType('stageShape')).toBe('#bottleneck-stage-shape');
    expect(docAnchorForType('memoryUtilization')).toBe('#bottleneck-memory-utilization');
    expect(docAnchorForType('coreLocality')).toBe('#bottleneck-core-locality');
    expect(docAnchorForType('jobFailureRate')).toBe('#bottleneck-job-failure-rate');
    expect(docAnchorForType('cacheUtilization')).toBe('#bottleneck-cache-utilization');
    expect(docAnchorForType('autoscalingChurn')).toBe('#bottleneck-autoscaling-churn');
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

  it('resolves a bottleneck sub-anchor to its owning bottleneck or chapter page', () => {
    expect(docsUrl('#bottleneck-partition-sizing')).toBe('docs/tuning-reference/bottleneck-shuffle.html#bottleneck-partition-sizing');
    expect(docsUrl('#bottleneck-speculation-waste')).toBe('docs/tuning-reference/bottleneck-straggler.html#bottleneck-speculation-waste');
    expect(docsUrl('#bottleneck-core-locality')).toBe('docs/tuning-reference/bottleneck-utilization.html#bottleneck-core-locality');
    expect(docsUrl('#bottleneck-caching-opportunity')).toBe('docs/tuning-reference/bottleneck-utilization.html#bottleneck-caching-opportunity');
    expect(docsUrl('#bottleneck-autoscaling-churn')).toBe('docs/tuning-reference/cluster-config.html#bottleneck-autoscaling-churn');
    expect(docsUrl('#bottleneck-cache-utilization')).toBe('docs/tuning-reference/memory-model.html#bottleneck-cache-utilization');
  });
});

describe('sharedDocAnchor', () => {
  it('returns the anchor every finding shares', () => {
    expect(sharedDocAnchor([{ docAnchor: '#config-serializer' }, { docAnchor: '#config-serializer' }])).toBe('#config-serializer');
  });

  it('returns undefined when findings disagree, any lacks one, or there are none', () => {
    expect(sharedDocAnchor([{ docAnchor: '#config-serializer' }, { docAnchor: '#config-memory-overhead' }])).toBeUndefined();
    expect(sharedDocAnchor([{ docAnchor: '#config-serializer' }, {}])).toBeUndefined();
    expect(sharedDocAnchor([])).toBeUndefined();
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
    expect(tuningDocSlugForAnchor('#bottleneck-partition-sizing')).toBe('shuffle');
    expect(tuningDocSlugForAnchor('#bottleneck-speculation-waste')).toBe('straggler');
    expect(tuningDocSlugForAnchor('#bottleneck-core-locality')).toBe('utilization');
    expect(tuningDocSlugForAnchor('#bottleneck-caching-opportunity')).toBe('utilization');
  });

  it('returns null for a non-bottleneck anchor', () => {
    expect(tuningDocSlugForAnchor('#memory-model')).toBeNull();
    expect(tuningDocSlugForAnchor('#config-serializer')).toBeNull();
  });

  it('returns null for a bottleneck sub-anchor hosted on a chapter page', () => {
    expect(tuningDocSlugForAnchor('#bottleneck-autoscaling-churn')).toBeNull();
    expect(tuningDocSlugForAnchor('#bottleneck-cache-utilization')).toBeNull();
  });
});
