// Escaping for text a log controls (app name, stage name, property key, failure message) before
// the Markdown report prints it. The report is pasted into PRs and tickets, where an app name
// holding a newline plus `# heading`, `[text](url)` or an HTML tag would otherwise add a heading,
// a live link or markup.
//
// The result is one line. It escapes the characters that start a link, an HTML tag or a table
// cell, and a marker that would make the text open a block when it starts a line. Backticks and
// parentheses stay as they are: the report's own prose uses code spans, and a link needs a
// bracket this escape already covers. A bare URL can still be auto-linked by the renderer.

const LINE_BREAKS = /\s*[\r\n\u2028\u2029]+\s*/g;
// The `[redacted]` placeholder (REDACTED_TEXT) is the one bracketed token left as written, unless
// a link target or reference follows it.
const INLINE_SPECIALS = /\[redacted\](?![([:])|[\\[\]<>|]/g;
// Block openers: ATX heading, list item, quote, setext underline, thematic break, code fence.
const LEADING_BLOCK_MARKER = /^(?:[#+*_=~-]|`{3})/;
const LEADING_ORDERED_ITEM = /^(\d+)([.)])(?=\s|$)/;

export function mdInline(text: string): string {
  const escaped = text.replace(LINE_BREAKS, ' ').trim().replace(INLINE_SPECIALS, (m) => (m === '[redacted]' ? m : `\\${m}`));
  if (LEADING_BLOCK_MARKER.test(escaped)) return `\\${escaped}`;
  return escaped.replace(LEADING_ORDERED_ITEM, '$1\\$2');
}
