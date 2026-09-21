import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TYPE_TAG_MAP } from '../src/format-utils.js';

// Guards TYPE_TAG_MAP tags from drifting out of sync with CLAUDE.md's
// "Problem flagging" vocabulary. Reads the map directly so new tags are
// checked automatically.
describe('tag vocabulary doc coverage', () => {
  it('lists every TYPE_TAG_MAP tag value in CLAUDE.md\'s "Problem flagging" bullet', () => {
    // CLAUDE.md is a single repo-root doc, not per-package, so reach up three
    // levels to it.
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const claudeMd = readFileSync(path.join(rootDir, 'CLAUDE.md'), 'utf8');

    // Bounded by the next top-level bullet (a line starting with "- ").
    const bulletMatch = claudeMd.match(
      /^- Problem flagging:[\s\S]*?(?=\n- )/m
    );
    expect(bulletMatch).not.toBeNull();
    const bullet = bulletMatch[0];

    const tagValues = new Set(Object.values(TYPE_TAG_MAP));

    for (const tag of tagValues) {
      expect(bullet, `expected tag \`${tag}\` to be documented in CLAUDE.md's "Problem flagging" bullet`).toContain(`\`${tag}\``);
    }
  });
});
