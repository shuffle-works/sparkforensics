import { describe, it, expect } from 'vitest';
import { mdInline } from '../src/markdown-inline.ts';

describe('mdInline', () => {
  it('collapses every kind of line break into one space', () => {
    expect(mdInline('a\nb\r\nc d\n\n  e')).toBe('a b c d e');
  });

  it('escapes the characters that start a link, a tag or a table cell', () => {
    expect(mdInline('[x](https://x.example) <b>y</b> a|b')).toBe('\\[x\\](https://x.example) \\<b\\>y\\</b\\> a\\|b');
  });

  it('escapes a backslash first, so an escape in the text cannot cancel the one added', () => {
    expect(mdInline('a\\]b')).toBe('a\\\\\\]b');
  });

  it.each(['# title', '## title', '- item', '+ item', '* item', '> quote', '=== ', '~~~js', '```js', '___'])(
    'stops %j from opening a block at the start of a line', (text) => {
      expect(mdInline(text)).toMatch(/^\\/);
    },
  );

  it('stops an ordered-list marker from opening a list, and leaves a version number alone', () => {
    expect(mdInline('1. item')).toBe('1\\. item');
    expect(mdInline('3.4.0')).toBe('3.4.0');
  });

  it('leaves plain text, code spans and parentheses as written', () => {
    const text = 'Raise `spark.sql.shuffle.partitions` (default 200) to 800.';
    expect(mdInline(text)).toBe(text);
  });

  it('leaves the [redacted] placeholder alone unless a link target follows it', () => {
    expect(mdInline('Error: [redacted]')).toBe('Error: [redacted]');
    expect(mdInline('[redacted](https://x.example)')).toBe('\\[redacted\\](https://x.example)');
  });
});
