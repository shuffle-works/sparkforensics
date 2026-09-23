import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { bumpChangeset, compareUrl, normalizeEol, parsePin } from '../scripts/fetch-tuning-docs.mjs';

const REPO = 'https://github.com/shuffle-works/spark-tuning-reference.git';
const A = '0574da5300c7c4ecb4da71298e85608d2fc20b71';
const B = '1d0f90dce8c0e04ad0ee6f1f724ae28d821b42cd';

describe('parsePin', () => {
  it('accepts an https git URL and a full SHA', () => {
    expect(parsePin({ repository: REPO, commit: B })).toEqual({ repository: REPO, commit: B });
  });

  it.each([
    ['a short SHA', { repository: REPO, commit: '1d0f90d' }],
    ['a branch name', { repository: REPO, commit: 'master' }],
    ['an uppercase SHA', { repository: REPO, commit: B.toUpperCase() }],
    ['an ssh URL', { repository: 'git@github.com:shuffle-works/spark-tuning-reference.git', commit: B }],
    ['a missing repository', { commit: B }],
    ['a non-object', null],
  ])('rejects %s', (_label, pin) => {
    expect(() => parsePin(pin)).toThrow(/upstream\.json/);
  });

  it('accepts the committed pin', () => {
    const pin = JSON.parse(readFileSync(new URL('../packages/core/src/docs-content/upstream.json', import.meta.url), 'utf8'));
    expect(() => parsePin(pin)).not.toThrow();
  });
});

describe('normalizeEol', () => {
  it('turns CRLF into LF and leaves lone CR and LF alone', () => {
    expect(normalizeEol('a\r\nb\nc\rd\r\n')).toBe('a\nb\nc\rd\n');
  });
});

describe('bump output', () => {
  it('links the upstream compare view from the old pin to the new one', () => {
    expect(compareUrl(REPO, A, B)).toBe(`https://github.com/shuffle-works/spark-tuning-reference/compare/${A}...${B}`);
  });

  it('writes a patch changeset for every published package', () => {
    const text = bumpChangeset(REPO, A, B);
    expect(text).toMatch(/^---\n"sparkforensics": patch\n"sparkforensics-cli": patch\n"sparkforensics-mcp": patch\n"sparkforensics-server": patch\n---\n\n/);
    expect(text).toContain(`spark-tuning-reference@1d0f90d (${compareUrl(REPO, A, B)})`);
  });
});
