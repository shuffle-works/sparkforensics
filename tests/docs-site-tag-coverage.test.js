import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TYPE_TAG_MAP, typeTag } from '@sparkforensics/core/format-utils.ts';
import { DETECTORS } from '@sparkforensics/core/detectors.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const page = readFileSync(
  resolve(root, 'docs-site/user-guide/understanding-findings.md'),
  'utf8',
);
const documentedTags = new Set(
  [...page.matchAll(/^### `([A-Z]+)`/gm)].map((m) => m[1]),
);
// tag -> explicit anchor id, e.g. 'SKEW' -> 'skew'. A heading with no
// trailing `{#id}` (or a malformed one) simply has no entry here.
const headingAnchors = new Map(
  [...page.matchAll(/^### `([A-Z]+)`.*\{#([a-z0-9-]+)\}\s*$/gm)].map((m) => [m[1], m[2]]),
);

const CURRENT_FINDING_TYPES = [...new Set(DETECTORS.map((d) => d.type))].flatMap((t) =>
  t === 'broadcastSizing' ? ['underBroadcast', 'overBroadcast'] : [t]
);

describe('understanding-findings.md tag coverage', () => {
  // Every tag TYPE_TAG_MAP can produce must have a `### \`TAG\`` heading in the
  // hand-authored page, or a new/renamed detector tag drifts out of the docs.
  it('documents every tag in TYPE_TAG_MAP', () => {
    const allTags = new Set(Object.values(TYPE_TAG_MAP));
    const missing = [...allTags].filter((tag) => !documentedTags.has(tag)).sort();
    expect(missing).toEqual([]);
  });

  // Anchor stability: findingGuideUrl() derives its URL fragment from
  // `typeTag(type).toLowerCase()`, not VitePress's heading auto-slug. A missing
  // or mismatched explicit id makes that link go dead on a heading reword.
  it('every documented tag heading carries an explicit {#tag} anchor id matching its lowercase tag', () => {
    const mismatched = [...documentedTags]
      .filter((tag) => headingAnchors.get(tag) !== tag.toLowerCase())
      .sort();
    expect(mismatched).toEqual([]);
  });

  // Regression guard: TYPE_TAG_MAP could diverge from the types DETECTORS
  // actually emits without the first two tests catching it (they only check
  // TYPE_TAG_MAP's internal consistency). Catches a new/renamed detector that
  // forgets to update TYPE_TAG_MAP and would ship a dead guide-link anchor.
  it('every currently-emitted detector type resolves to a documented tag', () => {
    const missing = CURRENT_FINDING_TYPES
      .map((type) => typeTag(type))
      .filter((tag) => !documentedTags.has(tag))
      .sort();
    expect(missing).toEqual([]);
  });
});
