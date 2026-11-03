// Text helpers for labels, tooltips and finding prose: path and callsite shortening, HTML escaping
// and the spill-ratio sentence. Pure and import-free, so the export bundle may reach it.

export function escHtml(str: unknown): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Reduces an embedded HDFS/S3/absolute-path fragment to its basename (e.g. "... hdfs://host/a/b/c"
// -> "c"). Strings with no such fragment pass through unchanged; NOT a general truncator.
export function pathBasename(str: unknown): string {
  const s = String(str);
  const m = s.match(/((?:hdfs?|s3[an]?):\/\/\S+|\/[^\s,)]+)/i);
  if (!m) return s;
  const segs = m[1].replace(/[/,]+$/, '').split('/').filter(Boolean);
  return segs[segs.length - 1] || s;
}

// "collect at /u02/.../utils.py:1869" -> "collect at utils.py:1869". Splits on the last " at "
// (Spark's callsite format), then reduces the location to its basename via pathBasename (whose
// match keeps a trailing ":<line>").
export function trimCallsite(callsite: string): string {
  const idx = callsite.lastIndexOf(' at ');
  if (idx === -1) return callsite;
  const operation = callsite.slice(0, idx);
  const location = callsite.slice(idx + 4);
  return `${operation} at ${pathBasename(location)}`;
}

/** `text` cut to at most `max` characters at its last whitespace, with `...` appended. The cut never
 * splits a token, so redaction run on the cut text still matches a whole host, IP or app id; text
 * with no whitespace to cut at is returned whole. */
export function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1).search(/\s\S*$/);
  return cut > 0 ? `${text.slice(0, cut).trimEnd()}...` : text;
}

/** The sentence for a spill finding's spill-to-input ratio. A high ratio means wide rows; on a scan
 * stage (`fromScan`) the input is compressed on disk, so it can come from that as well. */
export function describeSpillRatio(ratio: number, wide: boolean, fromScan: boolean, columns?: number): string {
  const width = columns !== undefined ? ` (${columns} columns)` : '';
  const reason = !wide ? '' : fromScan ? `, so the rows are wide${width} or the input files compress well, as Parquet does` : `, so the rows are wide${width}`;
  return `Memory spill is ${ratio}x the stage's input${reason}.`;
}
